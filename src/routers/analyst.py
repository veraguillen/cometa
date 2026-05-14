"""
src/routers/analyst.py — Router de Analista (validación Human-in-the-Loop).

Rutas incluidas:
  GET   /api/analyst/staging/pending            — cola de KPIs pendientes de revisión
  POST  /api/analyst/staging/validate           — aprobar o rechazar un batch de staging
  GET   /api/analyst/staging/{staging_id}       — detalle de un batch específico
  GET   /api/analyst/submissions                — lista de submissions con display_name
  GET   /api/analyst/submissions/{id}           — detalle: metadatos + KPIs + URL de descarga
  PATCH /api/analyst/submissions/{id}/kpis      — corregir KPIs y/o aprobar submission

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
        """
        Extrae el nombre legible del archivo desde su URI de GCS eliminando prefijos
        de sistema. Maneja los dos formatos activos:

        Nuevo (process-document): gs://bucket/{company_id}/{year}/RAW{18d}_{name}
        Viejo (medallion legacy):  gs://bucket/raw/{slug}/{Y}/{M}/{hash16}_{name}
        """
        if not gcs_path:
            return ""
        import re as _re
        raw = gcs_path.rstrip("/").split("/")[-1]
        # Nuevo formato: RAW + 18 dígitos + _
        cleaned = _re.sub(r"^RAW\d{18}_", "", raw)
        # Fallback: hash hexadecimal de 16 chars (uploads medallion legacy)
        if cleaned == raw:
            cleaned = _re.sub(r"^[a-f0-9]{16}_", "", raw)
        return cleaned

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
            # Usar display_name de BQ si está disponible; si no, derivar desde la URI
            bq_display   = (row.get("display_name") or "").strip()
            filename_val = bq_display if bq_display else _extract_filename(gcs_path)
            batches[sid] = {
                "staging_id":        sid,
                "company_id":        company_id_,
                "company_name":      catalog_map.get(company_id_, ""),
                "submitted_by":      row["submitted_by"],
                "submitted_at":      str(row["submitted_at"]) if row.get("submitted_at") else None,
                "physics_ok":        row.get("physics_ok", True),
                "physics_notes":     row.get("physics_notes"),
                "source_file":       gcs_path or None,
                "filename":          filename_val,
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


# ══════════════════════════════════════════════════════════════════════════════
# SUBMISSIONS — Vista de comparación Archivo Original ↔ KPIs Extraídos
# ══════════════════════════════════════════════════════════════════════════════


# ── Schemas ───────────────────────────────────────────────────────────────────

class SubmissionKpiRow(BaseModel):
    metric_id:               str
    value:                   Optional[float] = None
    period_id:               str             = ""
    period_start:            str             = ""
    notes:                   str             = ""
    metric_name:             str             = ""   # nombre legible desde dim_metric
    unit:                    str             = ""
    vertical:                str             = ""
    ai_extracted_value:      Optional[float] = None  # snapshot de Gemini — inmutable
    manual_correction_value: Optional[float] = None  # corrección del analista (o None)


class KpiCorrection(BaseModel):
    metric_id:    str   = Field(..., description="ID canónico de la métrica")
    period_id:    str   = Field(..., description="ej. P2025Q1M04")
    period_start: str   = Field(..., description="YYYY-MM-DD — filtro de partición BQ")
    value:        float = Field(..., description="Valor corregido por el analista")


class PatchKpisRequest(BaseModel):
    corrections: list[KpiCorrection] = Field(
        ..., description="Lista de métricas corregidas. Solo las que cambiaron."
    )
    approve: bool = Field(
        True,
        description="Si True (default), marca la submission como VALIDATED tras aplicar correcciones.",
    )

    model_config = {"str_strip_whitespace": True}


class PatchKpisResponse(BaseModel):
    submission_id:       str
    corrections_applied: int
    status:              str


class SubmissionListItem(BaseModel):
    submission_id: str
    company_id:    str
    status:        str
    created_at:    str
    display_name:  str = ""   # nombre legible del archivo; vacío en registros antiguos
    source_file:   str = ""


class SubmissionDetail(SubmissionListItem):
    """Detalle completo: metadatos + URL de descarga segura + KPIs extraídos."""
    download_url:        Optional[str] = None   # Signed URL GCS (1 hora)
    download_expires_in: int           = 0      # segundos hasta expiración
    kpi_count:           int           = 0
    kpis:                list[SubmissionKpiRow] = []


class SubmissionListResponse(BaseModel):
    submissions: list[SubmissionListItem]
    total:       int = 0


# ── Helper: generar Signed URL desde una URI gs:// ────────────────────────────

def _signed_url_from_gcs_uri(gcs_uri: str, expiration_hours: int = 1) -> tuple[str, int]:
    """
    Genera una Signed URL (GET, v4) para un objeto GCS.

    Args:
        gcs_uri:          URI completa gs://bucket/path/to/object.
        expiration_hours: Tiempo de vida en horas (default 1).

    Returns:
        (signed_url, expires_in_seconds) o ("", 0) si gcs_uri no es gs://.

    Non-fatal: cualquier error de firma devuelve ("", 0).
    """
    if not gcs_uri.startswith("gs://"):
        return ("", 0)

    path_no_scheme = gcs_uri[5:]
    slash_pos = path_no_scheme.find("/")
    if slash_pos == -1:
        return ("", 0)

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
            expiration = timedelta(hours=expiration_hours),
            method     = "GET",
        )
        return (signed_url, expiration_hours * 3600)
    except Exception:
        return ("", 0)


# ── GET /api/analyst/submissions ──────────────────────────────────────────────

@router.get("/submissions", response_model=SubmissionListResponse)
async def list_analyst_submissions(
    company_id: Optional[str] = None,
    status:     Optional[str] = None,
    limit:      int           = 50,
    token:      dict          = Depends(require_analista),
) -> SubmissionListResponse:
    """
    Lista submissions recientes visibles para el analista.

    Cada ítem incluye el `display_name` (nombre real del archivo) cuando está
    disponible, para que la cola sea legible sin hashes ni rutas GCS.

    Query params:
        company_id: filtrar por empresa (opcional).
        status:     PENDING | VALIDATED | REJECTED (opcional).
        limit:      máximo de resultados (default 50, max 200).
    """
    limit = min(max(1, limit), 200)
    try:
        rows = _bq.list_submissions(
            company_id=company_id or None,
            status=status or None,
            limit=limit,
        )
    except BQInsertError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    items = [SubmissionListItem(**r) for r in rows]
    return SubmissionListResponse(submissions=items, total=len(items))


# ── GET /api/analyst/submissions/{submission_id} ──────────────────────────────

@router.get("/submissions/{submission_id}", response_model=SubmissionDetail)
async def get_submission_detail(
    submission_id: str,
    token:         dict = Depends(require_analista),
) -> SubmissionDetail:
    """
    Detalle completo de una submission para la vista de comparación del analista.

    Retorna en un solo request:
      • Metadatos del archivo: display_name, source_file, status, empresa, fecha.
      • download_url: Signed URL (GET, 1 hora) para descargar/visualizar el archivo
        original desde GCS. Vacío si el archivo no está en GCS (registros legacy).
      • kpis: lista de métricas extraídas por la IA vinculadas a este submission_id,
        con valor, metric_id y período.

    Esto permite al analista ver en una sola pantalla el archivo que subió el
    founder y los KPIs que la IA leyó, para verificar si la extracción fue correcta.
    """
    try:
        data = _bq.get_submission_with_kpis(submission_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except BQInsertError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Generar Signed URL para descarga segura del archivo original
    gcs_uri = data.get("source_file", "")
    download_url, expires_in = _signed_url_from_gcs_uri(gcs_uri)

    kpis = [
        SubmissionKpiRow(
            metric_id               = r.get("metric_id", ""),
            value                   = r.get("value"),
            period_id               = r.get("period_id", ""),
            period_start            = r.get("period_start", ""),
            notes                   = r.get("notes", ""),
            metric_name             = r.get("metric_name", r.get("metric_id", "")),
            unit                    = r.get("unit", ""),
            vertical                = r.get("vertical", ""),
            ai_extracted_value      = r.get("ai_extracted_value"),
            manual_correction_value = r.get("manual_correction_value"),
        )
        for r in data.get("kpis", [])
    ]

    return SubmissionDetail(
        submission_id        = data["submission_id"],
        company_id           = data["company_id"],
        status               = data["status"],
        created_at           = data.get("created_at", ""),
        display_name         = data.get("display_name", ""),
        source_file          = gcs_uri,
        download_url         = download_url or None,
        download_expires_in  = expires_in,
        kpi_count            = data.get("kpi_count", len(kpis)),
        kpis                 = kpis,
    )


# ── PATCH /api/analyst/submissions/{submission_id}/kpis ───────────────────────

@router.patch("/submissions/{submission_id}/kpis", response_model=PatchKpisResponse)
async def patch_submission_kpis(
    submission_id: str,
    body:          PatchKpisRequest,
    token:         dict = Depends(require_analista),
) -> PatchKpisResponse:
    """
    Aplica correcciones manuales a los KPIs de una submission y opcionalmente
    la marca como VALIDATED.

    Body (JSON):
        corrections: lista de { metric_id, period_id, period_start, value }
                     — solo los KPIs que cambiaron.
        approve:     si True (default), la submission pasa a status=VALIDATED
                     tras aplicar las correcciones.

    El email del analista se extrae del JWT para auditoría.
    Retorna el número de correcciones aplicadas y el status resultante.
    """
    approved_by: str = token.get("email") or token.get("sub", "unknown")

    corrections = [c.model_dump() for c in body.corrections]

    try:
        result = _bq.update_submission_kpis(
            submission_id = submission_id,
            corrections   = corrections,
            approved_by   = approved_by,
            approve        = body.approve,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except BQInsertError as exc:
        raise HTTPException(status_code=503, detail=f"Error al aplicar correcciones: {exc}")

    return PatchKpisResponse(**result)
