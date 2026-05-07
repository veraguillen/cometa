"""
src/functions/ingest_trigger.py
────────────────────────────────
Cloud Function (Gen 2) — disparada por finalize_object en el bucket GCS raw/.

Flujo completo:
  1. Recibe evento GCS con el URI del archivo subido.
  2. Descarga el archivo desde GCS.
  3. Llama a DocumentAI (batch para PDFs grandes, sync para pequeños).
  4. Extrae KPIs con kpi_mapper → MappingResult.
  5. Aplica física financiera con validate_financial_physics.
  6. Inserta en fact_kpi_staging con status='PENDING'.
  7. Los datos NO son visibles para el RAG hasta que un analista los valide.

Deploy:
  gcloud functions deploy ingest-kpi-trigger \\
    --gen2 \\
    --runtime=python311 \\
    --region=us-central1 \\
    --source=src/functions \\
    --entry-point=handle_gcs_trigger \\
    --trigger-event-filters="type=google.cloud.storage.object.v1.finalized" \\
    --trigger-event-filters="bucket=cometa-vc-raw-prod" \\
    --set-env-vars="GOOGLE_CLOUD_PROJECT=cometa-mvp,BIGQUERY_DATASET=BD_Cometa_Dev" \\
    --service-account=cometa-pipeline-sa@cometa-mvp.iam.gserviceaccount.com

Nota: esta función debe estar en su propio directorio con requirements.txt propio.
El requirements.txt debe incluir las mismas dependencias que el backend principal.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import date, datetime, timezone
from typing import Any

log = logging.getLogger(__name__)

# ── Variables de entorno requeridas ──────────────────────────────────────────
_PROJECT_ID  = os.environ["GOOGLE_CLOUD_PROJECT"]
_DATASET     = os.getenv("BIGQUERY_DATASET", "BD_Cometa_Dev")
_PROCESSOR_ID = os.environ.get("DOCUMENT_AI_PROCESSOR_ID", "")
_DOC_AI_LOCATION = os.getenv("DOCUMENT_AI_LOCATION", "us")

# ── Constantes de ruta del bucket ─────────────────────────────────────────────
# El bucket raw/ tiene estructura: raw/{company_slug}/{year}/{month}/{hash}_{filename}
# El slug de la empresa se extrae del path para resolver company_id en BQ.
_RAW_PREFIX = "raw/"


def handle_gcs_trigger(cloud_event: Any) -> None:
    """
    Entry point de la Cloud Function.

    Recibe un CloudEvent de GCS (finalize_object) y ejecuta el pipeline
    de ingesta completo: extracción → validación → staging.

    Args:
        cloud_event: CloudEvent con data.bucket y data.name (path del objeto).
    """
    data = cloud_event.data
    bucket_name: str = data["bucket"]
    object_name: str = data["name"]   # ej: raw/simetrik/2026/01/abc123_reporte.pdf

    log.info("[ingest_trigger] Evento recibido: gs://%s/%s", bucket_name, object_name)

    # Solo procesar archivos en la capa raw/
    if not object_name.startswith(_RAW_PREFIX):
        log.info("[ingest_trigger] Ignorado (no es capa raw/): %s", object_name)
        return

    # Extraer company_slug del path: raw/{slug}/...
    parts = object_name.split("/")
    if len(parts) < 4:
        log.warning("[ingest_trigger] Path inesperado, no se puede extraer slug: %s", object_name)
        return

    company_slug = parts[1]                      # ej: "simetrik"
    year_str     = parts[2] if len(parts) > 2 else str(datetime.now().year)
    month_str    = parts[3] if len(parts) > 3 else "01"
    gcs_uri      = f"gs://{bucket_name}/{object_name}"

    try:
        period_start = date(int(year_str), int(month_str), 1)
    except ValueError:
        log.error("[ingest_trigger] No se pudo parsear fecha del path: %s", object_name)
        return

    # Generar ID de batch — vincula todos los KPIs de esta carga
    staging_id = str(uuid.uuid4())
    log.info(
        "[ingest_trigger] Iniciando pipeline — slug=%s staging_id=%s",
        company_slug, staging_id,
    )

    try:
        _run_ingestion_pipeline(
            gcs_uri      = gcs_uri,
            bucket_name  = bucket_name,
            object_name  = object_name,
            company_slug = company_slug,
            period_start = period_start,
            staging_id   = staging_id,
        )
    except Exception as exc:
        # No re-raise: Cloud Functions reintenta en fallo, lo que causaría
        # duplicados en staging. Loguear el error es suficiente — el analista
        # verá que el batch no apareció en la cola y puede re-subir el archivo.
        log.error(
            "[ingest_trigger] Pipeline falló para %s (staging_id=%s): %s",
            gcs_uri, staging_id, exc,
            exc_info=True,
        )


def _run_ingestion_pipeline(
    *,
    gcs_uri:      str,
    bucket_name:  str,
    object_name:  str,
    company_slug: str,
    period_start: date,
    staging_id:   str,
) -> None:
    """
    Pipeline completo de ingesta. Lanzado desde handle_gcs_trigger.

    Separado del entry point para facilitar testing unitario.
    """
    from google.cloud import storage as gcs

    from src.core.bq_data_service import BQDataService, CompanyNotFoundError
    from src.core.kpi_mapper import map_document_text
    from src.core.vc_validator import validate_financial_physics
    from src.adapters.document_ai import DocumentAIAdapter

    bq = BQDataService()

    # ── 1. Resolver company_id desde BQ ──────────────────────────────────────
    # El slug del path de GCS se usa para buscar la empresa en dim_company.
    # Si no existe, abortar — no queremos datos huérfanos en staging.
    try:
        company_meta = bq.get_company_metadata(company_slug)
        company_id   = company_meta["company_id"]
        log.info("[ingest_trigger] Empresa resuelta: %s → %s", company_slug, company_id)
    except CompanyNotFoundError:
        log.error(
            "[ingest_trigger] Empresa '%s' no encontrada en dim_company — abortando.",
            company_slug,
        )
        return

    # ── 2. Descargar archivo de GCS para Document AI síncrono ────────────────
    # Para archivos grandes (>5MB), Document AI usará el URI de GCS directamente
    # en modo batch. Para pequeños, descargamos el contenido en memoria.
    storage_client = gcs.Client()
    bucket  = storage_client.bucket(bucket_name)
    blob    = bucket.blob(object_name)
    file_bytes = blob.download_as_bytes()

    log.info(
        "[ingest_trigger] Archivo descargado: %s (%.1f KB)",
        object_name, len(file_bytes) / 1024,
    )

    # ── 3. Extraer texto con Document AI ─────────────────────────────────────
    doc_ai_text = _extract_with_document_ai(
        file_bytes  = file_bytes,
        gcs_uri     = gcs_uri,
        object_name = object_name,
    )

    if not doc_ai_text or not doc_ai_text.strip():
        log.warning(
            "[ingest_trigger] Document AI no extrajo texto de %s — abortando.", gcs_uri
        )
        return

    # ── 4. Mapear KPIs con kpi_mapper ─────────────────────────────────────────
    # map_document_text retorna un MappingResult con los KPIs encontrados.
    try:
        mapping_result = map_document_text(
            text         = doc_ai_text,
            company_slug = company_slug,
            period       = period_start,
        )
        log.info(
            "[ingest_trigger] Mapper: %d KPIs encontrados, %d faltantes, can_submit=%s",
            len(mapping_result.found),
            len(mapping_result.missing_kpis),
            mapping_result.can_submit,
        )
    except Exception as exc:
        log.error("[ingest_trigger] kpi_mapper falló: %s", exc, exc_info=True)
        raise

    # ── 5. Validación de física financiera ────────────────────────────────────
    # validate_financial_physics aplica las reglas VIO-C01…C05.
    # Los resultados se guardan en staging — NO bloquean la inserción.
    # El analista verá las violaciones en el panel de revisión.
    physics_ok    = True
    physics_notes = None

    if mapping_result.found:
        from src.schemas import UnifiedKPIContract, UnifiedKPIMetric
        contract = UnifiedKPIContract(
            company_id = company_id,
            period_id  = period_start.strftime("P%YQ%qM%m"),
            metrics    = [
                UnifiedKPIMetric(
                    metric_id = kpi.metric_id,
                    value     = kpi.numeric_value,
                    period_id = period_start.strftime("P%YQ%qM%m"),
                    source    = "document_ai",
                )
                for kpi in mapping_result.found
                if kpi.numeric_value is not None
            ],
        )
        if contract.metrics:
            physics_result = validate_financial_physics(contract)
            physics_ok     = not physics_result["has_physics_violations"]
            if physics_result["violations"]:
                physics_notes = json.dumps(
                    physics_result["violations"], ensure_ascii=False
                )
                log.warning(
                    "[ingest_trigger] Violaciones de física: %s",
                    physics_result["violations"],
                )

    # ── 6. Insertar en fact_kpi_staging (status='PENDING') ───────────────────
    # A partir de aquí, el analista es el único que puede promover estos datos
    # a fact_kpi_values para que el RAG los vea.
    kpi_rows = [
        {"metric_id": kpi.metric_id, "value": kpi.numeric_value}
        for kpi in mapping_result.found
        if kpi.numeric_value is not None
    ]

    # Derivar period_id canónico
    period_id = _build_period_id(period_start)

    result = bq.insert_to_staging(
        staging_id    = staging_id,
        company_id    = company_id,
        period_id     = period_id,
        period_start  = period_start,
        submitted_by  = f"gcs_trigger:{object_name}",
        source_file   = gcs_uri,
        kpi_rows      = kpi_rows,
        physics_ok    = physics_ok,
        physics_notes = physics_notes,
    )

    log.info(
        "[ingest_trigger] Staging completado: staging_id=%s rows=%d physics_ok=%s",
        staging_id, result["rows_inserted"], physics_ok,
    )


def _extract_with_document_ai(
    *,
    file_bytes:  bytes,
    gcs_uri:     str,
    object_name: str,
) -> str:
    """
    Llama a Document AI síncrono o batch según el tamaño del archivo.

    Para archivos <5 MB usa ProcessRequest (síncrono, más rápido).
    Para archivos >=5 MB usa BatchProcessRequest (asíncrono, 30 min timeout).

    Returns el texto extraído de tablas, o "" si falla.
    """
    if not _PROCESSOR_ID:
        log.error("[ingest_trigger] DOCUMENT_AI_PROCESSOR_ID no configurado — saltando extracción.")
        return ""

    from src.adapters.document_ai import DocumentAIAdapter

    adapter = DocumentAIAdapter(
        project_id    = _PROJECT_ID,
        location      = _DOC_AI_LOCATION,
        processor_id  = _PROCESSOR_ID,
    )

    is_large = len(file_bytes) >= 5 * 1024 * 1024

    if is_large:
        # Para archivos grandes: usar URI de GCS directamente
        gcs_output_uri = gcs_uri.rsplit("/", 1)[0] + "/docai_output/"
        log.info("[ingest_trigger] Archivo grande — usando batch processing.")
        return adapter.extraer_tablas_batch(gcs_uri, gcs_output_uri)
    else:
        # Para archivos pequeños: escribir temp y usar método síncrono
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name
        try:
            return adapter._process_sync(tmp_path)
        finally:
            import os as _os
            _os.unlink(tmp_path)


def _build_period_id(period_start: date) -> str:
    """
    Construye el period_id canónico a partir de una fecha.

    Formato: P{year}Q{quarter}M{month:02d}
    Ejemplo: date(2026, 3, 1) → "P2026Q1M03"
    """
    quarter = (period_start.month - 1) // 3 + 1
    return f"P{period_start.year}Q{quarter}M{period_start.month:02d}"
