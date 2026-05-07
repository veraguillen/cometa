"""
kpi_mapper.py
─────────────
Motor de Mapeo para archivos Excel/CSV subidos por Founders.

Flujo:
  1. Carga la inteligencia (loading_brain_v1.json + kpi_master_dictionary.csv).
  2. Escanea columnas y filas del archivo buscando coincidencias con los 109 alias.
  3. Estandariza cada match al metric_id canónico (ej. "Ventas Totales" → KPI-001).
  4. Genera un reporte de gaps: KPIs encontrados vs. faltantes.
  5. Aplica reglas de validación (BLK-001, TRI-001-005, WRN-001).

Punto de entrada público:
    result = map_uploaded_file("archivo.xlsx", sector="SAAS_SUBSCRIPTION",
                               prev_cash=500_000, prev_burn=-80_000)
"""

from __future__ import annotations

import csv
import json
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# ── Paths ──────────────────────────────────────────────────────────────────────

_ASSETS_DIR = Path(__file__).resolve().parents[2] / "assets"
_BRAIN_PATH  = _ASSETS_DIR / "loading_brain_v1.json"
_CSV_PATH    = _ASSETS_DIR / "kpi_master_dictionary.csv"

# ── Types ──────────────────────────────────────────────────────────────────────

MatchType = Literal["exact", "normalized", "fuzzy", "derived"]


@dataclass
class ExtractedKpi:
    """Un KPI encontrado en el archivo del Founder."""

    kpi_ref:      str             # "KPI-001"
    metric_id:    str             # "revenue"
    display_name: str             # "Revenue"
    raw_value:    Any             # valor crudo desde la celda
    numeric_value: Optional[float]  # valor parseado
    unit:         Optional[str]   # "USD" | "%" | None
    source_label: str             # texto del header/fila que generó el match
    match_type:   MatchType       # "exact" | "normalized" | "fuzzy"
    match_score:  float           # 0.0–1.0


@dataclass
class ValidationFlag:
    """Resultado de una regla de validación."""

    rule_id:          str
    severity:         Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    message:          str
    action:           str
    block_submission: bool = False
    flag_review:      bool = False


@dataclass
class MappingResult:
    """Resultado completo del Motor de Mapeo para un archivo."""

    found:                list[ExtractedKpi]   = field(default_factory=list)
    missing_kpis:         list[dict]           = field(default_factory=list)
    innegociables_missing: list[dict]          = field(default_factory=list)
    validation_flags:     list[ValidationFlag] = field(default_factory=list)
    coverage_pct:         float                = 0.0
    can_submit:           bool                 = True


# ── Intelligence loader ────────────────────────────────────────────────────────

class KpiIntelligence:
    """
    Singleton que carga y expone la inteligencia del sistema:
      - 109 KPIs con sus alias (loading_brain_v1.json)
      - Reglas de validación (BLK, TRI, WRN)
      - Innegociables
    """

    def __init__(self) -> None:
        with _BRAIN_PATH.open(encoding="utf-8") as fh:
            brain = json.load(fh)

        self.metrics: list[dict]           = brain["metrics"]
        self.innegociables: list[dict]     = brain["innegociables"]
        self.validation_rules: list[dict]  = brain["validation_rules"]

        # Alias lookup: normalized_alias → metric dict
        self._alias_index: dict[str, dict] = {}
        for m in self.metrics:
            for alias in m.get("aliases", []):
                key = _normalize_text(alias)
                if key not in self._alias_index:
                    self._alias_index[key] = m
            # Also index the display_name and metric_id directly
            for fallback in (m["display_name"], m["metric_id"]):
                key = _normalize_text(fallback)
                if key not in self._alias_index:
                    self._alias_index[key] = m

        # Pre-built list of (normalized_alias, metric) for fuzzy scan
        self._alias_pairs: list[tuple[str, dict]] = list(self._alias_index.items())

        # Innegociable metric_ids as a set for O(1) lookup
        self._innegociable_ids: set[str] = {i["metric_id"] for i in self.innegociables}

    def lookup(
        self, text: str, fuzzy_threshold: float = 0.85
    ) -> Optional[tuple[dict, MatchType, float]]:
        """
        Busca un KPI para un texto dado.

        Estrategia (en orden de prioridad):
          1. Exact match (normalized).
          2. Token-sort match: ordena palabras alfabéticamente antes de comparar,
             lo que resuelve variaciones de orden ("Ventas Totales" = "Total Ventas").
          3. Fuzzy match con SequenceMatcher ≥ fuzzy_threshold.

        Pre-procesamiento: se eliminan anotaciones entre paréntesis del texto
        de entrada (ej. "EBITDA (Consolidated)" → "EBITDA", "LTV/CAC (x)" → "LTV/CAC")
        para mejorar el match sin tocar los alias almacenados.

        Returns (metric_dict, match_type, score) o None si no hay match.
        """
        if not text or not text.strip():
            return None

        # Eliminar anotaciones entre paréntesis antes de normalizar
        text = re.sub(r"\s*\([^)]*\)", "", text).strip() or text

        norm      = _normalize_text(text)
        norm_sort = " ".join(sorted(norm.split()))

        # Exact (post-normalization)
        if norm in self._alias_index:
            return self._alias_index[norm], "normalized", 1.0

        # Fuzzy — compare both the raw-normalized and the token-sorted form
        best_score = 0.0
        best_metric: Optional[dict] = None
        for alias_norm, metric in self._alias_pairs:
            alias_sort = " ".join(sorted(alias_norm.split()))
            score = max(
                SequenceMatcher(None, norm, alias_norm).ratio(),
                SequenceMatcher(None, norm_sort, alias_sort).ratio(),
            )
            if score > best_score:
                best_score = score
                best_metric = metric

        if best_score >= fuzzy_threshold and best_metric is not None:
            return best_metric, "fuzzy", best_score

        return None

    def get_validation_rule(self, rule_id: str) -> Optional[dict]:
        for r in self.validation_rules:
            if r["rule_id"] == rule_id:
                return r
        return None


_intel: Optional[KpiIntelligence] = None


def load_kpi_intelligence() -> KpiIntelligence:
    """Carga (o devuelve desde caché) la inteligencia de KPIs."""
    global _intel
    if _intel is None:
        _intel = KpiIntelligence()
        logger.info(
            "KPI Intelligence cargada: %d métricas, %d alias únicos",
            len(_intel.metrics),
            len(_intel._alias_index),
        )
    return _intel


# ── Text utilities ─────────────────────────────────────────────────────────────

def _normalize_text(text: str) -> str:
    """
    Normalización para matching robusto de alias:
      - NFD decompose → eliminar diacríticos (tildes, ñ → n, etc.)
      - Lowercase
      - Reemplazar no-alfanuméricos por espacio
      - Colapsar espacios múltiples
    """
    text = unicodedata.normalize("NFD", str(text))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# ── Company name normalizer ─────────────────────────────────────────────────────

def normalize_company_name(name: Any) -> str:
    """
    Normaliza un nombre de empresa para comparaciones tolerantes a typos.

    Aplica: cast a str → strip → lowercase → elimina caracteres no-alfanuméricos.
    Usar en ambos lados de cualquier comparación nombre-empresa para garantizar
    que 'QUNIO', 'Quinio', 'quinio sa' y 'QUINIO S.A.' sean equivalentes.

    Ejemplo:
        normalize_company_name("QUNIO")  →  "qunio"
        normalize_company_name("Quinio") →  "quinio"
        normalize_company_name(None)     →  ""
    """
    import re as _re
    return _re.sub(r"[^a-z0-9]", "", str(name).strip().lower())


# ── Numeric parser ─────────────────────────────────────────────────────────────

def _parse_numeric(raw: Any) -> tuple[Optional[float], Optional[str]]:
    """
    Convierte una celda a (valor_float, unidad).
    Maneja: "$9.7M", "36%", "1,200,000", "-0.74", celdas float de pandas.

    Returns (None, None) si no es parseable.
    """
    if raw is None:
        return None, None
    if isinstance(raw, (int, float)):
        import math
        if math.isnan(raw):
            return None, None
        return float(raw), None

    s = str(raw).strip()
    if s.lower() in ("", "null", "n/a", "---", "none", "#n/a", "#ref!", "#div/0!"):
        return None, None

    is_negative = s.startswith("-")
    s = s.lstrip("+-")

    unit: Optional[str] = None
    if "%" in s:
        unit = "%"
        s = s.replace("%", "")
    elif "$" in s:
        unit = "$"
        s = s.replace("$", "")

    multiplier = 1.0
    upper = s.upper()
    if upper.endswith("B"):
        multiplier, s, unit = 1e9, s[:-1], (unit or "") + "B"
    elif upper.endswith("M"):
        multiplier, s, unit = 1e6, s[:-1], (unit or "") + "M"
    elif upper.endswith("K"):
        multiplier, s, unit = 1e3, s[:-1], (unit or "") + "K"

    s = s.replace(",", "").strip()
    try:
        value = float(s) * multiplier
        return (-value if is_negative else value), unit
    except ValueError:
        return None, None


# ── Period header parsing ──────────────────────────────────────────────────────

_MONTH_MAP: dict[str, int] = {
    # Spanish abbreviated
    "ene": 1, "abr": 4, "ago": 8, "dic": 12,
    # Spanish full
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6,
    "julio": 7, "agosto": 8, "septiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
    # English abbreviated
    "jan": 1, "apr": 4, "aug": 8, "dec": 12,
    # English full
    "january": 1, "february": 2, "march": 3, "april": 4, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    # Shared abbrs (same value in ES/EN)
    "feb": 2, "mar": 3, "may": 5, "jun": 6, "jul": 7, "sep": 9, "oct": 10, "nov": 11,
}


def _build_period_id(year: int, month: int) -> str:
    """Construye el period_id canónico: P{YYYY}Q{Q}M{MM}."""
    quarter = (month - 1) // 3 + 1
    return f"P{year}Q{quarter}M{month:02d}"


def _parse_period_header(raw: Any) -> Optional[str]:
    """
    Convierte un header de columna al period_id canónico (ej. "P2025Q1M01").

    Soporta cualquier tipo que llegue desde pandas:
      - datetime.datetime, pd.Timestamp, numpy.datetime64
      - "2025-01", "2025/01", "01/2025"
      - "2025-03-01", "2025-03-01 00:00:00" (Excel dtype=object con hora)
      - "Jan 2025", "Ene 2025", "January 2025", "Enero 2025"
      - "2025-Jan", "2025 enero"

    Blindaje total: nunca llama .strip() sobre un objeto no-string.
    pd.Timestamp() es el punto de entrada nuclear para TODO lo que sea
    datetime-like, incluyendo openpyxl date objects.
    """
    if raw is None:
        return None

    # ── PASO 1: blindaje datetime — pd.Timestamp() maneja TODOS los tipos
    # datetime.datetime, pd.Timestamp, numpy.datetime64, strings ISO con hora.
    # Si falla (ej. "Jan 2025"), cae al bloque de strings.
    try:
        ts = pd.Timestamp(raw)
        if not pd.isna(ts):
            yr, mo = int(ts.year), int(ts.month)
            if 2000 <= yr <= 2099 and 1 <= mo <= 12:
                return _build_period_id(yr, mo)
    except Exception:
        pass

    # ── PASO 2: cast forzado a string — sin importar el tipo recibido
    try:
        s = str(raw).strip().lower()
    except Exception:
        return None

    if not s or s in ("nan", "none", "null", "nat", ""):
        return None

    # "2025-01-15 00:00:00" / "2025-01-15T00:00:00" residuales no capturados arriba
    m = re.match(r"^(20\d{2})[-/](0?[1-9]|1[0-2])[-/]\d{1,2}[T ]", s)
    if m:
        return _build_period_id(int(m.group(1)), int(m.group(2)))

    # "2025-01", "2025/01", or "2025-01-15" (YYYY-MM-DD)
    m = re.match(r"^(20\d{2})[-/](0?[1-9]|1[0-2])(?:[-/]\d{1,2})?$", s)
    if m:
        return _build_period_id(int(m.group(1)), int(m.group(2)))

    # "01/2025" or "01-2025"
    m = re.match(r"^(0?[1-9]|1[0-2])[-/](20\d{2})$", s)
    if m:
        return _build_period_id(int(m.group(2)), int(m.group(1)))

    # "jan 2025" / "enero 2025" / "january 2025"
    m = re.match(r"^([a-z\u00e0-\u00ff]+)\s+(20\d{2})$", s)
    if m:
        month_num = _MONTH_MAP.get(m.group(1))
        if month_num:
            return _build_period_id(int(m.group(2)), month_num)

    # "2025 jan" / "2025 enero"
    m = re.match(r"^(20\d{2})\s+([a-z\u00e0-\u00ff]+)$", s)
    if m:
        month_num = _MONTH_MAP.get(m.group(2))
        if month_num:
            return _build_period_id(int(m.group(1)), month_num)

    return None


# ── File loader ────────────────────────────────────────────────────────────────

def _load_file(file_path: Path) -> pd.DataFrame:
    """
    Carga Excel (.xlsx/.xls) o CSV en un DataFrame crudo.

    Usa dtype=object (no dtype=str) para que openpyxl entregue celdas de fecha
    como datetime.datetime en lugar de intentar convertirlas a string, lo que
    en algunas versiones de pandas/openpyxl produce resultados inconsistentes.
    _parse_period_header está blindado para manejar cualquier tipo.
    """
    suffix = file_path.suffix.lower()
    if suffix in (".xlsx", ".xls"):
        return pd.read_excel(file_path, header=None, dtype=object, engine="openpyxl")
    if suffix == ".csv":
        return pd.read_csv(file_path, header=None, dtype=str)
    raise ValueError(f"Formato no soportado: {suffix}. Use .xlsx, .xls o .csv")


# ── Core scanner ───────────────────────────────────────────────────────────────

def _extract_most_recent_numeric(series: pd.Series) -> tuple[Any, Optional[float], Optional[str]]:
    """
    De una serie pandas, devuelve la última celda con valor numérico válido
    junto con su parse. Preferimos el último valor para tomar el período más reciente.
    """
    for raw in reversed(series.tolist()):
        num, unit = _parse_numeric(raw)
        if num is not None:
            return raw, num, unit
    return None, None, None


def _scan_dataframe(
    df: pd.DataFrame,
    intel: KpiIntelligence,
    fuzzy_threshold: float = 0.85,
) -> list[ExtractedKpi]:
    """
    Estrategia dual de escaneo:

    MODO A — Headers como KPIs (formato ancho v2):
        Fila 0 contiene nombres de KPIs; cada columna = un KPI.
        Valores en filas subsiguientes (tomamos el más reciente).

    MODO B — Índice como KPIs (formato P&L clásico):
        Columna 0 contiene nombres de KPIs; cada fila = un KPI.
        Valores en columnas subsiguientes (tomamos el más reciente).

    Ambos modos corren en paralelo; el resultado se deduplica por kpi_ref
    conservando el match de mayor score.
    """
    found: dict[str, ExtractedKpi] = {}  # kpi_ref → mejor match

    def _register(
        metric: dict,
        match_type: MatchType,
        score: float,
        source_label: str,
        raw_value: Any,
    ) -> None:
        num, unit = _parse_numeric(raw_value)
        ref = metric["kpi_ref"]
        existing = found.get(ref)
        if existing is None or score > existing.match_score:
            found[ref] = ExtractedKpi(
                kpi_ref=ref,
                metric_id=metric["metric_id"],
                display_name=metric["display_name"],
                raw_value=raw_value,
                numeric_value=num,
                unit=unit or metric.get("unit"),
                source_label=source_label,
                match_type=match_type,
                match_score=score,
            )

    # ── MODO A: fila 0 como headers ───────────────────────────────────────
    for col_idx in range(df.shape[1]):
        header_cell = df.iloc[0, col_idx]
        if pd.isna(header_cell) or str(header_cell).strip() == "":
            continue
        result = intel.lookup(str(header_cell), fuzzy_threshold)
        if result is None:
            continue
        metric, match_type, score = result
        # Extraer valor más reciente de las filas siguientes
        col_values = df.iloc[1:, col_idx]
        raw, num, unit = _extract_most_recent_numeric(col_values)
        if num is not None:
            _register(metric, match_type, score, str(header_cell), raw)

    # ── MODO B: columna 0 como índice ─────────────────────────────────────
    for row_idx in range(df.shape[0]):
        index_cell = df.iloc[row_idx, 0]
        if pd.isna(index_cell) or str(index_cell).strip() == "":
            continue
        result = intel.lookup(str(index_cell), fuzzy_threshold)
        if result is None:
            continue
        metric, match_type, score = result
        # Extraer valor más reciente de las columnas siguientes
        row_values = df.iloc[row_idx, 1:]
        raw, num, unit = _extract_most_recent_numeric(row_values)
        if num is not None:
            _register(metric, match_type, score, str(index_cell), raw)

    return list(found.values())


# ── Validation engine ──────────────────────────────────────────────────────────

def _run_validations(
    found: list[ExtractedKpi],
    intel: KpiIntelligence,
    sector: str,
    prev_cash: Optional[float],
    prev_burn: Optional[float],
) -> list[ValidationFlag]:
    """
    Aplica todas las reglas de validación del loading_brain_v1.json.

    Reglas activas:
      BLK-001 — Innegociables faltantes (HARD BLOCK)
      TRI-001 — Gross Profit <= Revenue  (physics check)
      TRI-002 — EBITDA <= Gross Profit   (physics check)
      TRI-003 — Cash consistency (15% tolerancia)
      TRI-004 — Net Income ≈ Burn (30% tolerancia)
      TRI-005 — ARR = MRR × 12 (solo SaaS)
      WRN-001 — Cobertura < 60%
    """
    flags: list[ValidationFlag] = []
    kpi_map: dict[str, float] = {
        e.metric_id: e.numeric_value
        for e in found
        if e.numeric_value is not None
    }

    # ── BLK-001: Innegociables ─────────────────────────────────────────────
    # ebitda y burn: si faltan, la carga llega a Staging con NEEDS_REVISION
    # para que el Analista los complete. El resto de innegociables siguen bloqueando.
    _SOFT_BLOCK_IDS: frozenset[str] = frozenset({"ebitda", "burn"})

    is_saas = "SAAS" in sector.upper()
    for inn in intel.innegociables:
        mid   = inn["metric_id"]
        scope = inn["sector"]
        # MRR solo es innegociable para SaaS
        if mid == "mrr" and not is_saas:
            continue
        if mid not in kpi_map:
            soft = mid in _SOFT_BLOCK_IDS
            flags.append(ValidationFlag(
                rule_id="BLK-001",
                severity="HIGH" if soft else "CRITICAL",
                message=(
                    f"KPI innegociable ausente: '{inn['kpi_ref']} - {mid.upper()}'. "
                    + (
                        "Los datos se envían a Staging con estado NEEDS_REVISION "
                        "para revisión del Analista."
                        if soft else
                        "La carga está BLOQUEADA."
                    )
                ),
                action="SET_STATUS=NEEDS_REVISION" if soft else "BLOCK_SUBMISSION",
                block_submission=not soft,
                flag_review=soft,
            ))

    # ── TRI-001: Gross Profit <= Revenue ──────────────────────────────────
    revenue      = kpi_map.get("revenue")
    gross_profit = kpi_map.get("gross_profit")
    if revenue is not None and gross_profit is not None and revenue > 0:
        tolerance = 0.01
        if gross_profit > revenue * (1 + tolerance):
            flags.append(ValidationFlag(
                rule_id="TRI-001",
                severity="CRITICAL",
                message=(
                    f"Gross Profit ({gross_profit:,.0f}) supera Revenue "
                    f"({revenue:,.0f}). Violación física imposible."
                ),
                action="FLAG physics_violation=TRUE + SHOW_ALERT",
                block_submission=False,
                flag_review=True,
            ))

    # ── TRI-002: EBITDA <= Gross Profit ───────────────────────────────────
    ebitda = kpi_map.get("ebitda")
    if ebitda is not None and gross_profit is not None:
        if ebitda > gross_profit:
            flags.append(ValidationFlag(
                rule_id="TRI-002",
                severity="CRITICAL",
                message=(
                    f"EBITDA ({ebitda:,.0f}) supera Gross Profit "
                    f"({gross_profit:,.0f}). EBITDA = GP - OpEx, siempre ≤ GP."
                ),
                action="FLAG physics_violation=TRUE + SHOW_ALERT",
                block_submission=False,
                flag_review=True,
            ))

    # ── TRI-003: Cash Consistency ─────────────────────────────────────────
    cash_t = kpi_map.get("cash")
    burn_t = kpi_map.get("burn")

    if cash_t is not None and prev_cash is not None and burn_t is not None:
        expected_cash = prev_cash + burn_t
        if prev_cash != 0:
            delta_pct = abs(cash_t - expected_cash) / abs(prev_cash)
            tolerance = 0.15
            if delta_pct > tolerance:
                flags.append(ValidationFlag(
                    rule_id="TRI-003",
                    severity="HIGH",
                    message=(
                        f"Cash Consistency (TRI-003): "
                        f"Cash({cash_t:,.0f}) vs esperado Cash(t-1)+Burn "
                        f"({expected_cash:,.0f}). "
                        f"Desviacion: {delta_pct:.1%} (limite 15%). "
                        "Se requiere justificacion."
                    ),
                    action="FLAG flag_review=TRUE + REQUEST_EXPLANATION",
                    block_submission=False,
                    flag_review=True,
                ))

    # ── TRI-004: Net Income ≈ Burn (30% tolerancia) ────────────────────────
    net_income = kpi_map.get("net_income")
    if net_income is not None and burn_t is not None and burn_t != 0:
        delta_pct = abs(net_income - burn_t) / abs(burn_t)
        if delta_pct > 0.30:
            flags.append(ValidationFlag(
                rule_id="TRI-004",
                severity="MEDIUM",
                message=(
                    f"Net Income ({net_income:,.0f}) difiere de Burn "
                    f"({burn_t:,.0f}) en {delta_pct:.1%} (límite 30%). "
                    "Revisar D&A y variaciones de capital de trabajo."
                ),
                action="FLAG flag_review=TRUE",
                block_submission=False,
                flag_review=True,
            ))

    # ── TRI-005: ARR = MRR × 12 (SaaS) ───────────────────────────────────
    if is_saas:
        arr = kpi_map.get("arr")
        mrr = kpi_map.get("mrr")
        if arr is not None and mrr is not None and arr != 0:
            expected_arr = mrr * 12
            delta_pct = abs(arr - expected_arr) / abs(arr)
            if delta_pct > 0.01:
                flags.append(ValidationFlag(
                    rule_id="TRI-005",
                    severity="HIGH",
                    message=(
                        f"ARR ({arr:,.0f}) ≠ MRR×12 ({expected_arr:,.0f}). "
                        f"Desviación: {delta_pct:.1%}. ARR será recalculado automáticamente."
                    ),
                    action="RECALCULATE_ARR + FLAG flag_review=TRUE",
                    block_submission=False,
                    flag_review=True,
                ))

    # ── WRN-001: Cobertura baja ────────────────────────────────────────────
    total_kpis  = len(intel.metrics)
    found_count = len(found)
    coverage    = found_count / total_kpis if total_kpis > 0 else 0.0
    if coverage < 0.60:
        flags.append(ValidationFlag(
            rule_id="WRN-001",
            severity="LOW",
            message=(
                f"Cobertura baja: {found_count}/{total_kpis} KPIs encontrados "
                f"({coverage:.0%}). Se recomienda al menos 60%."
            ),
            action="SHOW_WARNING",
            block_submission=False,
            flag_review=False,
        ))

    return flags


# ── Public API ─────────────────────────────────────────────────────────────────

def map_uploaded_file(
    file_path: str | Path,
    sector: str = "ALL",
    prev_cash: Optional[float] = None,
    prev_burn: Optional[float] = None,
    fuzzy_threshold: float = 0.85,
) -> MappingResult:
    """
    Motor de Mapeo principal — procesa un archivo Excel/CSV de un Founder.

    Parameters
    ----------
    file_path       : Ruta al archivo (.xlsx, .xls, .csv).
    sector          : Vertical de la empresa (e.g. "SAAS_SUBSCRIPTION", "ALL").
    prev_cash       : Cash del período anterior para TRI-003 (opcional).
    prev_burn       : Burn del período anterior (no usado, reservado para TRI-004 futuro).
    fuzzy_threshold : Score mínimo para match difuso (0.0–1.0, default 0.85).

    Returns
    -------
    MappingResult con found, missing_kpis, innegociables_missing,
    validation_flags, coverage_pct y can_submit.
    """
    path  = Path(file_path)
    intel = load_kpi_intelligence()

    logger.info("Iniciando mapeo: %s | sector=%s", path.name, sector)

    # 1. Cargar archivo
    df = _load_file(path)
    logger.debug("Archivo cargado: %d filas × %d columnas", *df.shape)

    # 2. Escanear y extraer KPIs
    found = _scan_dataframe(df, intel, fuzzy_threshold)
    logger.info("KPIs encontrados: %d", len(found))

    # 2b. Derivar Burn si viene vacío pero hay EBITDA disponible
    #   Fórmula preferida : Burn = EBITDA − D&A
    #   Proxy de emergencia: Burn = EBITDA  (cuando no hay D&A)
    _found_ids = {e.metric_id for e in found}
    if "burn" not in _found_ids:
        _ebitda = next((e for e in found if e.metric_id == "ebitda"), None)
        if _ebitda is not None and _ebitda.numeric_value is not None:
            _da = next(
                (e for e in found if e.metric_id in ("depreciation", "da", "depreciation_amortization")),
                None,
            )
            if _da is not None and _da.numeric_value is not None:
                _burn_val = _ebitda.numeric_value - _da.numeric_value
                _burn_src = f"derivado: EBITDA ({_ebitda.numeric_value:,.0f}) − D&A ({_da.numeric_value:,.0f})"
            else:
                _burn_val = _ebitda.numeric_value
                _burn_src = f"proxy: EBITDA ({_ebitda.numeric_value:,.0f}) — D&A no disponible"

            _burn_meta = next((m for m in intel.metrics if m["metric_id"] == "burn"), None)
            if _burn_meta:
                found.append(ExtractedKpi(
                    kpi_ref=_burn_meta["kpi_ref"],
                    metric_id="burn",
                    display_name=_burn_meta["display_name"],
                    raw_value=_burn_val,
                    numeric_value=_burn_val,
                    unit=_burn_meta.get("unit"),
                    source_label=_burn_src,
                    match_type="derived",
                    match_score=1.0,
                ))
                logger.info("[BurnDerivado] %s → %.0f", _burn_src, _burn_val)

    # 3. Calcular gaps
    found_refs   = {e.kpi_ref for e in found}
    missing_kpis = [
        {
            "kpi_ref":      m["kpi_ref"],
            "metric_id":    m["metric_id"],
            "display_name": m["display_name"],
            "innegociable": m.get("innegociable", False),
            "priority_tier": m.get("priority_tier", 3),
        }
        for m in intel.metrics
        if m["kpi_ref"] not in found_refs
    ]

    # Determinar innegociables ausentes (sector-aware para MRR)
    is_saas = "SAAS" in sector.upper()
    innegociables_missing = [
        m for m in missing_kpis
        if m["innegociable"]
        and not (m["metric_id"] == "mrr" and not is_saas)
    ]

    # 4. Validaciones
    # Burn se toma del período actual si fue extraído; si no, usamos prev_burn
    extracted_burn = next(
        (e.numeric_value for e in found if e.metric_id == "burn"), None
    )
    effective_burn = extracted_burn if extracted_burn is not None else prev_burn

    flags = _run_validations(found, intel, sector, prev_cash, effective_burn)

    # 5. Determinar si se puede enviar
    can_submit = not any(f.block_submission for f in flags)

    # 6. Coverage
    total       = len(intel.metrics)
    coverage    = len(found) / total if total > 0 else 0.0

    result = MappingResult(
        found=sorted(found, key=lambda e: e.kpi_ref),
        missing_kpis=sorted(missing_kpis, key=lambda m: m["priority_tier"]),
        innegociables_missing=innegociables_missing,
        validation_flags=flags,
        coverage_pct=round(coverage * 100, 1),
        can_submit=can_submit,
    )

    _log_summary(result)
    return result


# ── Normalización de nombres de empresa ───────────────────────────────────────
# Elimina sufijos legales, acentos y puntuación antes de comparar, para que
# "Ecro Capital SAPI de CV" y "ecro capital" sean equivalentes.

import re as _re_company
import unicodedata as _ud

_LEGAL_SUFFIXES_RE = _re_company.compile(
    r"\b("
    r"s\.?a\.?p\.?i\.?|s\.?a\.?b\.?|s\.?a\.?|s\.?r\.?l\.?|"
    r"de\s+c\.?v\.?|de\s+r\.?l\.?|s\s+de\s+r\.?l\.?|"
    r"inc\.?|llc\.?|ltd\.?|corp\.?|gmbh|plc\.?"
    r")\b",
    _re_company.IGNORECASE,
)


def _norm_company_name(name: str) -> str:
    """
    Normaliza un nombre de empresa para comparación fuzzy:
      1. Quita acentos (NFD → filtrar Mn).
      2. Minúsculas.
      3. Elimina sufijos legales comunes.
      4. Reemplaza puntuación por espacio, colapsa espacios.
    """
    # 1. Acentos
    nfd = _ud.normalize("NFD", name)
    name = "".join(c for c in nfd if _ud.category(c) != "Mn")
    # 2. Minúsculas
    name = name.lower()
    # 3. Sufijos legales
    name = _LEGAL_SUFFIXES_RE.sub(" ", name)
    # 4. Puntuación → espacio, colapsar
    name = _re_company.sub(r"[^a-z0-9]", " ", name)
    return _re_company.sub(r"\s+", " ", name).strip()


def detect_company_and_year_from_df(
    df: "pd.DataFrame",
    company_catalog: "list[dict] | None" = None,
) -> dict:
    """
    Escanea un DataFrame ya cargado para extraer identidad de empresa y año.

    Parámetros
    ----------
    df              : DataFrame cargado con header=None (primeras ~20 filas).
    company_catalog : Lista de dicts con al menos 'company_id' y 'company_name'
                      proveniente de dim_company (vía BQDataService.get_portfolio_catalog).
                      Si se omite, solo se usan los fingerprints estáticos como fallback.

    Estrategia de empresa
    ---------------------
    1. Extrae los textos no-nulos de las primeras 5 filas × 6 columnas.
    2. Para cada texto y cada empresa del catálogo:
       a. Substring exacto normalizado (mayor prioridad).
       b. SequenceMatcher ratio > 0.65 (fuzzy, menor prioridad).
    3. Devuelve el match con mayor score.

    Estrategia de año
    -----------------
    Busca el primer patrón r'\\b(20[2-3]\\d)\\b' en:
      (a) nombres de columna del DataFrame.
      (b) valores de las primeras 5 filas × 10 columnas.

    Returns dict con claves:
      company_id   : str | None
      company_name : str | None
      bucket_id    : str | None
      year         : int | None
    """
    from difflib import SequenceMatcher as _SM

    _YEAR_RE = _re_company.compile(r"\b(20[2-3]\d)\b")

    result: dict = {
        "company_id":   None,
        "company_name": None,
        "bucket_id":    None,
        "year":         None,
    }

    # ── Construir índice normalizado del catálogo ─────────────────────────────
    # Cada entrada: (norm_name, original_entry_dict)
    catalog_index: list[tuple[str, dict]] = []
    if company_catalog:
        for entry in company_catalog:
            raw_name = str(entry.get("company_name") or "").strip()
            if raw_name:
                catalog_index.append((_norm_company_name(raw_name), entry))

    # ── Recoger textos candidatos de las primeras filas del Excel ─────────────
    scan_rows = min(5, df.shape[0])
    scan_cols = min(6, df.shape[1])
    cell_texts: list[tuple[str, int, int]] = []  # (norm_text, row, col)
    for r in range(scan_rows):
        for c in range(scan_cols):
            cell = df.iloc[r, c]
            if pd.isna(cell):
                continue
            raw = str(cell).strip()
            if len(raw) < 3:
                continue
            cell_texts.append((_norm_company_name(raw), r, c))

    # ── Matching ──────────────────────────────────────────────────────────────
    best_score = 0.0
    best_entry: dict | None = None
    best_coords = (0, 0)

    for norm_cell, r, c in cell_texts:
        if not norm_cell:
            continue
        for norm_name, entry in catalog_index:
            if not norm_name:
                continue
            # Substring match (score 1.0)
            if norm_name in norm_cell or norm_cell in norm_name:
                score = 1.0
            else:
                score = _SM(None, norm_cell, norm_name).ratio()
            if score > best_score and score >= 0.65:
                best_score = score
                best_entry = entry
                best_coords = (r, c)

    if best_entry:
        result["company_id"]   = best_entry.get("company_id")
        result["company_name"] = best_entry.get("company_name")
        result["bucket_id"]    = best_entry.get("bucket_id")
        logger.info(
            "[CompanyDetect] '%s' → %s (score=%.2f) en celda [%d,%d]",
            best_entry.get("company_name"), result["company_id"],
            best_score, *best_coords,
        )
    else:
        logger.info("[CompanyDetect] Ninguna empresa identificada en las primeras filas del Excel.")

    # ── Año ──────────────────────────────────────────────────────────────────
    # (a) nombres de columna
    for col in df.columns:
        m = _YEAR_RE.search(str(col))
        if m:
            result["year"] = int(m.group(1))
            logger.info("[YearDetect] Año %s en columna '%s'", m.group(1), col)
            break

    # (b) valores de primeras filas
    if result["year"] is None:
        for r in range(min(5, df.shape[0])):
            for c in range(min(10, df.shape[1])):
                cell = df.iloc[r, c]
                if pd.isna(cell):
                    continue
                m = _YEAR_RE.search(str(cell))
                if m:
                    result["year"] = int(m.group(1))
                    logger.info("[YearDetect] Año %s en celda [%d,%d]", m.group(1), r, c)
                    break
            if result["year"]:
                break

    return result


def detect_company_from_excel(file_path: "str | Path") -> dict[str, str] | None:
    """
    Compatibilidad: carga el archivo y delega a detect_company_and_year_from_df.
    Retorna solo el dict de identidad (company_id, bucket_id) o None.
    """
    try:
        df = pd.read_excel(Path(file_path), header=None, nrows=15, dtype=object)
    except Exception:
        return None
    info = detect_company_and_year_from_df(df)
    if info["company_id"]:
        return {"company_id": info["company_id"], "bucket_id": info.get("bucket_id", "")}
    return None


def extract_master_db_to_staging_rows(
    file_path: "str | Path",
    fuzzy_threshold: float = 0.85,
) -> list[dict]:
    """
    Extrae KPIs de un Excel en formato Master Database:
      - Columna 0   : nombres de métricas (se mapean al catálogo de 109 KPIs)
      - Columnas 1+ : valores por período (header = mes/año → period_id canónico)

    Hace el "unpivot" completo: cada celda (métrica × mes) se convierte en
    una fila independiente con metric_id, period_id y value, lista para
    insertarse en fact_kpi_staging.

    Parameters
    ----------
    file_path       : Ruta al archivo (.xlsx, .xls, .csv).
    fuzzy_threshold : Score mínimo de similitud para el mapeo de alias.

    Returns
    -------
    Lista de dicts con: metric_id, period_id, value, source_label,
    match_type, match_score.  Lista vacía si no se detectan columnas
    de período (el caller debe hacer fallback al extractor estándar).
    """
    path  = Path(file_path)
    intel = load_kpi_intelligence()
    df    = _load_file(path)

    # ── DIAGNÓSTICO: primeras filas del Excel para detectar estructura ────────
    print(f"[MasterDB][DIAG] Archivo: {path.name} | shape={df.shape}")
    print(f"[MasterDB][DIAG] Fila 0 (tipos): {[type(df.iloc[0, c]).__name__ for c in range(min(df.shape[1], 10))]}")
    print(f"[MasterDB][DIAG] Fila 0 (valores): {[str(df.iloc[0, c]) for c in range(min(df.shape[1], 10))]}")

    if df.shape[0] < 2 or df.shape[1] < 2:
        return []

    # Buscar la fila de headers de período (primera fila con ≥2 celdas
    # reconocibles como mes/año dentro de las primeras 20 filas).
    # Las filas de encabezado legal (nombre de empresa, fechas únicas, NaN)
    # se saltan hasta encontrar la fila que tiene ≥2 períodos consecutivos.
    header_row_idx: Optional[int] = None
    period_cols: list[tuple[int, str]] = []   # (col_idx, period_id)

    for row_idx in range(min(20, df.shape[0])):
        first_cell = df.iloc[row_idx, 0]
        # Saltar fila si la primera celda está vacía (filas de padding superior)
        if pd.isna(first_cell) or not str(first_cell).strip():
            continue
        cands: list[tuple[int, str]] = []
        for col_idx in range(1, df.shape[1]):
            raw = df.iloc[row_idx, col_idx]
            if pd.isna(raw):
                continue
            pid = _parse_period_header(raw)
            if pid:
                cands.append((col_idx, pid))
        if len(cands) >= 2:
            header_row_idx = row_idx
            period_cols = cands
            break

    if not period_cols:
        logger.info(
            "[MasterDB] Sin columnas de período en '%s' — fallback a extractor estándar.",
            path.name,
        )
        return []

    logger.info(
        "[MasterDB] Header en fila %d, %d períodos detectados en '%s'",
        header_row_idx, len(period_cols), path.name,
    )

    rows: list[dict] = []
    for row_idx in range(df.shape[0]):
        if row_idx == header_row_idx:
            continue
        metric_cell = df.iloc[row_idx, 0]
        if pd.isna(metric_cell) or not str(metric_cell).strip():
            continue
        result = intel.lookup(str(metric_cell), fuzzy_threshold)
        if result is None:
            continue
        metric, match_type, score = result

        for col_idx, period_id in period_cols:
            raw = df.iloc[row_idx, col_idx]
            num, _ = _parse_numeric(raw)
            if num is None:
                continue
            rows.append({
                "metric_id":    metric["metric_id"],
                "period_id":    period_id,
                "value":        num,
                "source_label": str(metric_cell).strip(),
                "match_type":   match_type,
                "match_score":  score,
            })

    logger.info("[MasterDB] %d filas brutas extraídas de '%s'", len(rows), path.name)

    # ── Dedup: una única verdad por (metric_id, period_id) ────────────────────
    # Prioridad 1: filas cuya source_label contiene "consolidado" o "total"
    # Prioridad 2: primera aparición en el Excel (orden natural del archivo)
    _PRIORITY_LABELS = ("consolidado", "total", "consolidated")
    seen: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (row["metric_id"], row["period_id"])
        if key not in seen:
            seen[key] = row
        else:
            label = row["source_label"].lower()
            if any(p in label for p in _PRIORITY_LABELS):
                seen[key] = row  # reemplazar con la versión "consolidado/total"

    deduped = list(seen.values())
    if len(deduped) < len(rows):
        logger.info(
            "[MasterDB] Dedup: %d → %d filas (eliminados %d duplicados)",
            len(rows), len(deduped), len(rows) - len(deduped),
        )
    return deduped


def extract_long_format_to_staging_rows(
    file_path: "str | Path",
    fuzzy_threshold: float = 0.85,
) -> list[dict]:
    """
    Extrae KPIs de un CSV/Excel en formato long/tidy (una fila por métrica × período).

    Compatible con la Master DB exportada desde Cometa:
      company_name, metric_name, period, value, ...

    Detecta automáticamente las columnas relevantes buscando nombres conocidos
    (metric_name/metric/kpi, period/periodo/date, value/valor).

    Parameters
    ----------
    file_path       : Ruta al archivo (.xlsx, .xls, .csv).
    fuzzy_threshold : Score mínimo de similitud para el mapeo de alias.

    Returns
    -------
    Lista de dicts con: metric_id, period_id, value, source_label,
    match_type, match_score.  Lista vacía si no se detectan las columnas clave.
    """
    path  = Path(file_path)
    intel = load_kpi_intelligence()

    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xls"):
        # dtype=object: evita que pandas/openpyxl convierta celdas de fecha a
        # strings de forma inconsistente. Las celdas datetime se manejan en
        # _parse_period_header vía pd.Timestamp().
        df = pd.read_excel(path, header=0, dtype=object, engine="openpyxl")
    else:
        df = pd.read_csv(path, header=0, dtype=str)

    if df.empty or df.shape[1] < 3:
        return []

    # str(c) obligatorio: df.columns puede contener datetime.datetime cuando
    # openpyxl lee cabeceras de fecha — c.strip() sin cast lanza AttributeError.
    cols_lower: dict[str, str] = {str(c).strip().lower(): c for c in df.columns}

    _METRIC_KEYS   = ("metric_name", "metric", "kpi", "nombre_metrica", "indicador")
    _PERIOD_KEYS   = ("period", "periodo", "date", "fecha", "month", "mes")
    _VALUE_KEYS    = ("value", "valor", "amount", "monto", "importe")
    _COMPANY_KEYS  = ("company", "company_name", "empresa", "startup", "portafolio")

    metric_col  = next((cols_lower[k] for k in _METRIC_KEYS  if k in cols_lower), None)
    period_col  = next((cols_lower[k] for k in _PERIOD_KEYS  if k in cols_lower), None)
    value_col   = next((cols_lower[k] for k in _VALUE_KEYS   if k in cols_lower), None)
    company_col = next((cols_lower[k] for k in _COMPANY_KEYS if k in cols_lower), None)

    if company_col:
        logger.info("[LongFormat] Columna empresa detectada: '%s'", company_col)

    if not (metric_col and period_col and value_col):
        logger.info(
            "[LongFormat] Columnas clave no encontradas en '%s' "
            "(metric=%s period=%s value=%s) — fallback a extractor wide.",
            path.name, metric_col, period_col, value_col,
        )
        return []

    logger.info(
        "[LongFormat] Columnas: metric='%s', period='%s', value='%s' en '%s'",
        metric_col, period_col, value_col, path.name,
    )

    rows: list[dict] = []
    for _, row in df.iterrows():
        raw_metric  = row[metric_col]
        raw_period  = row[period_col]
        raw_value   = row[value_col]
        raw_company = row[company_col] if company_col else None

        if pd.isna(raw_metric) or not str(raw_metric).strip():
            continue
        if pd.isna(raw_period):
            continue

        # Normalize company name from Excel for any downstream comparisons.
        # Both sides must use normalize_company_name() — never compare raw strings.
        company_norm = normalize_company_name(raw_company) if raw_company is not None else None

        num, _ = _parse_numeric(raw_value)
        if num is None:
            continue

        result = intel.lookup(str(raw_metric).strip(), fuzzy_threshold)
        if result is None:
            continue
        metric, match_type, score = result

        period_id = _parse_period_header(str(raw_period).strip())
        if period_id is None:
            continue

        rows.append({
            "metric_id":        metric["metric_id"],
            "period_id":        period_id,
            "value":            num,
            "source_label":     str(raw_metric).strip(),
            "match_type":       match_type,
            "match_score":      score,
            # Company fields: included if the Excel has a company column.
            # company_name_norm uses normalize_company_name() — safe for BQ resolution.
            "company_name_raw": str(raw_company).strip() if raw_company is not None else None,
            "company_name_norm": company_norm,
        })

    logger.info("[LongFormat] %d filas brutas extraídas de '%s'", len(rows), path.name)

    # ── Dedup: una única verdad por (metric_id, period_id) ────────────────────
    _PRIORITY_LABELS = ("consolidado", "total", "consolidated")
    seen: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (row["metric_id"], row["period_id"])
        if key not in seen:
            seen[key] = row
        else:
            label = row["source_label"].lower()
            if any(p in label for p in _PRIORITY_LABELS):
                seen[key] = row

    deduped = list(seen.values())
    if len(deduped) < len(rows):
        logger.info(
            "[LongFormat] Dedup: %d → %d filas (eliminados %d duplicados)",
            len(rows), len(deduped), len(rows) - len(deduped),
        )
    return deduped


# ── Report printer ─────────────────────────────────────────────────────────────

def _log_summary(result: MappingResult) -> None:
    """Imprime un resumen legible del resultado del mapeo."""
    sep = "-" * 60

    logger.info(sep)
    logger.info("REPORTE DE MAPEO")
    logger.info(sep)

    logger.info(
        "KPIs encontrados (%d):  %s",
        len(result.found),
        ", ".join(f"{e.kpi_ref}({e.metric_id})" for e in result.found[:10])
        + ("…" if len(result.found) > 10 else ""),
    )

    if result.innegociables_missing:
        logger.warning(
            "INNEGOCIABLES AUSENTES (%d): %s",
            len(result.innegociables_missing),
            ", ".join(m["metric_id"] for m in result.innegociables_missing),
        )
    else:
        logger.info("Todos los innegociables presentes.")

    logger.info("Cobertura: %.1f%%", result.coverage_pct)
    logger.info("Puede enviarse: %s", "SI" if result.can_submit else "NO — BLOQUEADO")

    for flag in result.validation_flags:
        level = logging.CRITICAL if flag.block_submission else (
            logging.WARNING if flag.severity in ("CRITICAL", "HIGH") else logging.INFO
        )
        logger.log(level, "[%s] %s", flag.rule_id, flag.message)

    logger.info(sep)


def print_report(result: MappingResult) -> None:
    """
    Imprime el reporte de mapeo en stdout de forma legible para el usuario final.
    Útil para pruebas desde CLI o notebooks.
    """
    sep = "=" * 60
    print(f"\n{sep}")
    print("  REPORTE DE MAPEO - COMETA PIPELINE")
    print(sep)

    estado = "[OK] LISTO PARA ENVIAR" if result.can_submit else "[BLOQUEADO]"
    print(f"\n  Cobertura: {result.coverage_pct}% ({len(result.found)}/109 KPIs)")
    print(f"  Estado:    {estado}\n")

    print("  KPIs ENCONTRADOS:")
    for e in result.found:
        tag = "(fuzzy)" if e.match_type == "fuzzy" else ""
        print(f"    {e.kpi_ref}  {e.display_name:<35}  {e.numeric_value}  {tag}")

    if result.innegociables_missing:
        print("\n  *** INNEGOCIABLES AUSENTES - CARGA BLOQUEADA ***")
        for m in result.innegociables_missing:
            print(f"    {m['kpi_ref']}  {m['display_name']}")

    if result.missing_kpis:
        p1 = [m for m in result.missing_kpis if m["priority_tier"] == 1 and not m["innegociable"]]
        if p1:
            print("\n  KPIs FALTANTES (Prioridad 1, no-innegociables):")
            for m in p1:
                print(f"    {m['kpi_ref']}  {m['display_name']}")

    if result.validation_flags:
        print("\n  ALERTAS DE VALIDACION:")
        for f in result.validation_flags:
            icon = "[BLOCK]" if f.block_submission else ("[WARN]" if f.flag_review else "[INFO]")
            print(f"    {icon} [{f.rule_id}] {f.message}")

    print(f"\n{sep}\n")


# ── Gemini-powered Unified Extractor ──────────────────────────────────────────
# Reemplaza el fuzzy-match como motor principal de mapeo.
# El fuzzy match sobrevive como fallback en extract_excel_to_contract().


def _init_gemini_model() -> "Any":
    """
    Inicializa el modelo Gemini usando el mismo orden de credenciales que GeminiAuditor.

    Returns vertexai GenerativeModel listo para usar.
    Levanta RuntimeError si no hay credenciales disponibles.
    """
    import json as _json
    import os

    import vertexai
    from google.oauth2 import service_account
    from vertexai.generative_models import GenerativeModel

    project_id = os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")
    location   = os.getenv("VERTEX_AI_LOCATION", "us-central1")
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    sa_json_str = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
    sa_path     = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "cometa_key.json")

    if sa_json_str:
        info = _json.loads(sa_json_str.strip())
        if isinstance(info, str):
            info = _json.loads(info)
        creds = service_account.Credentials.from_service_account_info(info)
        vertexai.init(project=project_id, location=location, credentials=creds)
    elif os.path.isfile(sa_path):
        creds = service_account.Credentials.from_service_account_file(sa_path)
        vertexai.init(project=project_id, location=location, credentials=creds)
    else:
        vertexai.init(project=project_id, location=location)

    return GenerativeModel(model_name)


def _dataframe_to_raw_json(df: pd.DataFrame) -> str:
    """
    Serializa un DataFrame a JSON compacto para el prompt de Gemini.

    Detecta automáticamente formato ancho (headers en fila 0) o formato
    largo (labels en columna 0) y serializa en consecuencia.
    Limita a 100 filas × 50 columnas para evitar overflow de tokens.
    """
    df_clean = df.iloc[:100, :50].fillna("")

    row0         = df_clean.iloc[0].tolist() if len(df_clean) > 0 else []
    string_count = sum(
        1 for c in row0
        if str(c).strip() and not str(c).replace(".", "").replace("-", "").replace(",", "").isdigit()
    )

    # Wide format: use row 0 as column headers
    if string_count >= 2 and len(df_clean) > 1:
        df_wide         = df_clean.iloc[1:].copy()
        df_wide.columns = [str(h).strip() for h in row0]
        return df_wide.to_json(orient="records", force_ascii=False)

    return df_clean.to_json(orient="records", force_ascii=False)


def _build_catalog_prompt(intel: KpiIntelligence) -> str:
    """Genera un resumen compacto del catálogo de 109 KPIs para el prompt de Gemini."""
    lines: list[str] = []
    for m in intel.metrics:
        aliases_str = ", ".join(m.get("aliases", [])[:4])
        entry = (
            f'  "{m["metric_id"]}": {m["display_name"]}'
            f' [unit: {m.get("unit", "?")}]'
        )
        if aliases_str:
            entry += f' — aliases: {aliases_str}'
        lines.append(entry)
    return "\n".join(lines)


def extract_excel_to_contract(
    file_path: "str | Path",
    period_id: str,
    fuzzy_threshold: float = 0.85,
) -> "UnifiedKPIContract":
    """
    Extrae métricas de un Excel/CSV y las mapea al catálogo de 109 KPIs
    usando Gemini como motor de mapping semántico.

    Flujo principal:
      1. Pandas carga el archivo y lo serializa a JSON compacto.
      2. Gemini recibe ese JSON + el catálogo completo de 109 KPIs.
      3. Gemini devuelve JSON estrictamente conforme a UnifiedKPIContract.
      4. Pydantic valida el resultado antes de retornarlo.

    Fallback (si Gemini no está disponible o falla):
      Ejecuta el motor fuzzy existente (map_uploaded_file) y convierte
      el MappingResult a UnifiedKPIContract.

    Parameters
    ----------
    file_path       : Ruta al archivo (.xlsx, .xls, .csv).
    period_id       : Período canónico inyectado en cada métrica (ej. "P2026Q1M01").
    fuzzy_threshold : Umbral de similitud para el fallback fuzzy (0.0–1.0).

    Returns
    -------
    UnifiedKPIContract validado con las métricas encontradas.

    Raises
    ------
    ValueError: Si no se encontraron métricas numéricas (ni vía Gemini ni vía fuzzy).
    """
    # Deferred import to avoid circular dependency at module load time
    from src.schemas import UnifiedKPIContract, UnifiedKPIMetric  # noqa: PLC0415

    path  = Path(file_path)
    intel = load_kpi_intelligence()

    logger.info("[Gemini Mapper] Iniciando extracción: %s | period=%s", path.name, period_id)

    df       = _load_file(path)
    raw_json = _dataframe_to_raw_json(df)
    catalog  = _build_catalog_prompt(intel)

    from src.core.prompts import build_extraction_prompt  # noqa: PLC0415

    data_block = (
        "los siguientes datos financieros extraídos de un Excel (formato JSON):\n\n"
        f"```json\n{raw_json}\n```"
    )
    prompt = build_extraction_prompt(
        catalog=catalog,
        period_id=period_id,
        source="EXCEL",
        raw_data_label=data_block,
    )

    try:
        import json as _json  # noqa: PLC0415

        model    = _init_gemini_model()
        # Usar dict en lugar de GenerationConfig (deprecated en vertexai SDK ≥ 1.40)
        config   = {"response_mime_type": "application/json", "temperature": 0.0}
        response = model.generate_content(prompt, generation_config=config)
        parsed   = _json.loads(response.text)
        contract = UnifiedKPIContract.model_validate(parsed)
        logger.info(
            "[Gemini Mapper] %d métricas extraídas via Gemini para period=%s",
            len(contract.metrics), period_id,
        )
        return contract

    except Exception as exc:
        logger.warning(
            "[Gemini Mapper] Gemini no disponible (%s) — activando fallback fuzzy", exc
        )

    # ── Fallback: motor fuzzy ─────────────────────────────────────────────────
    result  = map_uploaded_file(file_path, fuzzy_threshold=fuzzy_threshold)
    metrics = [
        UnifiedKPIMetric(
            metric_id=e.metric_id,
            value=e.numeric_value,
            period_id=period_id,
            source="EXCEL",
        )
        for e in result.found
        if e.numeric_value is not None
    ]
    if not metrics:
        raise ValueError(
            f"No se encontraron métricas numéricas en '{path.name}'. "
            "Verifica el formato del archivo."
        )
    logger.info(
        "[Fuzzy Fallback] %d métricas extraídas para period=%s",
        len(metrics), period_id,
    )
    return UnifiedKPIContract(metrics=metrics)
