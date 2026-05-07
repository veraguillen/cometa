"""
local_db.py
───────────
Capa de acceso a cometa_master.db (SQLite).

Responsabilidades:
  - Leer historial de KPIs por empresa (fact_kpi_registry)
  - Guardar nuevas cargas con is_verified=0
  - Construir comparación nueva carga vs. histórico
  - Convertir ExtractedKpi → filas de fact_kpi_registry (28+4 cols)

Diseño: funciones puras sin dependencia de api.py.
El módulo importa de kpi_mapper pero NO de kpi_dispatcher para evitar
el efecto del Freno de Emergencia en cargas parciales.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from src.core.kpi_mapper import ExtractedKpi, MappingResult

log = logging.getLogger(__name__)

# ── Rutas ──────────────────────────────────────────────────────────────────────

_ROOT           = Path(__file__).resolve().parents[2]
DB_PATH         = _ROOT / "cometa_master.db"
_JERO_OUT_PATH  = _ROOT / "output_to_jero.json"
# Fuente única de verdad: el mismo archivo que usa kpi_mapper.py
_BRAIN_PATH     = _ROOT / "assets" / "loading_brain_v1.json"

# KPIs donde un valor negativo es una violación física
_NEGATIVE_VIOLATION_KPIS = {"KPI-001", "KPI-026"}   # Revenue, Cash

# Quality scores para nuevas cargas verificadas
_QS = {"GOLD": 1.0, "PARTIAL": 0.40, "MISSING": 0.0, "FAIL_CONSISTENCY": 0.0}

# ══════════════════════════════════════════════════════════════════════════════
# CATÁLOGO MAESTRO 109 KPIs — Fuente única de verdad del gate
# ══════════════════════════════════════════════════════════════════════════════
#
# Filosofía "Completitud Total o Nada":
#   Un reporte solo se compromete (BQ + output_to_jero.json) cuando
#   los 109 KPIs están presentes.  Cargas parciales acumulan en SQLite
#   pero NO generan el contrato ni disparan BigQuery.
#
# Severidad de KPIs faltantes:
#   CRITICAL  → innegociable=True  (bloquea operaciones de Cometa)
#   HIGH      → priority_tier=1, GIVEN (input sin el cual hay agujero)
#   MEDIUM    → priority_tier=2
#   LOW       → priority_tier=3 o SILVER (se recalculan en BQ)

def _load_kpi_catalog() -> list[dict]:
    """
    Carga los 109 KPIs desde loading_brain_v1.json — la misma fuente que kpi_mapper.py.

    El brain tiene el catálogo en la clave "metrics" con el formato:
        kpi_ref, metric_id, display_name, innegociable, given_or_silver,
        sector_scope, priority_tier, unit, data_type, category, aliases...
    """
    try:
        with open(_BRAIN_PATH, encoding="utf-8") as f:
            brain = json.load(f)
        metrics = brain.get("metrics", [])
        catalog = []
        for m in metrics:
            catalog.append({
                "kpi_id":          m["kpi_ref"],           # "KPI-001"
                "metric_id":       m.get("metric_id", ""), # "revenue"
                "display_name":    m["display_name"],
                "innegociable":    bool(m.get("innegociable", False)),
                "given_or_silver": m.get("given_or_silver", "GIVEN"),
                "sector_scope":    m.get("sector_scope", "ALL"),
                "priority_tier":   int(m.get("priority_tier", 3)),
                "unit":            m.get("unit"),
                "data_type":       m.get("data_type"),
                "formula_bq":      m.get("formula_bq"),
                "category":        m.get("category"),
            })
        catalog.sort(key=lambda x: x["kpi_id"])
        log.debug("[local_db] Catalogo cargado de %s: %d KPIs", _BRAIN_PATH.name, len(catalog))
        return catalog
    except Exception as exc:
        log.error("[local_db] Error cargando catalogo KPI desde brain: %s", exc)
        return []


# Catálogo inmutable — se carga una sola vez al importar el módulo
_KPI_CATALOG_109: list[dict] = _load_kpi_catalog()

# Lookup rápido kpi_id → metadata del catálogo
_KPI_CATALOG_IDX: dict[str, dict] = {k["kpi_id"]: k for k in _KPI_CATALOG_109}

_INNEGOCIABLE_IDS: frozenset[str] = frozenset(
    k["kpi_id"] for k in _KPI_CATALOG_109 if k["innegociable"]
)

# Reverse index: metric_id ("revenue") → catalog entry — para el flujo PDF/Gemini
# donde los kpi_rows usan kpi_key = metric_id, no kpi_ref.
_CATALOG_BY_METRIC_ID: dict[str, dict] = {
    k["metric_id"]: k
    for k in _KPI_CATALOG_109
    if k.get("metric_id")
}


# ── Helpers internos ───────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    """Abre conexión a cometa_master.db. Usa row_factory para acceso por nombre."""
    if not DB_PATH.exists():
        log.warning(
            "[local_db] cometa_master.db no encontrada en %s — "
            "operaciones locales omitidas; BigQuery es la fuente de verdad.",
            DB_PATH,
        )
        raise RuntimeError(
            f"cometa_master.db no encontrada en {DB_PATH}. "
            "El sistema continúa usando BigQuery directamente."
        )
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pct_diff(new_val: float, old_val: float) -> Optional[float]:
    if old_val == 0:
        return None
    return (new_val - old_val) / abs(old_val) * 100.0


def _normalize(text: str) -> str:
    nfd = unicodedata.normalize("NFD", str(text))
    return " ".join(
        "".join(c for c in nfd if unicodedata.category(c) != "Mn").lower().split()
    )


# ══════════════════════════════════════════════════════════════════════════════
# LECTURA — historial de empresa
# ══════════════════════════════════════════════════════════════════════════════

def company_exists(company_slug: str) -> bool:
    """True si la empresa tiene al menos una fila en fact_kpi_registry."""
    try:
        with _connect() as conn:
            n = conn.execute(
                "SELECT COUNT(*) FROM fact_kpi_registry WHERE company_slug = ?",
                (company_slug.lower(),),
            ).fetchone()[0]
        return n > 0
    except Exception as exc:
        log.warning("[local_db] company_exists error: %s", exc)
        return False


def get_latest_kpi_values(company_slug: str) -> dict[str, dict]:
    """
    Devuelve el último valor conocido por metric_id para una empresa.

    Returns dict: { "KPI-001": {metric_id, value, period, audit_status, quality_score}, … }
    """
    try:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT metric_id, metric_name, value, period,
                       audit_status, quality_score, is_verified, unit
                FROM fact_kpi_registry
                WHERE company_slug = ?
                  AND is_deleted   = 0
                  AND value        IS NOT NULL
                GROUP BY metric_id
                HAVING period = MAX(period)
                """,
                (company_slug.lower(),),
            ).fetchall()
        return {r["metric_id"]: dict(r) for r in rows}
    except Exception as exc:
        log.warning("[local_db] get_latest_kpi_values error: %s", exc)
        return {}


def get_company_history_summary(company_slug: str) -> dict:
    """
    Resumen del historial de una empresa: períodos cubiertos, KPIs disponibles,
    calidad promedio.
    """
    try:
        with _connect() as conn:
            stats = conn.execute(
                """
                SELECT
                    COUNT(*)                                          AS total_rows,
                    COUNT(DISTINCT metric_id)                         AS unique_kpis,
                    COUNT(DISTINCT period)                            AS periods,
                    MIN(period)                                       AS period_min,
                    MAX(period)                                       AS period_max,
                    ROUND(AVG(quality_score), 3)                      AS avg_quality,
                    SUM(CASE WHEN audit_status='GOLD' THEN 1 ELSE 0 END)  AS gold_count,
                    SUM(CASE WHEN value IS NOT NULL   THEN 1 ELSE 0 END)  AS with_value
                FROM fact_kpi_registry
                WHERE company_slug = ? AND is_deleted = 0
                """,
                (company_slug.lower(),),
            ).fetchone()
        if stats:
            return dict(stats)
        return {}
    except Exception as exc:
        log.warning("[local_db] get_company_history_summary error: %s", exc)
        return {}


# ══════════════════════════════════════════════════════════════════════════════
# AUDITORÍA — comparación nueva carga vs. histórico
# ══════════════════════════════════════════════════════════════════════════════

def build_audit_comparison(
    company_slug: str,
    extracted_kpis: list,   # list[ExtractedKpi]
) -> dict:
    """
    Compara cada KPI extraído del archivo nuevo contra el último valor
    histórico en cometa_master.db.

    Returns dict con:
        company_exists      : bool
        history_summary     : dict (períodos, KPIs, calidad promedio)
        kpi_comparison      : list[dict] — new vs. last, delta_pct, trend
        high_variance_flags : list[dict] — KPIs con variación > 40%
        new_kpis            : list[str]  — KPIs que no existían en el historial
    """
    history    = get_latest_kpi_values(company_slug)
    exists     = bool(history)
    summary    = get_company_history_summary(company_slug) if exists else {}

    comparison:       list[dict] = []
    high_var_flags:   list[dict] = []
    new_kpis:         list[str]  = []

    for kpi in extracted_kpis:
        if kpi.numeric_value is None:
            continue

        hist = history.get(kpi.kpi_ref)

        if hist and hist["value"] is not None:
            last_val  = float(hist["value"])
            delta_pct = _pct_diff(kpi.numeric_value, last_val)
            abs_delta = abs(delta_pct) if delta_pct is not None else 0

            if delta_pct is None:
                trend = "STABLE"
            elif delta_pct > 5:
                trend = "UP"
            elif delta_pct < -5:
                trend = "DOWN"
            else:
                trend = "STABLE"

            # Flag variaciones grandes en innegociables
            if abs_delta > 40:
                severity = "HIGH" if abs_delta > 80 else "MEDIUM"
                high_var_flags.append({
                    "kpi_id":      kpi.kpi_ref,
                    "metric_name": kpi.display_name,
                    "severity":    severity,
                    "new_value":   kpi.numeric_value,
                    "last_value":  last_val,
                    "last_period": hist["period"],
                    "delta_pct":   round(delta_pct, 1) if delta_pct else None,
                    "message": (
                        f"{kpi.display_name} cambio {delta_pct:+.1f}% vs "
                        f"ultimo periodo ({hist['period']}). "
                        f"Verificar con Founder antes de confirmar la carga."
                    ),
                })

            comparison.append({
                "kpi_id":          kpi.kpi_ref,
                "metric_name":     kpi.display_name,
                "new_value":       kpi.numeric_value,
                "last_value":      last_val,
                "last_period":     hist["period"],
                "delta_pct":       round(delta_pct, 2) if delta_pct is not None else None,
                "trend":           trend,
                "hist_audit_status": hist["audit_status"],
                "hist_quality":    hist.get("quality_score"),
                "unit":            hist.get("unit") or kpi.unit,
            })

        else:
            # KPI nuevo — no existía en el historial
            new_kpis.append(kpi.kpi_ref)
            comparison.append({
                "kpi_id":      kpi.kpi_ref,
                "metric_name": kpi.display_name,
                "new_value":   kpi.numeric_value,
                "last_value":  None,
                "last_period": None,
                "delta_pct":   None,
                "trend":       "NEW",
                "hist_audit_status": "NEW",
                "hist_quality": None,
                "unit":        kpi.unit,
            })

    return {
        "company_exists":      exists,
        "history_summary":     summary,
        "kpi_comparison":      comparison,
        "high_variance_flags": high_var_flags,
        "new_kpis":            new_kpis,
    }


# ══════════════════════════════════════════════════════════════════════════════
# ESCRITURA — construcción y persistencia de filas nuevas
# ══════════════════════════════════════════════════════════════════════════════

def _compute_audit_fields(
    kpi_ref: str,
    value: Optional[float],
    match_type_raw: str,     # "exact"|"normalized"|"fuzzy" del mapper
    flag_review: bool,
) -> tuple[str, Optional[str], float, str]:
    """
    Calcula los 4 campos de auditoría para una fila nueva.

    Returns (audit_status, audit_notes, quality_score, match_type_db)
    """
    # match_type: mapper usa 'exact'/'normalized'/'fuzzy'; DB usa 'EXACT'/'FUZZY'/'NULL'
    if match_type_raw in ("exact", "normalized"):
        match_type_db = "EXACT"
    elif match_type_raw == "fuzzy":
        match_type_db = "FUZZY"
    else:
        match_type_db = "NULL"

    # Prioridad de audit_status (mayor a menor):
    if value is not None and value < 0 and kpi_ref in _NEGATIVE_VIOLATION_KPIS:
        return (
            "FAIL_CONSISTENCY",
            (f"[FAIL_CONSISTENCY] {kpi_ref} con valor negativo: {value:,.2f}. "
             "Revenue y Cash no pueden ser negativos. Contactar Founder."),
            _QS["FAIL_CONSISTENCY"],
            match_type_db,
        )

    if value is None:
        return "MISSING", "Valor no extraido del archivo.", _QS["MISSING"], match_type_db

    if flag_review or match_type_db == "FUZZY":
        note = (
            "[PARTIAL] Match aproximado — verificar etiqueta con Founder."
            if match_type_db == "FUZZY"
            else "[PARTIAL] Dato marcado para revision."
        )
        return "PARTIAL", note, _QS["PARTIAL"], match_type_db

    return "GOLD", None, _QS["GOLD"], match_type_db


def build_registry_rows(
    mapping_result,          # MappingResult
    metadata,                # IngestionMetadata (kpi_dispatcher)
    load_id: Optional[str] = None,
) -> list[dict]:
    """
    Convierte MappingResult en filas completas para fact_kpi_registry (32 cols).

    No llama a build_atomic_payload (evita el Freno de Emergencia).
    Construye las filas directamente desde mapping_result.found.
    """
    from src.core.kpi_mapper import load_kpi_intelligence   # lazy para evitar circular

    batch_id  = load_id or str(uuid.uuid4())
    load_ts   = _now_iso()
    intel     = load_kpi_intelligence()
    brain_idx = {m["metric_id"]: m for m in intel.metrics}

    period_str = metadata.period.strftime("%Y%m")
    rows: list[dict] = []

    for kpi in mapping_result.found:
        brain_meta = brain_idx.get(kpi.metric_id, {})
        flag_review = any(
            f.flag_review for f in mapping_result.validation_flags
        )
        audit_status, audit_notes, quality_score, match_type_db = _compute_audit_fields(
            kpi_ref=kpi.kpi_ref,
            value=kpi.numeric_value,
            match_type_raw=kpi.match_type,
            flag_review=flag_review,
        )

        row_id = f"{metadata.company_slug}_{period_str}_{kpi.kpi_ref}"

        given_silver  = brain_meta.get("given_or_silver", "GIVEN")
        formula_bq    = brain_meta.get("formula_bq")
        sector_scope  = brain_meta.get("sector_scope", "ALL")
        is_inneg      = bool(brain_meta.get("innegociable", False))
        unit          = brain_meta.get("unit") or kpi.unit

        rows.append({
            # ── 28 columnas Jero ──────────────────────────────────────────────
            "row_id":             row_id,
            "company_name":       metadata.company_name.upper(),
            "company_slug":       metadata.company_slug.lower(),
            "period":             metadata.period.isoformat(),
            "metric_id":          kpi.kpi_ref,
            "metric_name":        kpi.display_name,
            "value":              kpi.numeric_value,
            "value_type":         "real",
            "currency":           None,
            "unit":               unit,
            "status_tier":        "GOLD" if audit_status == "GOLD" else audit_status,
            "given_or_silver":    given_silver,
            "quality_score":      quality_score,
            "is_innegociable":    int(is_inneg),
            "source":             "verified",
            "source_file":        getattr(metadata, "source_file_hint", None),
            "input_form_version": getattr(metadata, "form_version", "v1.0.0"),
            "formula_bq":         formula_bq,
            "physics_violation":  int(audit_status == "FAIL_CONSISTENCY"),
            "flag_review":        int(audit_status in ("PARTIAL", "FAIL_CONSISTENCY")),
            "founder_alert":      int(audit_status == "FAIL_CONSISTENCY"),
            "sector_scope":       sector_scope,
            "load_id":            batch_id,
            "load_timestamp":     load_ts,
            "loaded_by":          getattr(metadata, "loaded_by", "api"),
            "confirmed_by":       None,
            "last_updated":       None,
            "is_deleted":         0,
            # ── 4 columnas auditoría ─────────────────────────────────────────
            "is_verified":        0,
            "audit_status":       audit_status,
            "match_type":         match_type_db,
            "audit_notes":        audit_notes,
        })

    return rows


def save_registry_rows(rows: list[dict]) -> int:
    """
    Inserta/actualiza filas en fact_kpi_registry con INSERT OR REPLACE.
    Idempotente: row_id es la PK.

    Returns número de filas escritas.
    """
    if not rows:
        return 0

    cols         = list(rows[0].keys())
    placeholders = ", ".join("?" * len(cols))
    col_names    = ", ".join(cols)
    sql          = (
        f"INSERT OR REPLACE INTO fact_kpi_registry ({col_names}) "
        f"VALUES ({placeholders})"
    )
    batch = [tuple(r[c] for c in cols) for r in rows]

    try:
        with _connect() as conn:
            conn.executemany(sql, batch)
            conn.commit()
        log.info("[local_db] %d filas guardadas en fact_kpi_registry", len(rows))
        return len(rows)
    except sqlite3.Error as exc:
        log.error("[local_db] Error guardando filas: %s", exc)
        return 0


# ══════════════════════════════════════════════════════════════════════════════
# COMMITMENT GATE — evaluación del umbral de calidad
# ══════════════════════════════════════════════════════════════════════════════

def get_stored_kpis_for_period(company_slug: str, period_iso: str) -> set[str]:
    """
    Devuelve el conjunto de metric_ids ya almacenados en DB para
    company_slug + period (de cargas anteriores, incluyendo la actual).
    Permite acumular KPIs de múltiples archivos antes de confirmar.
    """
    try:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT DISTINCT metric_id
                FROM fact_kpi_registry
                WHERE company_slug = ?
                  AND period       = ?
                  AND is_deleted   = 0
                  AND value        IS NOT NULL
                """,
                (company_slug.lower(), period_iso),
            ).fetchall()
        return {r[0] for r in rows}
    except Exception as exc:
        log.warning("[local_db] get_stored_kpis_for_period error: %s", exc)
        return set()


def _get_stored_kpis_full(company_slug: str, period_iso: str) -> dict:
    """
    Devuelve todos los KPIs ya persistidos en SQLite para company+period.

    Return:
        dict  kpi_ref → {"value", "unit", "match_type", "audit_status",
                          "quality_score", "source"}

    Usado por build_accumulated_kpi_grid para fusionar memoria de cargas
    previas con el resultado del archivo actual.
    """
    try:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT metric_id, value, unit, match_type, audit_status,
                       quality_score, source
                FROM   fact_kpi_registry
                WHERE  company_slug = ?
                  AND  period       = ?
                  AND  is_deleted   = 0
                  AND  value        IS NOT NULL
                """,
                (company_slug.lower(), period_iso),
            ).fetchall()
        return {
            r[0]: {
                "value":         r[1],
                "unit":          r[2],
                "match_type":    r[3],
                "audit_status":  r[4],
                "quality_score": r[5],
                "source":        r[6],
            }
            for r in rows
        }
    except Exception as exc:
        log.warning("[local_db] _get_stored_kpis_full error: %s", exc)
        return {}


def build_accumulated_kpi_grid(
    company_slug: str,
    period_iso:   str,
    current_kpis: Optional[dict] = None,
) -> list[dict]:
    """
    Construye la grilla de 109 KPIs fusionando TRES fuentes en orden de prioridad:

      1. SQLite (cargas anteriores del mismo período — la "memoria")
      2. current_kpis (hallazgos del archivo recién subido — gana sobre SQLite)
      3. Entradas manuales del Founder (incluidas en current_kpis con source="manual")

    Args:
        company_slug : slug normalizado de la empresa.
        period_iso   : fecha ISO del período ("2025-09-01").
        current_kpis : dict  kpi_ref → {"value", "unit", "match_type",
                             "audit_status", "quality_score", "source"}
                       None = solo memoria SQLite.

    Returns lista de 109 dicts con el formato estándar del sistema.
    El resultado es siempre exactamente 109 filas.
    """
    # 1. Memoria de cargas previas
    stored: dict = _get_stored_kpis_full(company_slug, period_iso)

    # 2. Fusión — el archivo actual gana sobre lo almacenado para el mismo KPI
    merged: dict = {**stored, **(current_kpis or {})}

    # 3. Construir grilla completa contra el catálogo maestro
    grid: list[dict] = []
    for meta in _KPI_CATALOG_109:
        kid  = meta["kpi_id"]
        data = merged.get(kid)

        if data is not None and data.get("value") is not None:
            grid.append({
                "kpi_id":          kid,
                "display_name":    meta["display_name"],
                "status":          "FOUND",
                "value":           data["value"],
                "unit":            meta.get("unit") or data.get("unit"),
                "match_type":      data.get("match_type", "EXACT"),
                "audit_status":    data.get("audit_status", "GOLD"),
                "innegociable":    meta["innegociable"],
                "priority_tier":   meta["priority_tier"],
                "given_or_silver": meta["given_or_silver"],
                "category":        meta.get("category"),
                "source":          data.get("source", "automatic"),
            })
        else:
            grid.append({
                "kpi_id":          kid,
                "display_name":    meta["display_name"],
                "status":          "MISSING",
                "value":           None,
                "unit":            meta.get("unit"),
                "match_type":      None,
                "audit_status":    "MISSING",
                "innegociable":    meta["innegociable"],
                "priority_tier":   meta["priority_tier"],
                "given_or_silver": meta["given_or_silver"],
                "category":        meta.get("category"),
                "source":          None,
            })

    return grid


def check_gate_for_finalize(
    company_slug: str,
    manual_kpi_refs: Optional[set] = None,
) -> dict:
    """
    Gate de seguridad final para POST /api/founder/finalize.

    Consulta SQLite para el período más reciente de la empresa y combina
    los KPI refs almacenados con cualquier KPI ingresado manualmente en el UI.
    Compara contra los 109 del catálogo maestro.

    Args:
        company_slug:    slug de la empresa (normalizado a minúsculas).
        manual_kpi_refs: conjunto de kpi_refs ("KPI-001", …) ingresados
                         manualmente por el founder en la grilla 109.
                         Estos son los keys de body.manual_kpis que llegan
                         en el payload del /finalize y ya están en formato KPI-XXX.

    Returns dict:
        gate_passed  : True solo si present == 109
        present      : cantidad de KPIs cubiertos (DB + manuales)
        missing      : 109 - present
        total        : 109
        period       : período ISO del conjunto evaluado (o None si DB vacía)
        missing_ids  : lista de kpi_ref faltantes
    """
    catalog_ids: set[str] = {m["kpi_id"] for m in _KPI_CATALOG_109}
    extra: set[str]       = set(manual_kpi_refs or set()) & catalog_ids

    try:
        with _connect() as conn:
            # Período más reciente para esta empresa
            row = conn.execute(
                """
                SELECT period
                FROM fact_kpi_registry
                WHERE company_slug = ?
                  AND is_deleted   = 0
                  AND value        IS NOT NULL
                ORDER BY period DESC
                LIMIT 1
                """,
                (company_slug.lower(),),
            ).fetchone()

            if row is None:
                missing_ids = sorted(catalog_ids)
                return {
                    "gate_passed": False,
                    "present":     len(extra),
                    "missing":     len(catalog_ids) - len(extra),
                    "total":       len(catalog_ids),
                    "period":      None,
                    "missing_ids": [m for m in missing_ids if m not in extra],
                }

            latest_period = row[0]

            # Todos los kpi_refs almacenados en ese período
            stored_rows = conn.execute(
                """
                SELECT DISTINCT metric_id
                FROM fact_kpi_registry
                WHERE company_slug = ?
                  AND period       = ?
                  AND is_deleted   = 0
                  AND value        IS NOT NULL
                """,
                (company_slug.lower(), latest_period),
            ).fetchall()
    except Exception as exc:
        log.error("[finalize_gate] DB query failed: %s", exc)
        # Fail-closed: si la DB da error, bloquear
        return {
            "gate_passed": False,
            "present":     0,
            "missing":     len(catalog_ids),
            "total":       len(catalog_ids),
            "period":      None,
            "missing_ids": sorted(catalog_ids),
        }

    stored_ids: set[str]  = {r[0] for r in stored_rows}
    covered: set[str]     = (stored_ids | extra) & catalog_ids
    missing_ids: list[str] = sorted(catalog_ids - covered)

    return {
        "gate_passed": len(missing_ids) == 0,
        "present":     len(covered),
        "missing":     len(missing_ids),
        "total":       len(catalog_ids),
        "period":      latest_period,
        "missing_ids": missing_ids,
    }


def _severity_for(kpi: dict) -> str:
    """Mapea metadata del catálogo a severidad de negocio."""
    if kpi["innegociable"]:
        return "CRITICAL"
    if kpi["priority_tier"] == 1 and kpi["given_or_silver"] == "GIVEN":
        return "HIGH"
    if kpi["priority_tier"] == 2:
        return "MEDIUM"
    return "LOW"


def evaluate_commitment_gate(
    company_slug: str,
    period_iso: str,
    sector: str,
    mapping_result,          # MappingResult
) -> dict:
    """
    Gate de "Completitud Total o Nada" — evalúa contra los 109 KPIs del catálogo.

    Lógica de acumulación multi-archivo:
      1. KPIs del archivo actual (mapping_result.found con valor numérico)
      2. KPIs de cargas anteriores del mismo period ya en DB
      3. Unión de ambos se compara contra los 109 del catálogo

    Solo cuando los 109 están presentes se autoriza:
      - dispatch_to_storage() → BigQuery
      - generate_jero_contract() → output_to_jero.json

    Returns dict con:
        required_total   : 109
        present_count    : KPIs presentes acumulados
        counter          : "X/109"
        gate_passed      : bool
        missing_required : lista ordenada (CRITICAL → LOW) con nombre y severidad
        present_required : KPIs ya provistos
        missing_critical : solo innegociables que faltan
        coverage_pct     : float — porcentaje de cobertura
        ui_hint          : mensaje empresarial para el Founder
    """
    if not _KPI_CATALOG_109:
        log.error("[gate] Catalogo KPI vacio — revisar kpi_config_for_jero.json")
        return {"gate_passed": False, "counter": "0/109", "required_total": 109,
                "present_count": 0, "missing_required": [], "present_required": [],
                "missing_critical": [], "coverage_pct": 0.0,
                "ui_hint": "Error interno: catalogo no disponible."}

    required_total = len(_KPI_CATALOG_109)   # 109

    # ── KPIs presentes: archivo actual + acumulados en DB ────────────────────
    current_ids = {
        kpi.kpi_ref
        for kpi in mapping_result.found
        if kpi.numeric_value is not None
    }
    stored_ids    = get_stored_kpis_for_period(company_slug, period_iso)
    all_available = current_ids | stored_ids

    # ── Clasificar cada uno de los 109 ───────────────────────────────────────
    present_list: list[dict] = []
    missing_list: list[dict] = []

    for kpi_meta in _KPI_CATALOG_109:
        kid = kpi_meta["kpi_id"]
        severity = _severity_for(kpi_meta)
        if kid in all_available:
            present_list.append({
                "kpi_id":        kid,
                "display_name":  kpi_meta["display_name"],
                "innegociable":  kpi_meta["innegociable"],
                "severity":      severity,
                "given_or_silver": kpi_meta["given_or_silver"],
            })
        else:
            missing_list.append({
                "kpi_id":        kid,
                "display_name":  kpi_meta["display_name"],
                "innegociable":  kpi_meta["innegociable"],
                "severity":      severity,
                "given_or_silver": kpi_meta["given_or_silver"],
                "priority_tier": kpi_meta["priority_tier"],
            })

    # Ordenar faltantes: CRITICAL > HIGH > MEDIUM > LOW
    _sev_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    missing_list.sort(key=lambda x: (_sev_order.get(x["severity"], 9), x["kpi_id"]))

    present_count    = len(present_list)
    gate_passed      = len(missing_list) == 0
    coverage_pct     = round(present_count / required_total * 100, 1)
    missing_critical = [m for m in missing_list if m["severity"] == "CRITICAL"]

    # ── ui_hint: mensaje futurista por estado ─────────────────────────────────
    if gate_passed:
        ui_hint = (
            "INTEGRITY VERIFIED. Los 109 KPIs del portfolio han sido validados. "
            "El contrato Cometa ha sido generado y el compromiso enviado a BigQuery. "
            "Este reporte es inmutable — Jero tiene acceso completo."
        )
    elif missing_critical:
        crit_names = ", ".join(m["display_name"] for m in missing_critical[:5])
        extra = f" (y {len(missing_critical)-5} mas)" if len(missing_critical) > 5 else ""
        ui_hint = (
            f"GATE BLOQUEADO — {present_count}/109 KPIs recibidos ({coverage_pct}% cobertura). "
            f"KPIs CRITICOS faltantes: {crit_names}{extra}. "
            f"Sin estos datos Cometa no puede calcular el valor del portfolio. "
            f"Sube el archivo complementario para desbloquear el commit."
        )
    else:
        ui_hint = (
            f"AVANCE REGISTRADO — {present_count}/109 KPIs recibidos ({coverage_pct}% cobertura). "
            f"Faltan {len(missing_list)} KPIs secundarios para completar el reporte. "
            f"Todos los datos criticos estan presentes. "
            f"Sube un segundo archivo con las metricas operativas para generar el contrato final."
        )

    return {
        "required_total":  required_total,
        "present_count":   present_count,
        "counter":         f"{present_count}/{required_total}",
        "gate_passed":     gate_passed,
        "coverage_pct":    coverage_pct,
        "missing_required": missing_list,
        "present_required": present_list,
        "missing_critical": missing_critical,
        "ui_hint":         ui_hint,
    }


# ══════════════════════════════════════════════════════════════════════════════
# CONTRATO JERO — output_to_jero.json
# ══════════════════════════════════════════════════════════════════════════════

def generate_jero_contract(
    mapping_result,     # MappingResult
    metadata,           # IngestionMetadata
    load_id: str,
    gate_passed: bool = False,
) -> tuple[list[dict], Path]:
    """
    Genera output_{COMPANY}_{PERIOD}.json — lista plana de 109 registros BigQuery-ready.

    Regla de hierro: solo puede llamarse cuando gate_passed=True.
    Si gate_passed=False el archivo NO se crea — la existencia del archivo
    es la prueba de que el gate se abrió.

    Formato del archivo: output_{COMPANY_SLUG_UPPER}_{PERIOD_CODE}.json
    Ejemplo: output_HUNTY_P2025Q3.json

    Un registro por cada KPI del catálogo:
      - Si el KPI fue extraído: value real, source="automatic", audit real
      - Si falta: value=null, source=null, audit_status="MISSING", quality_score=0.0

    Returns (records, output_path)
    Raises RuntimeError si gate_passed=False.
    """
    if not gate_passed:
        raise RuntimeError(
            "[jero_contract] Gate no pasado — output file no generado. "
            f"company={getattr(metadata, 'company_slug', '?')} load_id={load_id}"
        )

    timestamp_iso = _now_iso()
    period_iso    = metadata.period.isoformat()
    company_slug  = metadata.company_slug.lower()
    company_name  = metadata.company_name.upper()

    # Nombre de archivo único por empresa + período
    # Formato período: P{YEAR}Q{QUARTER}   e.g. P2025Q3
    import math as _math
    _period_dt = metadata.period
    _quarter   = _math.ceil(_period_dt.month / 3)
    _period_code = f"P{_period_dt.year}Q{_quarter}"
    _output_path = _ROOT / f"output_{company_slug.upper()}_{_period_code}.json"

    # Lookup rápido de KPIs extraídos: kpi_ref → ExtractedKpi
    extracted_idx: dict[str, Any] = {
        kpi.kpi_ref: kpi
        for kpi in mapping_result.found
        if kpi.numeric_value is not None
    }

    records: list[dict] = []

    for kpi_meta in _KPI_CATALOG_109:
        kid   = kpi_meta["kpi_id"]
        ext   = extracted_idx.get(kid)

        if ext is not None:
            # KPI presente — calcular audit desde _compute_audit_fields
            audit_status, audit_notes, quality_score, _ = _compute_audit_fields(
                kpi_ref=kid,
                value=ext.numeric_value,
                match_type_raw=ext.match_type,
                flag_review=any(f.flag_review for f in mapping_result.validation_flags),
            )
            record = {
                "kpi_id":        kid,
                "metric_name":   kpi_meta["display_name"],
                "value":         ext.numeric_value,
                "period":        period_iso,
                "company_slug":  company_slug,
                "company_name":  company_name,
                "source":        "automatic",
                "given_or_silver": kpi_meta["given_or_silver"],
                "audit_status":  audit_status,
                "is_verified":   0,
                "quality_score": quality_score,
                "innegociable":  kpi_meta["innegociable"],
                "unit":          kpi_meta.get("unit"),
                "load_id":       load_id,
                "timestamp":     timestamp_iso,
            }
        else:
            # KPI ausente — null explícito
            record = {
                "kpi_id":        kid,
                "metric_name":   kpi_meta["display_name"],
                "value":         None,
                "period":        period_iso,
                "company_slug":  company_slug,
                "company_name":  company_name,
                "source":        None,
                "given_or_silver": kpi_meta["given_or_silver"],
                "audit_status":  "MISSING",
                "is_verified":   0,
                "quality_score": 0.0,
                "innegociable":  kpi_meta["innegociable"],
                "unit":          kpi_meta.get("unit"),
                "load_id":       load_id,
                "timestamp":     timestamp_iso,
            }

        records.append(record)

    # Escritura atómica: .tmp → replace
    tmp_path = _output_path.with_suffix(".json.tmp")
    tmp_path.write_text(
        json.dumps(records, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    tmp_path.replace(_output_path)

    log.info(
        "[jero_contract] %d registros escritos en %s (load_id=%s)",
        len(records), _output_path.name, load_id,
    )
    return records, _output_path


# ══════════════════════════════════════════════════════════════════════════════
# RESPUESTA ENRIQUECIDA — formato para el frontend
# ══════════════════════════════════════════════════════════════════════════════

def build_kpi_status_grid(mapping_result) -> list[dict]:
    """
    Genera el mapa completo de los 109 KPIs del catálogo (loading_brain_v1.json)
    con el status de cada uno en la carga actual.

    Cada registro:
        kpi_id       : "KPI-001"
        display_name : "Revenue"
        status       : "FOUND" | "MISSING"
        value        : float | null
        unit         : str | null
        match_type   : "EXACT" | "FUZZY" | null
        audit_status : "GOLD" | "PARTIAL" | "MISSING" | "FAIL_CONSISTENCY"
        innegociable : bool
        priority_tier: int
        given_or_silver: "GIVEN" | "SILVER"

    Siempre devuelve exactamente 109 filas — el frontend puede renderizar
    la grilla completa sin lógica adicional.
    """
    # Index de KPIs encontrados por kpi_ref
    found_idx: dict[str, Any] = {
        kpi.kpi_ref: kpi
        for kpi in mapping_result.found
    }
    flag_review_global = any(f.flag_review for f in mapping_result.validation_flags)

    grid: list[dict] = []
    for meta in _KPI_CATALOG_109:
        kid  = meta["kpi_id"]
        ext  = found_idx.get(kid)

        if ext is not None and ext.numeric_value is not None:
            audit_status, _, _, match_type_db = _compute_audit_fields(
                kpi_ref=kid,
                value=ext.numeric_value,
                match_type_raw=ext.match_type,
                flag_review=flag_review_global,
            )
            grid.append({
                "kpi_id":          kid,
                "display_name":    meta["display_name"],
                "status":          "FOUND",
                "value":           ext.numeric_value,
                "unit":            meta.get("unit") or ext.unit,
                "match_type":      match_type_db,
                "audit_status":    audit_status,
                "innegociable":    meta["innegociable"],
                "priority_tier":   meta["priority_tier"],
                "given_or_silver": meta["given_or_silver"],
                "category":        meta.get("category"),
            })
        else:
            grid.append({
                "kpi_id":          kid,
                "display_name":    meta["display_name"],
                "status":          "MISSING",
                "value":           None,
                "unit":            meta.get("unit"),
                "match_type":      None,
                "audit_status":    "MISSING",
                "innegociable":    meta["innegociable"],
                "priority_tier":   meta["priority_tier"],
                "given_or_silver": meta["given_or_silver"],
                "category":        meta.get("category"),
            })

    return grid


def build_enriched_audit_response(
    company_slug: str,
    mapping_result,         # MappingResult
    rows_saved: int,
    load_id: str,
    period_iso: str = "",
) -> dict:
    """
    Construye el objeto `audit` que se añade a la respuesta de /upload.

    Incluye:
      - kpi_grid: grilla ACUMULADA de 109 KPIs (SQLite anterior + hallazgos actuales)
      - Comparación new vs. histórico
      - Distribución de audit_status de las nuevas filas
      - Flags de alta varianza para mostrar al Analista

    La grilla mezcla la "memoria" de cargas previas del mismo período con los
    hallazgos del archivo actual.  El Founder ve progreso real acumulado.
    """
    comparison = build_audit_comparison(company_slug, mapping_result.found)

    # Construir current_kpis desde mapping_result (hallazgos del archivo actual)
    flag_review_global = any(f.flag_review for f in mapping_result.validation_flags)
    current_kpis: dict = {}
    for kpi in mapping_result.found:
        if kpi.numeric_value is None:
            continue
        audit_status, _, quality_score, match_type_db = _compute_audit_fields(
            kpi_ref=kpi.kpi_ref,
            value=kpi.numeric_value,
            match_type_raw=kpi.match_type,
            flag_review=flag_review_global,
        )
        current_kpis[kpi.kpi_ref] = {
            "value":         kpi.numeric_value,
            "unit":          kpi.unit,
            "match_type":    match_type_db,
            "audit_status":  audit_status,
            "quality_score": quality_score,
            "source":        "automatic",
        }

    # Grilla acumulada: SQLite (previo) + current_kpis (ahora)
    # Si period_iso está vacío, build_accumulated_kpi_grid solo usa current_kpis
    kpi_grid = build_accumulated_kpi_grid(
        company_slug = company_slug,
        period_iso   = period_iso,
        current_kpis = current_kpis,
    )

    found_count   = sum(1 for r in kpi_grid if r["status"] == "FOUND")
    missing_count = len(kpi_grid) - found_count

    # Distribución de audit_status en la grilla acumulada
    status_dist: dict[str, int] = {"GOLD": 0, "PARTIAL": 0, "MISSING": 0, "FAIL_CONSISTENCY": 0}
    for row in kpi_grid:
        status_dist[row["audit_status"]] = status_dist.get(row["audit_status"], 0) + 1

    return {
        "load_id":             load_id,
        "is_verified":         0,
        "rows_saved":          rows_saved,
        "kpi_grid":            kpi_grid,           # 109 KPIs acumulados (FOUND + MISSING)
        "kpi_grid_summary": {
            "total":    len(kpi_grid),             # siempre 109
            "found":    found_count,
            "missing":  missing_count,
            "source":   _BRAIN_PATH.name,
        },
        "audit_status_dist":   status_dist,
        **comparison,
    }


# ══════════════════════════════════════════════════════════════════════════════
# FLUJO PDF/GEMINI — helpers de grilla y persistencia SQLite
# ══════════════════════════════════════════════════════════════════════════════
#
# La rama PDF de api.py usa build_contract() → kpi_rows (lista de dicts con
# kpi_key como "revenue", "mrr", …) en lugar de MappingResult.
# Estas funciones convierten ese formato al estándar del sistema para que:
#   1. El frontend siempre reciba audit.kpi_grid con los hallazgos de Gemini.
#   2. Los KPIs encontrados se persistan en SQLite para que check_gate_for_finalize
#      pueda contarlos al llegar el /finalize.

def build_kpi_grid_from_contract_rows(kpi_rows: list[dict]) -> list[dict]:
    """
    Builds el mapa de 109 KPIs desde los kpi_rows del flujo PDF/Gemini.

    kpi_rows viene de build_contract() con campos:
        kpi_key       : str  ("revenue", "mrr", …) == metric_id en el catálogo
        numeric_value : float | None
        is_valid      : bool
        unit          : str | None
        raw_value     : str | None

    Regla de marcado:
        FOUND   → kpi_key matchea metric_id en catálogo Y numeric_value is not None
        MISSING → cualquier otro caso

    Returns lista de 109 dicts en el mismo formato que build_kpi_status_grid().
    """
    # Index por metric_id de los KPIs encontrados con valor numérico válido
    found_idx: dict[str, dict] = {}
    for row in kpi_rows:
        key = row.get("kpi_key", "")
        val = row.get("numeric_value")
        if val is not None and row.get("is_valid", False):
            found_idx[key] = row

    grid: list[dict] = []
    for meta in _KPI_CATALOG_109:
        kid       = meta["kpi_id"]
        metric_id = meta.get("metric_id", "")
        row_data  = found_idx.get(metric_id)

        if row_data is not None:
            grid.append({
                "kpi_id":          kid,
                "display_name":    meta["display_name"],
                "status":          "FOUND",
                "value":           row_data["numeric_value"],
                "unit":            meta.get("unit") or row_data.get("unit"),
                "match_type":      "EXACT",
                "audit_status":    "GOLD",
                "innegociable":    meta["innegociable"],
                "priority_tier":   meta["priority_tier"],
                "given_or_silver": meta["given_or_silver"],
                "category":        meta.get("category"),
            })
        else:
            grid.append({
                "kpi_id":          kid,
                "display_name":    meta["display_name"],
                "status":          "MISSING",
                "value":           None,
                "unit":            meta.get("unit"),
                "match_type":      None,
                "audit_status":    "MISSING",
                "innegociable":    meta["innegociable"],
                "priority_tier":   meta["priority_tier"],
                "given_or_silver": meta["given_or_silver"],
                "category":        meta.get("category"),
            })

    return grid


def build_registry_rows_from_contract(
    kpi_rows:     list[dict],
    company_slug: str,
    company_name: str,
    period_iso:   str,          # ISO date string e.g. "2025-09-01"
    load_id:      str,
    loaded_by:    str = "api",
) -> list[dict]:
    """
    Convierte kpi_rows del flujo PDF/Gemini en filas para fact_kpi_registry.

    Permite que save_registry_rows() persista los hallazgos de Gemini en SQLite
    para que check_gate_for_finalize() los cuente al llegar el /finalize.

    Solo persiste KPIs con numeric_value and is_valid=True que estén en el catálogo.
    """
    load_ts = _now_iso()
    rows: list[dict] = []

    for row in kpi_rows:
        metric_id_key = row.get("kpi_key", "")
        num_val       = row.get("numeric_value")
        if num_val is None or not row.get("is_valid", False):
            continue

        # Buscar la entrada en el catálogo por metric_id
        cat_meta = _CATALOG_BY_METRIC_ID.get(metric_id_key)
        if cat_meta is None:
            continue   # KPI no reconocido en el catálogo — no persistir

        kid      = cat_meta["kpi_id"]    # "KPI-001"
        row_id   = f"{company_slug}_{period_iso.replace('-', '')}_{kid}"

        is_inneg    = cat_meta["innegociable"]
        unit        = cat_meta.get("unit") or row.get("unit")
        given_silv  = cat_meta["given_or_silver"]
        formula_bq  = cat_meta.get("formula_bq")
        sector_scope = cat_meta.get("sector_scope", "ALL")

        # Auditoría básica para KPIs del flujo Gemini
        audit_status, audit_notes, quality_score, match_type_db = _compute_audit_fields(
            kpi_ref=kid,
            value=num_val,
            match_type_raw="EXACT",
            flag_review=False,
        )

        rows.append({
            "row_id":             row_id,
            "company_name":       company_name.upper(),
            "company_slug":       company_slug.lower(),
            "period":             period_iso,
            "metric_id":          kid,        # kpi_ref format: "KPI-001"
            "metric_name":        cat_meta["display_name"],
            "value":              num_val,
            "value_type":         "real",
            "currency":           None,
            "unit":               unit,
            "status_tier":        "GOLD" if audit_status == "GOLD" else audit_status,
            "given_or_silver":    given_silv,
            "quality_score":      quality_score,
            "is_innegociable":    int(is_inneg),
            "source":             "gemini",
            "source_file":        None,
            "input_form_version": "gemini-v1",
            "formula_bq":         formula_bq,
            "physics_violation":  int(audit_status == "FAIL_CONSISTENCY"),
            "flag_review":        int(audit_status in ("PARTIAL", "FAIL_CONSISTENCY")),
            "founder_alert":      int(audit_status == "FAIL_CONSISTENCY"),
            "sector_scope":       sector_scope,
            "load_id":            load_id,
            "load_timestamp":     load_ts,
            "loaded_by":          loaded_by,
            "confirmed_by":       None,
            "last_updated":       None,
            "is_deleted":         0,
            "is_verified":        0,
            "audit_status":       audit_status,
            "match_type":         match_type_db,
            "audit_notes":        audit_notes,
        })

    return rows
