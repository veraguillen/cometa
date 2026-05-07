"""
src/routers/analyst.py — Router de Analista (validación Human-in-the-Loop).

Rutas incluidas:
  GET  /api/analyst/staging/pending        — cola de KPIs pendientes de revisión
  POST /api/analyst/staging/validate       — aprobar o rechazar un batch de staging
  GET  /api/analyst/staging/{staging_id}   — detalle de un batch específico

Regla de acceso:
  Todos los endpoints requieren JWT con role='ANALISTA' (prefijo ANA-).
  Un FOUNDER nunca puede validar sus propias cargas.

Garantía RAG:
  promote_staging_to_fact() es la ÚNICA puerta de entrada a fact_kpi_values.
  La vista v_rag_context_dev lee de fact_kpi_values → el chat solo ve datos
  que pasaron por esta función con action='VALIDATED'.
"""

from __future__ import annotations

import os
from datetime import timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from google.cloud import storage as _gcs_storage
from pydantic import BaseModel, Field

from src.core.bq_data_service import BQDataService, BQInsertError
from src.dependencies.auth import require_analyst_auth as require_analista

router = APIRouter(prefix="/api/analyst", tags=["analyst"])

_bq = BQDataService()


# ── Schemas de request/response ───────────────────────────────────────────────

class ValidateStagingRequest(BaseModel):
    staging_id:     str  = Field(..., description="UUID del batch a validar")
    action:         str  = Field(..., pattern="^(VALIDATED|REJECTED)$",
                                  description="'VALIDATED' para aprobar, 'REJECTED' para rechazar")
    rejection_note: Optional[str] = Field(
        None,
        description="Motivo del rechazo (requerido cuando action='REJECTED')",
    )

    model_config = {"str_strip_whitespace": True}


class ValidateStagingResponse(BaseModel):
    staging_id:    str
    action:        str
    rows_promoted: int
    validated_by:  str
    timestamp:     str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/staging/pending")
async def get_pending_staging(
    company_id: Optional[str] = None,
    limit:      int           = 100,
    token:      dict          = Depends(require_analista),
) -> dict[str, Any]:
    """
    Retorna la cola de KPIs pendientes de revisión humana.

    Agrupa los resultados por staging_id para que el analista pueda
    revisar y aprobar batches completos (una carga = un staging_id).

    Query params:
        company_id: Filtra por empresa (slug o ID, opcional).
        limit:      Máximo de filas a retornar (default 100).

    Returns:
        {
          "pending_count": int,
          "batches": [
            {
              "staging_id": str,
              "company_id": str,
              "submitted_by": str,
              "submitted_at": str,
              "kpi_count": int,
              "physics_ok": bool,
              "physics_notes": str | None,
              "rows": [...]
            }
          ]
        }
    """
    try:
        rows = _bq.get_staging_pending(company_id=company_id, limit=limit)
    except BQInsertError as exc:
        raise HTTPException(status_code=503, detail=f"Error al consultar staging: {exc}")

    # Catalog lookup: company_id → company_name (best-effort, no hard failure)
    catalog_map: dict[str, str] = {}
    try:
        catalog_map = {
            c["company_id"]: c.get("company_name", "")
            for c in _bq.get_portfolio_catalog()
        }
    except Exception:
        pass

    def _extract_filename(gcs_path: str) -> str:
        """Returns the last path component of a GCS URI."""
        return gcs_path.rstrip("/").split("/")[-1] if gcs_path else ""

    def _detect_mismatch(gcs_path: str, staging_company_id: str) -> bool:
        """
        Returns True when the folder name inside the GCS bucket differs from
        the company_id recorded in staging — signals that the AI may have
        assigned the upload to the wrong company.

        Expected GCS layout: gs://<bucket>/<company_id>/filename.ext
        """
        if not gcs_path.startswith("gs://"):
            return False
        parts = gcs_path[5:].split("/")  # ["bucket", "company_id", "file"]
        if len(parts) < 3:
            return False
        return parts[1] != staging_company_id

    # Agrupar por staging_id para el frontend
    batches: dict[str, dict] = {}
    for row in rows:
        sid = row["staging_id"]
        if sid not in batches:
            gcs_path     = row.get("source_file") or ""
            company_id_  = row["company_id"]
            batches[sid] = {
                "staging_id":        sid,
                "company_id":        company_id_,
                "company_name":      catalog_map.get(company_id_, ""),
                "submitted_by":      row["submitted_by"],
                "submitted_at":      str(row["submitted_at"]) if row.get("submitted_at") else None,
                "physics_ok":        row.get("physics_ok", True),
                "physics_notes":     row.get("physics_notes"),
                "source_file":       gcs_path or None,
                "filename":          _extract_filename(gcs_path),
                "company_mismatch":  _detect_mismatch(gcs_path, company_id_),
                "kpi_count":         0,
                "rows":              [],
            }
        batches[sid]["kpi_count"] += 1
        batches[sid]["rows"].append({
            "metric_id": row["metric_id"],
            "value":     row["value"],
            "period_id": row["period_id"],
        })

    return {
        "pending_count": len(batches),
        "batches":       list(batches.values()),
    }


@router.post("/staging/validate", response_model=ValidateStagingResponse)
async def validate_staging(
    body:  ValidateStagingRequest,
    token: dict = Depends(require_analista),
) -> ValidateStagingResponse:
    """
    Human-in-the-loop gate: aprueba o rechaza un batch de staging.

    - action='VALIDATED': promueve las filas a fact_kpi_values y las hace
      visibles para el RAG/Chat. Idempotente — un batch ya validado no
      se puede re-procesar.

    - action='REJECTED': marca el batch como rechazado. Los datos permanecen
      en staging solo para auditoría, nunca llegan al RAG.

    El email del analista se extrae del JWT — el body nunca puede
    falsificar la identidad del validador.
    """
    if body.action == "REJECTED" and not body.rejection_note:
        raise HTTPException(
            status_code=422,
            detail="rejection_note es obligatorio cuando action='REJECTED'.",
        )

    # La identidad del analista viene del JWT verificado — nunca del body
    validated_by: str = token.get("email") or token.get("sub", "unknown")

    try:
        result = _bq.promote_staging_to_fact(
            staging_id     = body.staging_id,
            validated_by   = validated_by,
            action         = body.action,
            rejection_note = body.rejection_note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except BQInsertError as exc:
        raise HTTPException(status_code=503, detail=f"Error al promover staging: {exc}")

    return ValidateStagingResponse(**result)


@router.get("/staging/raw-url")
async def get_staging_raw_url(
    staging_id: Optional[str] = Query(None, description="staging_id del batch (mutuamente exclusivo con gcs_uri)"),
    gcs_uri:    Optional[str] = Query(None, description="URI de GCS directa gs://bucket/path (alternativa a staging_id)"),
    token:      dict = Depends(require_analista),
) -> dict[str, Any]:
    """
    Genera una Signed URL (GET, 1 hora) para ver un archivo en GCS.

    Acepta DOS formas de identificar el archivo:
      • staging_id — busca source_file en fact_kpi_staging (flujo Mesa de Control).
      • gcs_uri    — firma directamente la URI proporcionada (flujo RawDataBrowser).

    Exactamente uno de los dos parámetros debe estar presente.
    """
    if not staging_id and not gcs_uri:
        raise HTTPException(
            status_code=422,
            detail="Se requiere staging_id o gcs_uri (al menos uno).",
        )

    source_file: str
    if gcs_uri:
        # ── Modo directo: firma la URI que llegó en el parámetro ──────────────
        source_file = gcs_uri
    else:
        # ── Modo staging: busca source_file en BQ ─────────────────────────────
        from google.cloud import bigquery as _bq_mod
        from src.core.bq_data_service import BQ_DATASET

        try:
            client  = _bq.get_bq_client()
            sql     = (
                f"SELECT source_file FROM `{BQ_DATASET}.fact_kpi_staging` "
                f"WHERE staging_id = @sid LIMIT 1"
            )
            job_cfg = _bq_mod.QueryJobConfig(query_parameters=[
                _bq_mod.ScalarQueryParameter("sid", "STRING", staging_id)
            ])
            result  = list(client.query(sql, job_config=job_cfg).result())
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Error al consultar staging: {exc}")

        if not result:
            raise HTTPException(
                status_code=404,
                detail=f"staging_id '{staging_id}' no encontrado.",
            )

        source_file = dict(result[0]).get("source_file") or ""
    if not source_file.startswith("gs://"):
        # Archivo local o path relativo — no se puede firmar, devolver tal cual
        return {"signed_url": source_file, "expires_in": 0, "filename": source_file.split("/")[-1]}

    # Parsear gs://bucket/blob/path
    path_no_scheme = source_file[5:]
    slash_pos = path_no_scheme.find("/")
    if slash_pos == -1:
        raise HTTPException(status_code=500, detail="GCS path inválido en source_file.")
    bucket_name = path_no_scheme[:slash_pos]
    blob_path   = path_no_scheme[slash_pos + 1:]

    try:
        sa_json = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
        if sa_json:
            import json as _json
            from google.oauth2 import service_account as _sa
            sa_info = _json.loads(sa_json)
            if isinstance(sa_info, str):
                sa_info = _json.loads(sa_info)
            creds  = _sa.Credentials.from_service_account_info(sa_info)
            client = _gcs_storage.Client(credentials=creds)
        else:
            client = _gcs_storage.Client()

        blob       = client.bucket(bucket_name).blob(blob_path)
        signed_url = blob.generate_signed_url(
            version    = "v4",
            expiration = timedelta(hours=1),
            method     = "GET",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Error generando URL firmada: {exc}",
        )

    return {
        "signed_url": signed_url,
        "expires_in": 3600,
        "filename":   blob_path.split("/")[-1],
        "gcs_path":   source_file,
    }


@router.get("/staging/{staging_id}")
async def get_staging_detail(
    staging_id: str,
    token:      dict = Depends(require_analista),
) -> dict[str, Any]:
    """
    Retorna el detalle completo de un staging_id (todos sus KPIs y metadata).

    Útil para que el analista inspeccione un batch antes de aprobar/rechazar.
    """
    try:
        rows = _bq.get_staging_pending(company_id=None, limit=500)
    except BQInsertError as exc:
        raise HTTPException(status_code=503, detail=f"Error al consultar staging: {exc}")

    batch_rows = [r for r in rows if r.get("staging_id") == staging_id]

    if not batch_rows:
        raise HTTPException(
            status_code=404,
            detail=f"staging_id '{staging_id}' no encontrado o no está en estado PENDING.",
        )

    first = batch_rows[0]
    return {
        "staging_id":    staging_id,
        "company_id":    first["company_id"],
        "period_id":     first.get("period_id"),
        "submitted_by":  first.get("submitted_by"),
        "submitted_at":  str(first["submitted_at"]) if first.get("submitted_at") else None,
        "source_file":   first.get("source_file"),
        "physics_ok":    first.get("physics_ok", True),
        "physics_notes": first.get("physics_notes"),
        "kpi_count":     len(batch_rows),
        "kpis": [
            {
                "metric_id": r["metric_id"],
                "value":     r["value"],
                "period_id": r.get("period_id"),
            }
            for r in batch_rows
        ],
    }
