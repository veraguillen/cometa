"""
Signed URL Service — Upload directo Frontend -> GCS raw layer.

Flujo:
  1. Frontend llama POST /api/upload/signed-url con {slug, periodo, doc_type, filename}
  2. Este servicio genera una URL firmada con 15 min de validez
  3. Frontend sube el archivo directamente a GCS usando PUT a esa URL
  4. Frontend llama POST /api/upload/confirm con {load_id, gcs_uri} para iniciar el pipeline

Ventajas frente al flujo actual:
  - El archivo nunca pasa por Cloud Run (reduce latencia y costos de red)
  - La SA solo necesita objectCreator en raw/ — nunca credentials en el browser
  - El frontend obtiene progreso real del upload (XHR progress events)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from google.cloud import storage
from google.oauth2 import service_account


# ── Configuracion ─────────────────────────────────────────────────────────────

_BUCKET_RAW   = os.getenv("BUCKET_RAW",   "cometa-vc-raw-prod")
_BUCKET_STAGE = os.getenv("BUCKET_STAGE", "cometa-vc-stage-prod")
_BUCKET_GOLD  = os.getenv("BUCKET_GOLD",  "cometa-vc-gold-prod")

_SIGNED_URL_EXPIRY_MINUTES = 15


# ── MIME types permitidos ─────────────────────────────────────────────────────
# Lista blanca estricta: solo documentos financieros validos.

_ALLOWED_MIME: dict[str, str] = {
    "pdf":  "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls":  "application/vnd.ms-excel",
    "csv":  "text/csv",
}


def _get_storage_client() -> storage.Client:
    """
    Retorna un cliente GCS autenticado.

    Prioridad:
      1. GCP_SERVICE_ACCOUNT_JSON  — Secret Manager / Cloud Run
      2. GOOGLE_APPLICATION_CREDENTIALS — archivo local
      3. ADC                        — Workload Identity (GKE/Cloud Run nativo)
    """
    project = os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")

    sa_json_str = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
    if sa_json_str:
        sa_info = json.loads(sa_json_str)
        if isinstance(sa_info, str):
            sa_info = json.loads(sa_info)
        creds = service_account.Credentials.from_service_account_info(
            sa_info,
            scopes=["https://www.googleapis.com/auth/devstorage.read_write"],
        )
        return storage.Client(project=project, credentials=creds)

    sa_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if sa_path and os.path.exists(sa_path):
        creds = service_account.Credentials.from_service_account_file(
            sa_path,
            scopes=["https://www.googleapis.com/auth/devstorage.read_write"],
        )
        return storage.Client(project=project, credentials=creds)

    return storage.Client(project=project)


def _sanitize_filename(filename: str) -> str:
    """Elimina caracteres inseguros del nombre de archivo."""
    return re.sub(r"[^\w.\-]", "_", filename)


def _build_blob_path(
    layer: Literal["raw", "stage", "gold"],
    slug: str,
    periodo: str,
    filename: str,
    load_id: str = "",
) -> str:
    """
    Construye la ruta GCS alineada con upload_medallion_layer() de kpi_dispatcher.py:
      raw/   {slug}/{year}/{month}/{sha256_16}_{safe_filename}
      stage/ {slug}/{year}/{month}/{load_id}_gemini.json
      gold/  {slug}/{year}/{month}/{load_id}_contract.json
    """
    year, month = periodo.split("-")
    safe_filename = _sanitize_filename(filename)
    id_prefix = hashlib.sha256(load_id.encode()).hexdigest()[:16]

    paths = {
        "raw":   f"raw/{slug}/{year}/{month}/{id_prefix}_{safe_filename}",
        "stage": f"stage/{slug}/{year}/{month}/{load_id}_gemini.json",
        "gold":  f"gold/{slug}/{year}/{month}/{load_id}_contract.json",
    }
    return paths[layer]


def generate_upload_signed_url(
    slug: str,
    periodo: str,
    doc_type: str,
    filename: str,
    content_type: str | None = None,
) -> dict:
    """
    Genera una Signed URL v4 para que el frontend suba un archivo directamente
    al bucket raw sin pasar por el servidor.

    Parameters
    ----------
    slug         : Company slug (ej. "simetrik") — validado como lowercase alnum.
    periodo      : Periodo del reporte en formato YYYY-MM (ej. "2025-03").
    doc_type     : Tipo de documento: "reporte" | "cap_table" | "balance" | "pl".
    filename     : Nombre original del archivo (ej. "Q1_2025_financials.pdf").
    content_type : MIME type explicito. Si None, se infiere de la extension.

    Returns
    -------
    {
        "load_id"     : str   — UUID del batch, pasar a /api/upload/confirm
        "signed_url"  : str   — URL firmada para PUT desde el frontend
        "gcs_path"    : str   — ruta gs://bucket/path del objeto destino
        "expires_at"  : str   — ISO timestamp de expiracion de la URL
        "content_type": str   — MIME type que el frontend debe incluir en el PUT
        "metadata"    : dict  — metadatos GCS adjuntados al objeto
    }

    Raises
    ------
    ValueError  — slug/periodo/filename invalidos o content_type no permitido.
    """
    # ── Validaciones de entrada ────────────────────────────────────────────────
    if not re.fullmatch(r"[a-z0-9\-]{2,64}", slug):
        raise ValueError(
            f"slug invalido: '{slug}'. Solo minusculas, numeros y guiones (2-64 chars)."
        )

    if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", periodo):
        raise ValueError(
            f"periodo invalido: '{periodo}'. Formato requerido: YYYY-MM (ej. 2025-03)."
        )

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    resolved_mime = content_type or _ALLOWED_MIME.get(ext)
    if resolved_mime not in _ALLOWED_MIME.values():
        raise ValueError(
            f"Tipo de archivo no permitido: .{ext} / {content_type}. "
            f"Permitidos: {list(_ALLOWED_MIME.keys())}"
        )

    # ── Construir metadatos del objeto GCS ─────────────────────────────────────
    load_id = str(uuid.uuid4())
    blob_path = _build_blob_path("raw", slug, periodo, filename, load_id)

    object_metadata = {
        "x-goog-meta-startup":  slug,
        "x-goog-meta-periodo":  periodo,
        "x-goog-meta-doc_type": doc_type,
        "x-goog-meta-load_id":  load_id,
        "x-goog-meta-filename": _sanitize_filename(filename),
    }

    # ── Generar Signed URL v4 ──────────────────────────────────────────────────
    client = _get_storage_client()
    bucket = client.bucket(_BUCKET_RAW)
    blob   = bucket.blob(blob_path)

    expiry = timedelta(minutes=_SIGNED_URL_EXPIRY_MINUTES)
    signed_url = blob.generate_signed_url(
        version="v4",
        expiration=expiry,
        method="PUT",
        content_type=resolved_mime,
        headers=object_metadata,
    )

    expires_at = (datetime.now(timezone.utc) + expiry).isoformat()

    return {
        "load_id":      load_id,
        "signed_url":   signed_url,
        "gcs_path":     f"gs://{_BUCKET_RAW}/{blob_path}",
        "expires_at":   expires_at,
        "content_type": resolved_mime,
        "metadata": {
            "startup":  slug,
            "periodo":  periodo,
            "doc_type": doc_type,
        },
    }
