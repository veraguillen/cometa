"""
kpi_dispatcher.py
-----------------
Puente de Ingesta: conecta MappingResult (kpi_mapper.py) con la tabla
`cometa_portfolio.fact_portfolio_history` de BigQuery -- el destino canonico
disenado por Jero.

Responsabilidades exclusivas de este modulo:
  1. Freno de Emergencia: bloquear envios con can_submit=False.
  2. Construir el payload atomico (28 columnas del schema de Jero).
  3. Calcular quality_score y source_type por cada fila.
  4. Ejecutar MERGE idempotente contra BQ (row_id como clave unica).
  5. Devolver DispatchResult con resumen de la carga.

Relaciones con otros modulos:
  kpi_mapper.py      -> genera MappingResult (puro, sin I/O)
  kpi_dispatcher.py  -> consume MappingResult, escribe en BQ (solo I/O aqui)

AISLAMIENTO DEL CABLE VIEJO:
  Este modulo NO importa ni llama a:
    - insert_contract()   -> escribe en cometa_vault.fact_kpi_values (tabla vieja)
    - build_contract()    -> pipeline Gemini, no alineado con 109 KPIs
    - DIM_METRIC          -> catalogo de 16 KPIs hardcodeado (obsoleto)
  Estas funciones siguen activas para el flujo PDF/Gemini pero no deben
  usarse para la ingesta de archivos de Founders con el nuevo motor.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional

from src.core.kpi_mapper import (
    ExtractedKpi,
    MappingResult,
    ValidationFlag,
    load_kpi_intelligence,
)

# -- BQ target -----------------------------------------------------------------
# Tabla canonica de produccion: cometa-mvp.BD_Cometa.fact_portfolio_kpis
# Sobreescribible via variables de entorno para pruebas.

_BQ_PROJECT = os.getenv("KPI_BQ_PROJECT", os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp"))
_BQ_DATASET = os.getenv("KPI_BQ_DATASET", os.getenv("GOOGLE_BIGQUERY_DATASET", os.getenv("BIGQUERY_DATASET", "BD_Cometa")))
_BQ_TABLE   = os.getenv("KPI_BQ_TABLE",   "fact_portfolio_kpis")


# -- Schema centralizado -------------------------------------------------------
# Espeja exactamente FACT_PORTFOLIO_KPI_SCHEMA de db_writer.py.
# Usado en el staging load job para que DATE/TIMESTAMP nunca se infieran como
# STRING. La tabla de produccion NUNCA recibe WRITE_TRUNCATE — solo MERGE.

def _build_fact_schema() -> list:
    """Retorna los SchemaField de fact_portfolio_kpis."""
    from google.cloud import bigquery  # noqa: PLC0415

    return [
        bigquery.SchemaField("date",              "DATE",      mode="REQUIRED"),
        bigquery.SchemaField("company_id",        "STRING",    mode="REQUIRED"),
        bigquery.SchemaField("vertical",          "STRING"),
        bigquery.SchemaField("kpi_key",           "STRING",    mode="REQUIRED"),
        bigquery.SchemaField("value",             "FLOAT64"),
        bigquery.SchemaField("unit_type",         "STRING"),
        bigquery.SchemaField("confidence_score",  "INTEGER"),
        bigquery.SchemaField("is_derived",        "BOOL"),
        bigquery.SchemaField("has_formula_error", "BOOL"),
        bigquery.SchemaField("burn_definition",   "STRING"),
        bigquery.SchemaField("arr_type",          "STRING"),
        bigquery.SchemaField("data_granularity",  "STRING"),
        bigquery.SchemaField("period_year",       "INTEGER"),
        bigquery.SchemaField("period_quarter",    "STRING"),
        bigquery.SchemaField("period_month",      "INTEGER"),
        bigquery.SchemaField("loaded_at",         "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("analyst_note",      "STRING"),
    ]


# Module-level cache: populated on first call to _ensure_fact_schema().
# Kept as None until google-cloud-bigquery is first imported successfully.
FACT_PORTFOLIO_HISTORY_SCHEMA: list | None = None


def _ensure_fact_schema() -> list:
    """Returns the module-level schema list, building it on first access."""
    global FACT_PORTFOLIO_HISTORY_SCHEMA
    if FACT_PORTFOLIO_HISTORY_SCHEMA is None:
        FACT_PORTFOLIO_HISTORY_SCHEMA = _build_fact_schema()
    return FACT_PORTFOLIO_HISTORY_SCHEMA


# -- Table-ensured guard -------------------------------------------------------
# After the first successful _ensure_table() call, subsequent calls are
# short-circuited to avoid redundant API round-trips per request.

_table_ensured: bool = False


# -- Quality score matrix ------------------------------------------------------
# Fuente: kpi_config_for_jero.json -> quality_score_mapping
# Prioridad de asignacion (mayor a menor):
#   1. physics_violation -> 0.0
#   2. flag_review       -> depende del source_type
#   3. source_type + given_or_silver

_QUALITY_SCORES: dict[str, float] = {
    "verified_given":  1.00,   # GOLD: extraido + sin flags + GIVEN
    "verified_silver": 0.95,   # SILVER: recalculado + sin flags
    "manual_rescue":   0.70,   # ingresado manualmente por el Founder
    "legacy":          0.60,   # datos del Excel historico (master_db)
    "partial":         0.40,   # extraido con match fuzzy o valor incompleto
    "error":           0.00,   # physics_violation o dato invalido
}


# -- Source type enum ----------------------------------------------------------
# Alineado con source_enum de kpi_config_for_jero.json

SourceType = str   # "verified" | "manual_rescue" | "recalculated" | "legacy"


# -- Exceptions ----------------------------------------------------------------

class SubmissionBlockedError(Exception):
    """
    Freno de Emergencia: se lanza cuando MappingResult.can_submit es False.

    El atributo `blocking_flags` contiene la lista de ValidationFlag que
    dispararon el bloqueo -- disponibles para logging y para el response 422.
    """

    def __init__(self, blocking_flags: list[ValidationFlag]) -> None:
        self.blocking_flags = blocking_flags
        missing = [f.message for f in blocking_flags if f.block_submission]
        super().__init__(
            f"Carga BLOQUEADA -- {len(missing)} KPI(s) innegociable(s) ausentes: "
            + " | ".join(missing)
        )


# -- Metadata para la carga ----------------------------------------------------

@dataclass
class IngestionMetadata:
    """
    Contexto de la carga que no proviene del archivo sino de la sesion/UI.

    Todos los campos son obligatorios para garantizar trazabilidad completa
    en `fact_portfolio_kpis`.
    """

    company_name:     str            # Nombre canonico, ej. "SIMETRIK" (UPPERCASE)
    company_slug:     str            # Slug, ej. "simetrik" — mapea a company_id en BQ
    period:           date           # Primer dia del mes reportado, ej. date(2025, 3, 1)
    founder_email:    str            # Email del Founder que subio el archivo
    sector:           str            # "ALL" | "SAAS_SUBSCRIPTION" | etc.
    loaded_by:        str            # Email del sistema/usuario que ejecuta la carga
    form_version:     str  = "v1.0.0"
    source_file_hint: Optional[str] = None  # "PL" | "BS" | "CF" | "UE" | "HC" | None
    confirmed_by:     Optional[str] = None  # Email del analista que aprueba la carga


# -- Output de la operacion ----------------------------------------------------

@dataclass
class DispatchResult:
    """Resumen de la operacion de carga hacia BigQuery."""

    load_id:          str
    rows_inserted:    int  = 0
    rows_skipped_dup: int  = 0   # row_id ya existia (idempotencia)
    rows_error:       int  = 0
    quality_summary:  dict = field(default_factory=dict)
    warnings:         list = field(default_factory=list)
    dry_run:          bool = False


# -- Row builder ---------------------------------------------------------------

def _physics_violated(kpi_ref: str, flags: list[ValidationFlag]) -> bool:
    """True si alguna flag TRI-001 o TRI-002 afecta a este KPI."""
    physics_rules = {"TRI-001", "TRI-002"}
    return any(f.rule_id in physics_rules and f.flag_review for f in flags)


def _flag_review(kpi_ref: str, flags: list[ValidationFlag]) -> bool:
    """True si alguna flag TRI activa afecta el dato (requiere revision)."""
    return any(f.flag_review for f in flags)


def _founder_alert(flags: list[ValidationFlag]) -> bool:
    """True si hay flags de consistencia (TRI-003/004/005) -- contactar Founder."""
    consistency_rules = {"TRI-003", "TRI-004", "TRI-005"}
    return any(f.rule_id in consistency_rules for f in flags)


def _compute_quality_score(
    kpi: ExtractedKpi,
    given_or_silver: str,
    flags: list[ValidationFlag],
) -> float:
    """
    Calcula quality_score segun la matriz del config de Jero.

    Regla de prioridad:
      1. physics_violation -> 0.0 (nunca llega a dashboards)
      2. source_type manual_rescue -> 0.70
      3. GIVEN sin flags -> 1.00; SILVER sin flags -> 0.95
      4. match fuzzy -> 0.40 (parcial)
    """
    if _physics_violated(kpi.kpi_ref, flags):
        return _QUALITY_SCORES["error"]
    if kpi.match_type == "fuzzy" and kpi.match_score < 0.92:
        return _QUALITY_SCORES["partial"]
    if given_or_silver == "SILVER":
        return _QUALITY_SCORES["verified_silver"]
    return _QUALITY_SCORES["verified_given"]


def _normalize_vertical(sector: str) -> str:
    """
    Convierte el sector del IngestionMetadata al vertical canonico de
    fact_portfolio_kpis: SAAS | LEND | ECOM | INSUR | PROPTECH | OTH.
    """
    s = sector.upper()
    if "SAAS" in s:         return "SAAS"
    if "LEND" in s or "FINTECH" in s: return "LEND"
    if "ECOM" in s or "MARKET" in s:  return "ECOM"
    if "INSUR" in s:        return "INSUR"
    if "PROP" in s:         return "PROPTECH"
    return "OTH"


def _map_unit_type(unit: Optional[str], brain_meta: dict) -> str:
    """
    Convierte la unidad detectada al unit_type canonico de fact_portfolio_kpis:
    'usd' | 'pct' | 'count' | 'months' | 'ratio'.
    """
    raw = (unit or brain_meta.get("unit", "")).lower()
    if "%" in raw:                        return "pct"
    if "$" in raw or "usd" in raw:        return "usd"
    if "month" in raw:                    return "months"
    if "ratio" in raw:                    return "ratio"
    return brain_meta.get("data_type", "count")


def _build_row(
    kpi: ExtractedKpi,
    metadata: IngestionMetadata,
    brain_meta: dict,
    load_id: str,
    flags: list[ValidationFlag],
    source_type: SourceType,
    submitted_at: datetime,
) -> dict[str, Any]:
    """
    Construye una fila para fact_portfolio_kpis.

    Clave de idempotencia del MERGE: (company_id, date, kpi_key).
    kpi_key usa siempre el slug en minusculas (ej. "revenue"), nunca el
    ref numerico ("KPI-001"), para compatibilidad con los datos historicos
    de Jero y con dim_kpi_metadata.
    """
    given_silver  = brain_meta.get("given_or_silver", "GIVEN")
    quality_score = _compute_quality_score(kpi, given_silver, flags)
    month         = metadata.period.month
    quarter       = f"Q{(month - 1) // 3 + 1}"

    # analyst_note: registra el email del analista aprobador si esta presente.
    analyst_note: Optional[str] = None
    if metadata.confirmed_by:
        analyst_note = f"approved_by:{metadata.confirmed_by}"

    return {
        "date":              metadata.period.isoformat(),        # "2025-03-01"
        "company_id":        metadata.company_slug.lower(),      # "simetrik"
        "vertical":          _normalize_vertical(metadata.sector),
        "kpi_key":           kpi.metric_id,                      # "revenue" (slug)
        "value":             kpi.numeric_value,
        "unit_type":         _map_unit_type(kpi.unit, brain_meta),
        "confidence_score":  round(quality_score * 100),         # 0-100 INTEGER
        "is_derived":        given_silver == "SILVER",
        "has_formula_error": _physics_violated(kpi.kpi_ref, flags),
        "burn_definition":   None,
        "arr_type":          None,
        "data_granularity":  "monthly",
        "period_year":       metadata.period.year,
        "period_quarter":    quarter,
        "period_month":      month,
        "loaded_at":         submitted_at.isoformat(),
        "analyst_note":      analyst_note,
    }


# -- Payload builder (publico, sin BQ) -----------------------------------------

def build_atomic_payload(
    result: MappingResult,
    metadata: IngestionMetadata,
    source_type: SourceType = "verified",
    load_id: str | None = None,
) -> tuple[list[dict], str]:
    """
    Convierte MappingResult en una lista de filas listas para BigQuery.

    No hace ningun I/O -- es puro y testeable en aislamiento.

    Parameters
    ----------
    result      : MappingResult del kpi_mapper.
    metadata    : Contexto de la carga (empresa, periodo, emails).
    source_type : "verified" | "manual_rescue" | "recalculated" | "legacy".
    load_id     : UUID del batch. Si None, se genera uno nuevo. Pasar el mismo
                  UUID en el flujo preview->confirm garantiza trazabilidad del
                  batch entre los dos pasos.

    Returns
    -------
    (rows, load_id)
      rows    : list[dict] -- una fila por KPI extraido.
      load_id : str        -- UUID del batch, para agrupar en BQ.
    """
    # Freno de Emergencia
    if not result.can_submit:
        raise SubmissionBlockedError(
            [f for f in result.validation_flags if f.block_submission]
        )

    batch_id     = load_id if load_id is not None else str(uuid.uuid4())
    submitted_at = datetime.now(timezone.utc)

    # Indice: metric_id -> dict del brain (para metadatos adicionales)
    intel       = load_kpi_intelligence()
    brain_index = {m["metric_id"]: m for m in intel.metrics}

    rows: list[dict] = []
    for kpi in result.found:
        if kpi.numeric_value is None:
            continue   # KPIs sin valor no se insertan -- quedan como MISSING en BQ
        brain_meta = brain_index.get(kpi.metric_id, {})
        row = _build_row(
            kpi          = kpi,
            metadata     = metadata,
            brain_meta   = brain_meta,
            load_id      = batch_id,
            flags        = result.validation_flags,
            source_type  = source_type,
            submitted_at = submitted_at,
        )
        rows.append(row)

    return rows, batch_id


# -- Preview builder (publico, sin BQ) -----------------------------------------

def build_upload_preview(
    result: MappingResult,
    metadata: IngestionMetadata,
) -> dict:
    """
    Construye el payload de preview para el modal de confirmacion del frontend.
    No escribe en BQ -- es puramente informativo.

    Llama a build_atomic_payload con logica dry_run: construye todas las filas
    pero no ejecuta ninguna operacion de I/O contra BigQuery.

    Returns a dict with:
      load_id              : str  -- UUID del batch (para pasarlo al confirm endpoint)
      can_submit           : bool
      found_kpis           : list -- [{kpi_id, display_name, value, unit,
                                       quality_score, flag_review, match_type,
                                       match_score}]
      missing_kpis         : list -- [{kpi_ref, display_name, innegociable,
                                       priority_tier}]
      innegociables_missing: list
      validation_flags     : list -- [{rule_id, severity, message, block_submission}]
      coverage_pct         : float
      quality_summary      : dict
    """
    # build_atomic_payload raises SubmissionBlockedError when can_submit=False.
    # For preview we want to surface that info rather than raise, so we check
    # directly and build a blocked response when needed.
    if not result.can_submit:
        blocking = [f for f in result.validation_flags if f.block_submission]
        return {
            "load_id":               str(uuid.uuid4()),
            "can_submit":            False,
            "found_kpis":            [],
            "missing_kpis":          [
                {
                    "kpi_ref":       m.kpi_ref if hasattr(m, "kpi_ref") else str(m),
                    "display_name":  getattr(m, "display_name", ""),
                    "innegociable":  getattr(m, "innegociable", False),
                    "priority_tier": getattr(m, "priority_tier", None),
                }
                for m in result.missing_kpis
            ],
            "innegociables_missing": [
                {
                    "kpi_ref":      m.get("kpi_ref", ""),
                    "display_name": m.get("display_name", ""),
                    "innegociable": m.get("innegociable", True),
                }
                for m in result.innegociables_missing
            ],
            "validation_flags": [
                {
                    "rule_id":         f.rule_id,
                    "severity":        f.severity,
                    "message":         f.message,
                    "block_submission": f.block_submission,
                }
                for f in result.validation_flags
            ],
            "coverage_pct":  result.coverage_pct,
            "quality_summary": {},
        }

    rows, load_id = build_atomic_payload(result, metadata)

    # Build found_kpis list from rows + original ExtractedKpi objects
    kpi_index: dict[str, ExtractedKpi] = {k.kpi_ref: k for k in result.found}
    found_kpis = []
    for row in rows:
        kpi_ref = row["metric_id"]
        src_kpi = kpi_index.get(kpi_ref)
        found_kpis.append({
            "kpi_id":        kpi_ref,
            "display_name":  row["metric_name"],
            "value":         row["value"],
            "unit":          row["unit"],
            "quality_score": row["quality_score"],
            "flag_review":   row["flag_review"],
            "match_type":    src_kpi.match_type if src_kpi else None,
            "match_score":   src_kpi.match_score if src_kpi else None,
        })

    missing_kpis = [
        {
            "kpi_ref":       m.kpi_ref if hasattr(m, "kpi_ref") else str(m),
            "display_name":  getattr(m, "display_name", ""),
            "innegociable":  getattr(m, "innegociable", False),
            "priority_tier": getattr(m, "priority_tier", None),
        }
        for m in result.missing_kpis
    ]

    innegociables_missing = [
        m["display_name"] or m["kpi_ref"]
        for m in missing_kpis
        if m["innegociable"]
    ]

    scores = [r["quality_score"] for r in rows] if rows else []
    quality_summary = {
        "total_rows":     len(rows),
        "avg_quality":    round(sum(scores) / len(scores), 3) if scores else 0.0,
        "gold_rows":      sum(1 for s in scores if s == 1.0),
        "silver_rows":    sum(1 for s in scores if s == 0.95),
        "partial_rows":   sum(1 for s in scores if s < 0.95),
        "physics_errors": sum(1 for r in rows if r["physics_violation"]),
        "flag_review":    sum(1 for r in rows if r["flag_review"]),
    }

    return {
        "load_id":               load_id,
        "can_submit":            result.can_submit,
        "found_kpis":            found_kpis,
        "missing_kpis":          missing_kpis,
        "innegociables_missing": innegociables_missing,
        "validation_flags": [
            {
                "rule_id":          f.rule_id,
                "severity":         f.severity,
                "message":          f.message,
                "block_submission": f.block_submission,
            }
            for f in result.validation_flags
        ],
        "coverage_pct":   result.coverage_pct,
        "quality_summary": quality_summary,
    }


# -- Cash consistency helper ---------------------------------------------------

def get_prev_cash_from_bq(
    company_slug: str,
    before_period: date,
) -> float | None:
    """
    Consulta `fact_portfolio_kpis` para obtener el ultimo valor de Cash
    (kpi_key='cash') de un periodo anterior a `before_period`.

    Util para TRI-003: Cash Consistency check en el mapper.

    Returns el valor float o None si no hay datos previos / BQ no disponible.
    """
    try:
        client = _get_bq_client()
        full_table_id = f"{_BQ_PROJECT}.{_BQ_DATASET}.{_BQ_TABLE}"
        from google.cloud.bigquery import QueryJobConfig, ScalarQueryParameter

        query = f"""
            SELECT value
            FROM `{full_table_id}`
            WHERE company_id = @company_id
              AND kpi_key    = 'cash'
              AND date       < @before_period
            ORDER BY date DESC
            LIMIT 1
        """
        config = QueryJobConfig(
            query_parameters=[
                ScalarQueryParameter("company_id",    "STRING", company_slug),
                ScalarQueryParameter("before_period", "DATE",   before_period.isoformat()),
            ]
        )
        rows = list(client.query(query, job_config=config).result())
        if rows:
            return float(rows[0]["value"])
        return None
    except Exception:  # noqa: BLE001 -- graceful degradation, never raise
        return None


# -- BQ writer -----------------------------------------------------------------

def _get_bq_client():
    """Retorna un cliente BigQuery autenticado."""
    try:
        from google.cloud import bigquery
        from google.oauth2 import service_account

        key_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if key_path and os.path.exists(key_path):
            creds = service_account.Credentials.from_service_account_file(
                key_path,
                scopes=["https://www.googleapis.com/auth/bigquery"],
            )
            return bigquery.Client(project=_BQ_PROJECT, credentials=creds)
        return bigquery.Client(project=_BQ_PROJECT)
    except ImportError:
        raise RuntimeError(
            "google-cloud-bigquery no instalado. "
            "Ejecuta: pip install google-cloud-bigquery"
        )


def _ensure_table(client: Any) -> None:
    """
    Verifica que fact_portfolio_history existe en BD_Cometa.
    El backend es un invitado — nunca crea ni modifica la tabla.
    El esquema lo gestiona el compañero dueño del Dashboard.
    """
    global _table_ensured

    if _table_ensured:
        return

    full_table_id = f"{_BQ_PROJECT}.{_BQ_DATASET}.{_BQ_TABLE}"
    try:
        client.get_table(full_table_id)
    except Exception:
        # Tabla no encontrada — los inserts fallarán con error claro si ocurre
        pass

    _table_ensured = True


def _merge_rows(client: Any, rows: list[dict]) -> tuple[int, int]:
    """
    Upsert de filas en fact_portfolio_kpis usando MERGE.

    Clave compuesta de idempotencia: (company_id, date, kpi_key).
    - MATCHED     → actualiza value, confidence_score, has_formula_error,
                    loaded_at y analyst_note.
    - NOT MATCHED → inserta la fila completa.

    WRITE_TRUNCATE se usa SOLO en la tabla temporal de staging (_staging_UUID),
    nunca en la tabla de produccion fact_portfolio_kpis.

    Returns (inserted_count, updated_count).
    """
    from google.cloud import bigquery

    if not rows:
        return 0, 0

    full_table_id = f"{_BQ_PROJECT}.{_BQ_DATASET}.{_BQ_TABLE}"

    # Tabla temporal con UUID completo (32 hex chars) para eliminar riesgo de
    # colision. El prefijo _ la hace invisible en la consola de BQ por defecto.
    # WRITE_TRUNCATE aqui es seguro: aplica a una tabla nueva y efimera.
    staging_id = f"{_BQ_PROJECT}.{_BQ_DATASET}._staging_{uuid.uuid4().hex}"
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        autodetect=True,
    )
    load_job = client.load_table_from_json(rows, staging_id, job_config=job_config)
    load_job.result()

    _cols = [
        "date", "company_id", "vertical", "kpi_key", "value", "unit_type",
        "confidence_score", "is_derived", "has_formula_error", "burn_definition",
        "arr_type", "data_granularity", "period_year", "period_quarter",
        "period_month", "loaded_at", "analyst_note",
    ]
    _col_list = ", ".join(_cols)
    _val_list = ", ".join(f"S.{c}" for c in _cols)

    # MERGE sobre fact_portfolio_kpis — clave compuesta (company_id, date, kpi_key).
    # Sin WHEN NOT MATCHED BY SOURCE: los datos historicos de Jero jamas se borran.
    merge_sql = f"""
    MERGE `{full_table_id}` T
    USING `{staging_id}` S
    ON  T.company_id = S.company_id
    AND T.date       = S.date
    AND T.kpi_key    = S.kpi_key
    WHEN MATCHED THEN
        UPDATE SET
            T.value             = S.value,
            T.confidence_score  = S.confidence_score,
            T.has_formula_error = S.has_formula_error,
            T.loaded_at         = S.loaded_at,
            T.analyst_note      = S.analyst_note
    WHEN NOT MATCHED THEN
        INSERT ({_col_list})
        VALUES ({_val_list})
    """
    merge_job = client.query(merge_sql)
    merge_job.result()

    # Limpiar tabla temporal (best-effort — BQ la expira sola si falla)
    try:
        client.delete_table(staging_id)
    except Exception:
        pass

    stats = merge_job.dml_stats
    return (
        getattr(stats, "inserted_row_count", 0),
        getattr(stats, "updated_row_count",  0),
    )


# -- Public API ----------------------------------------------------------------

def dispatch_to_storage(
    result: MappingResult,
    metadata: IngestionMetadata,
    source_type: SourceType = "verified",
    dry_run: bool = False,
    load_id: str | None = None,
) -> DispatchResult:
    """
    Funcion principal de ingesta. Toma un MappingResult validado y lo
    persiste en `cometa_portfolio.fact_portfolio_history`.

    Parameters
    ----------
    result      : MappingResult del kpi_mapper -- debe tener can_submit=True.
    metadata    : Contexto de la carga (empresa, periodo, etc.).
    source_type : "verified" | "manual_rescue" | "recalculated" | "legacy".
    dry_run     : Si True, construye el payload pero no escribe en BQ.
                  Util para preview en el frontend antes de confirmar.
    load_id     : UUID del batch. Si None, se genera uno nuevo. Pasar el mismo
                  UUID del paso de preview permite que confirm reutilice el
                  mismo batch_id en BQ, manteniendo trazabilidad completa.

    Returns
    -------
    DispatchResult con load_id, conteo de filas y quality_summary.

    Raises
    ------
    SubmissionBlockedError
        Si result.can_submit == False (BLK-001 activo -- innegociable ausente).
        El atributo .blocking_flags describe exactamente que falta.
    """
    # -- Freno de Emergencia ---------------------------------------------------
    if not result.can_submit:
        raise SubmissionBlockedError(
            [f for f in result.validation_flags if f.block_submission]
        )

    # -- Construir payload -----------------------------------------------------
    rows, batch_id = build_atomic_payload(result, metadata, source_type, load_id)

    if not rows:
        return DispatchResult(
            load_id=batch_id,
            warnings=["No se extrajeron KPIs con valor numerico -- nada que insertar."],
        )

    # -- Quality summary -------------------------------------------------------
    scores = [r["quality_score"] for r in rows]
    quality_summary = {
        "total_rows":     len(rows),
        "avg_quality":    round(sum(scores) / len(scores), 3),
        "gold_rows":      sum(1 for s in scores if s == 1.0),
        "silver_rows":    sum(1 for s in scores if s == 0.95),
        "partial_rows":   sum(1 for s in scores if s < 0.95),
        "physics_errors": sum(1 for r in rows if r["physics_violation"]),
        "flag_review":    sum(1 for r in rows if r["flag_review"]),
    }

    if dry_run:
        return DispatchResult(
            load_id=batch_id,
            rows_inserted=len(rows),
            quality_summary=quality_summary,
            dry_run=True,
        )

    # -- Escribir en BQ --------------------------------------------------------
    try:
        client = _get_bq_client()
        _ensure_table(client)
        inserted, updated = _merge_rows(client, rows)
    except Exception as exc:
        return DispatchResult(
            load_id=batch_id,
            rows_error=len(rows),
            quality_summary=quality_summary,
            warnings=[f"BQ write error: {exc}"],
        )

    return DispatchResult(
        load_id=batch_id,
        rows_inserted=inserted,
        rows_skipped_dup=updated,
        quality_summary=quality_summary,
    )


# ══════════════════════════════════════════════════════════════════════════════
# MEDALLION GCS LAYER — raw / stage / gold
# ══════════════════════════════════════════════════════════════════════════════
#
# Estructura de rutas en el bucket:
#   raw/   {slug}/{year}/{month}/{file_hash}_{original_filename}
#   stage/ {slug}/{year}/{month}/{load_id}_gemini.json
#   gold/  {slug}/{year}/{month}/{load_id}_contract.json
#
# La capa gold solo se genera cuando el gate se abre (109/109 KPIs OK).
# Todas las funciones son non-fatal: loguean y retornan "" en caso de error.
# ══════════════════════════════════════════════════════════════════════════════

import hashlib
import json as _json
import logging as _logging
import re as _re
from typing import Literal

_mlog = _logging.getLogger(__name__)

from src.core.buckets import RAW_BUCKET as _GCS_RAW_BUCKET, STAGE_BUCKET as _GCS_STAGE_BUCKET, GOLD_BUCKET as _GCS_GOLD_BUCKET


def _gcs_client():
    """Lazy import de google.cloud.storage para no penalizar importaciones en test."""
    from google.cloud import storage as _storage   # noqa: PLC0415
    return _storage.Client()


def upload_medallion_layer(
    layer:        Literal["raw", "stage", "gold"],
    content:      bytes,
    content_type: str,
    filename:     str,
    metadata:     IngestionMetadata,
    load_id:      str      = "",
    bucket_name:  str      = "",
) -> str:
    """
    Sube un artefacto al bucket GCS en la capa Medallion correspondiente.

    Parámetros
    ----------
    layer        : "raw" | "stage" | "gold"
    content      : Bytes del artefacto a guardar.
    content_type : MIME type (ej. "application/pdf", "application/json").
    filename     : Nombre original del archivo (usado solo en capa raw).
    metadata     : IngestionMetadata de la carga actual.
    load_id      : UUID del batch (usado en stage/gold para agrupar artefactos).
    bucket_name  : Bucket destino; por defecto MEDALLION_BUCKET env var.

    Retorna
    -------
    str — URI gs://bucket/path del objeto guardado, o "" si falló.

    Notas
    -----
    Non-fatal: nunca lanza excepción — el Founder UX no debe verse afectado
    por errores de almacenamiento de auditoría.
    """
    _layer_bucket = {"raw": _GCS_RAW_BUCKET, "stage": _GCS_STAGE_BUCKET, "gold": _GCS_GOLD_BUCKET}
    target_bucket = bucket_name or _layer_bucket[layer]
    year  = metadata.period.strftime("%Y")
    month = metadata.period.strftime("%m")
    slug  = metadata.company_slug.lower()

    if layer == "raw":
        file_hash = hashlib.sha256(content).hexdigest()[:16]
        # Sanitize filename: keep only alphanumerics, dots, hyphens, underscores
        safe_name = _re.sub(r"[^\w.\-]", "_", filename)
        blob_name = f"raw/{slug}/{year}/{month}/{file_hash}_{safe_name}"
    elif layer == "stage":
        blob_name = f"stage/{slug}/{year}/{month}/{load_id}_gemini.json"
    else:  # gold
        blob_name = f"gold/{slug}/{year}/{month}/{load_id}_contract.json"

    try:
        client = _gcs_client()
        bucket = client.bucket(target_bucket)
        blob   = bucket.blob(blob_name)
        blob.upload_from_string(content, content_type=content_type)
        uri = f"gs://{target_bucket}/{blob_name}"
        _mlog.info("[medallion] %s → %s (%d bytes)", layer.upper(), uri, len(content))
        return uri
    except Exception as exc:
        _mlog.warning("[medallion] %s upload failed (non-fatal): %s", layer.upper(), exc)
        return ""


def upload_raw_layer(
    file_bytes:  bytes,
    filename:    str,
    metadata:    IngestionMetadata,
    bucket_name: str = "",
) -> str:
    """Sube el archivo original a la capa raw/ del bucket."""
    # Detectar content-type básico por extensión
    ext  = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime = {
        "pdf": "application/pdf",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls": "application/vnd.ms-excel",
        "csv": "text/csv",
    }.get(ext, "application/octet-stream")

    return upload_medallion_layer(
        layer        = "raw",
        content      = file_bytes,
        content_type = mime,
        filename     = filename,
        metadata     = metadata,
        bucket_name  = bucket_name,
    )


def upload_stage_layer(
    gemini_json: dict,
    metadata:    IngestionMetadata,
    load_id:     str,
    bucket_name: str = "",
) -> str:
    """Serializa el JSON bruto de Gemini y lo sube a la capa stage/."""
    content = _json.dumps(gemini_json, ensure_ascii=False, indent=2).encode("utf-8")
    return upload_medallion_layer(
        layer        = "stage",
        content      = content,
        content_type = "application/json",
        filename     = "gemini.json",
        metadata     = metadata,
        load_id      = load_id,
        bucket_name  = bucket_name,
    )


def upload_gold_layer(
    contract_json: dict,
    metadata:      IngestionMetadata,
    load_id:       str,
    bucket_name:   str = "",
) -> str:
    """
    Sube el contrato certificado de 109 KPIs a la capa gold/.
    Solo debe llamarse cuando el gate se abre (todos los innegociables OK).
    """
    content = _json.dumps(contract_json, ensure_ascii=False, indent=2).encode("utf-8")
    return upload_medallion_layer(
        layer        = "gold",
        content      = content,
        content_type = "application/json",
        filename     = "contract.json",
        metadata     = metadata,
        load_id      = load_id,
        bucket_name  = bucket_name,
    )
