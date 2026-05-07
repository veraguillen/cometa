"""
master_db_preprocessor.py
─────────────────────────
Pre-processing pipeline for Cometa MasterDatabase CSV files.

Converts the 16 wide-format portfolio CSVs into a clean, tall-format
DataFrame ready for BigQuery ingestion and Looker Studio analysis.

Bugs addressed (from data audit):
  BUG-2  gross_margin > 100% → NaN + WARNING
  BUG-3  currency symbols ($, comas) in numeric fields → strip & cast
  BUG-4  expense columns with positive sign → negate
  BUG-5  CMGR formula exponent error → recalculate with correct denominator
  BUG-6  "burn" definition ambiguity → standard_burn_type column

Entry point:
  process_cometa_dataset(file_path, company_name, vertical) → pd.DataFrame

Batch entry point:
  process_all(master_db_dir) → pd.DataFrame  (full portfolio, tall format)

Output schema (Data Contract):
  date            : datetime64[ns]   — first day of month (YYYY-MM-01)
  company_id      : str              — lowercase, e.g. "simetrik"
  vertical        : str              — SAAS | LEND | ECOM | INSUR | PROPTECH | OTH
  kpi_key         : str              — canonical snake_case key
  value           : float64          — cleaned numeric value (NaN if invalid)
  unit_type       : str              — "usd" | "pct" | "count" | "months" | "ratio"
  confidence_score: int              — 0–100 (100 = given, 70 = partial, 0 = missing)
  is_derived      : bool             — True if recalculated here, not taken from CSV
  has_formula_error: bool            — True if source cell was #DIV/0! / #REF! etc.
  burn_definition : str | None       — "fcf" | "ebitda" | "cash_change" | "operational"
  arr_type        : str | None       — "booked" | "run_rate" | "unknown"
  data_granularity: str              — "monthly" | "quarterly_interpolated"
  period_year     : int
  period_quarter  : str              — "Q1" | "Q2" | "Q3" | "Q4"
  period_month    : int              — 1–12
"""

from __future__ import annotations

import logging
import re
import warnings
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

# ── Logging setup ─────────────────────────────────────────────────────────────
logger = logging.getLogger(__name__)

_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(levelname)s] %(message)s")
)
if not logger.handlers:
    logger.addHandler(_handler)
logger.setLevel(logging.DEBUG)


# ── Types ─────────────────────────────────────────────────────────────────────
Vertical = Literal["SAAS", "LEND", "ECOM", "INSUR", "PROPTECH", "OTH"]

# ── Constants ─────────────────────────────────────────────────────────────────

# Maps company name (as it appears in the CSV filename, uppercase) to its
# canonical vertical. Mirrors db_writer.py:COMPANY_BUCKET.
COMPANY_VERTICAL_MAP: dict[str, Vertical] = {
    "SIMETRIK":    "SAAS",
    "PROMETEO":    "OTH",
    "PULSAR":      "SAAS",
    "NUMIA":       "SAAS",
    "HUNTY":       "SAAS",
    "KUONA":       "SAAS",
    "CLUVI":       "SAAS",
    "HACKMETRIX":  "SAAS",
    "TERRITORIUM": "SAAS",
    "SOLVENTO":    "LEND",
    "KALA":        "LEND",
    "DUPPLA":      "PROPTECH",
    "GUROS":       "INSUR",
    "RINTIN":      "ECOM",
    "QUINIO":      "ECOM",
    "M1":          "PROPTECH",   # MORADAUNO
}

# BUG-6: Per-company canonical burn definition, derived from audit findings.
BURN_DEFINITION_MAP: dict[str, str] = {
    "simetrik":    "fcf",            # explicitly labelled "Burn (FCF)" in CSV
    "prometeo":    "ebitda",         # Burn values == EBITDA in 2025 rows
    "moradauno":   "cash_change",    # includes fundraising inflows
    "m1":          "cash_change",
    "solvento":    "cash_change",
    "pulsar":      "cash_change",
    "numia":       "cash_change",
    "hunty":       "cash_change",
    "kuona":       "cash_change",
    "cluvi":       "cash_change",
    "territorium": "cash_change",
    "rintin":      "unknown",
    "quinio":      "unknown",
    "kala":        "unknown",
    "duppla":      "unknown",
    "guros":       "unknown",
    "hackmetrix":  "unknown",
}

# BUG-1: Canonical ARR type per company from audit.
ARR_TYPE_MAP: dict[str, str] = {
    "simetrik":    "run_rate",    # ARR = MRR * 12
    "prometeo":    "run_rate",    # ARR = Revenue * 12 (circular — confirmed in audit)
    "pulsar":      "booked",      # Booked ARR field explicitly present
    "numia":       "booked",      # Booked MRR field explicitly present
    "hunty":       "booked",      # Booked ARR field present
    "kuona":       "booked",      # Booked MRR quarterly
}

# Excel formula error strings that must be converted to NaN.
_EXCEL_ERRORS: frozenset[str] = frozenset({
    "#DIV/0!", "#REF!", "#N/A", "#VALUE!", "#NAME?", "#NULL!", "#NUM!",
})

# Columns that represent expenses — positive values get negated (BUG-4).
_EXPENSE_KEYS: frozenset[str] = frozenset({
    "s_m_expense", "sm_expense", "sales_marketing",
    "g_a_expense", "ga_expense", "general_admin",
    "r_d_expense", "rd_expense", "research_development",
    "cogs", "cost_of_goods_sold",
})

# Maps raw CSV row labels (lowercased, stripped) to canonical kpi_key.
# Order matters for prefix-based matching — more specific entries first.
_ROW_LABEL_MAP: list[tuple[re.Pattern[str], str, str, str]] = [
    # (pattern,              kpi_key,               unit_type, confidence)
    # ── Revenue & Growth ─────────────────────────────────────────────────────
    (re.compile(r"net revenue"),           "net_revenue",         "usd",    "given"),
    (re.compile(r"total revenue"),         "net_revenue",         "usd",    "given"),
    (re.compile(r"annual revenue growth"), "revenue_growth_yoy",  "pct",    "calc"),
    (re.compile(r"quarter revenue growth"),"revenue_growth_qoq",  "pct",    "calc"),
    # ── Profitability ─────────────────────────────────────────────────────────
    (re.compile(r"gross profit$"),         "gross_profit",        "usd",    "given"),
    (re.compile(r"gross margin"),          "gross_margin",        "pct",    "calc"),
    (re.compile(r"ebitda margin"),         "ebitda_margin",       "pct",    "calc"),
    (re.compile(r"^ebitda$"),              "ebitda",              "usd",    "given"),
    (re.compile(r"ebt margin"),            "ebt_margin",          "pct",    "calc"),
    (re.compile(r"^ebt$"),                 "ebt",                 "usd",    "given"),
    # ── Expenses ─────────────────────────────────────────────────────────────
    (re.compile(r"s&m expense ratio"),     "sm_expense_ratio",    "pct",    "calc"),
    (re.compile(r"s&m expense"),           "sm_expense",          "usd",    "given"),
    # ── Cash & Burn ──────────────────────────────────────────────────────────
    (re.compile(r"^cash$"),                "cash",                "usd",    "given"),
    (re.compile(r"burn \(fcf\)"),          "burn",                "usd",    "given"),
    (re.compile(r"^burn$"),                "burn",                "usd",    "given"),
    (re.compile(r"burn multiple"),         "burn_multiple",       "ratio",  "calc"),
    (re.compile(r"runway"),                "runway_months",       "months", "calc"),
    # ── SaaS Metrics ─────────────────────────────────────────────────────────
    (re.compile(r"^mrr$"),                 "mrr",                 "usd",    "given"),
    (re.compile(r"booked mrr"),            "booked_mrr",          "usd",    "given"),
    (re.compile(r"^arr$"),                 "arr",                 "usd",    "given"),
    (re.compile(r"booked arr"),            "booked_arr",          "usd",    "given"),
    (re.compile(r"l6m cmgr"),             "cmgr_l6m",            "pct",    "calc"),
    (re.compile(r"l12m cmgr"),            "cmgr_l12m",           "pct",    "calc"),
    (re.compile(r"rule of 40"),            "rule_of_40",          "pct",    "calc"),
    (re.compile(r"saas magic number"),     "saas_magic_number",   "ratio",  "calc"),
    (re.compile(r"ndr"),                   "ndr_12m",             "pct",    "given"),
    (re.compile(r"^acv$"),                 "acv",                 "usd",    "given"),
    (re.compile(r"ltv/cac"),               "ltv_cac_ratio",       "ratio",  "given"),
    (re.compile(r"cac payback"),           "cac_payback_months",  "months", "given"),
    (re.compile(r"# new customers"),       "new_customers",       "count",  "given"),
    (re.compile(r"# churn customers"),     "churn_customers",     "count",  "given"),
    (re.compile(r"invoiced clients"),      "invoiced_clients",    "count",  "given"),
    (re.compile(r"sales cycle"),           "sales_cycle_days",    "count",  "given"),
    # ── eCommerce / Marketplace ───────────────────────────────────────────────
    (re.compile(r"^gmv$"),                 "gmv",                 "usd",    "given"),
    (re.compile(r"new gmv"),               "new_gmv",             "usd",    "given"),
    (re.compile(r"take rate"),             "take_rate",           "pct",    "given"),
    (re.compile(r"total buyers"),          "total_buyers",        "count",  "given"),
    (re.compile(r"new buyers"),            "new_buyers",          "count",  "given"),
    (re.compile(r"total orders"),          "total_orders",        "count",  "given"),
    (re.compile(r"aov"),                   "aov",                 "usd",    "given"),
    (re.compile(r"blended cac"),           "blended_cac",         "usd",    "given"),
    (re.compile(r"repeat purchase rate"),  "repeat_purchase_rate","pct",    "given"),
    # ── Lending ───────────────────────────────────────────────────────────────
    (re.compile(r"net interest income"),   "net_interest_income", "usd",    "given"),
    (re.compile(r"interest income margin"),"interest_income_margin","pct", "given"),
    (re.compile(r"total gross loanbook"),  "gross_loanbook",      "usd",    "given"),
    (re.compile(r"par 30"),                "par_30",              "pct",    "given"),
    (re.compile(r"par 60"),                "par_60",              "pct",    "given"),
    (re.compile(r"delinquencies dpd>90 \(%\)"), "npl_90d_pct",   "pct",    "given"),
    (re.compile(r"delinquencies dpd>90"),  "npl_90d_amount",      "usd",    "given"),
    (re.compile(r"default rate"),          "default_rate",        "pct",    "given"),
    (re.compile(r"reserves \(%\)"),        "reserves_pct",        "pct",    "given"),
    (re.compile(r"apr \(%\)"),             "apr",                 "pct",    "given"),
    (re.compile(r"writeoffs"),             "writeoffs",           "usd",    "given"),
    (re.compile(r"gtv"),                   "gtv",                 "usd",    "given"),
    (re.compile(r"active clients"),        "active_clients",      "count",  "given"),
    (re.compile(r"new loans financed"),    "new_loans_financed",  "count",  "given"),
    # ── Insurtech / PropTech ──────────────────────────────────────────────────
    (re.compile(r"gross written premium"), "gwp",                 "usd",    "given"),
    (re.compile(r"commission revenue"),    "commission_revenue",  "usd",    "given"),
    (re.compile(r"loss ratio"),            "loss_ratio",          "pct",    "given"),
    (re.compile(r"loss rate"),             "loss_rate",           "pct",    "given"),
    (re.compile(r"policy renewal rate"),   "policy_renewal_rate", "pct",    "given"),
    (re.compile(r"combined ratio"),        "combined_ratio",      "pct",    "given"),
    (re.compile(r"properties under mgmt|properties under management"),
                                           "properties_under_mgmt","count", "given"),
    (re.compile(r"active brokers|active borkers"),
                                           "active_brokers",      "count",  "given"),
    (re.compile(r"closed guarantees"),     "closed_guarantees",   "count",  "given"),
    (re.compile(r"renewal guarantees"),    "renewal_guarantees",  "count",  "given"),
    (re.compile(r"avg.*lease value"),      "avg_lease_value",     "usd",    "given"),
    (re.compile(r"avg.*guarantee value"),  "avg_guarantee_value", "usd",    "given"),
    (re.compile(r"ndr.*broker"),           "ndr_broker_12m",      "pct",    "given"),
    # ── DUPPLA / KALA (lending PropTech) ─────────────────────────────────────
    (re.compile(r"^renta$"),               "rental_revenue",      "usd",    "given"),
    (re.compile(r"^offload$"),             "offload_volume",      "usd",    "given"),
    (re.compile(r"loan portfolio"),        "gross_loanbook",      "usd",    "given"),
    (re.compile(r"spread on portfolio"),   "portfolio_spread",    "pct",    "given"),
    (re.compile(r"servicing fee"),         "servicing_fee",       "usd",    "given"),
    (re.compile(r"origination fees?"),     "origination_fees",    "usd",    "given"),
    (re.compile(r"back book"),             "back_book_pct",       "pct",    "given"),
    (re.compile(r"moratoria 30"),          "par_30",              "pct",    "given"),
    (re.compile(r"moratoria.*60"),         "par_60",              "pct",    "given"),
    (re.compile(r"irr promedio"),          "portfolio_irr",       "pct",    "given"),
    (re.compile(r"number of applications"),"loan_applications",   "count",  "given"),
    (re.compile(r"approved applications"), "approved_apps",       "count",  "given"),
    (re.compile(r"disbursed loans"),       "disbursed_loans",     "count",  "given"),
    # ── SOLVENTO / Fintech ────────────────────────────────────────────────────
    (re.compile(r"monthly active carriers"),"active_carriers",    "count",  "given"),
    (re.compile(r"clients activated"),     "new_clients",         "count",  "given"),
    (re.compile(r"new loans financed"),    "new_loans_financed",  "count",  "given"),
    # ── KUONA / PROMETEO ─────────────────────────────────────────────────────
    (re.compile(r"tpv"),                   "tpv",                 "usd",    "given"),
    (re.compile(r"blended take rate"),     "take_rate",           "pct",    "given"),
    # ── People & Efficiency ───────────────────────────────────────────────────
    (re.compile(r"^employees$"),           "headcount",           "count",  "given"),
    (re.compile(r"female employees"),      "female_headcount",    "count",  "given"),
    (re.compile(r"revenue/employee"),      "revenue_per_employee","usd",    "calc"),
    (re.compile(r"sales cycle"),           "sales_cycle_days",    "count",  "given"),
]

# ── Month header → datetime mapping ───────────────────────────────────────────
_MONTH_ABBR: dict[str, int] = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4,
    "may": 5, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


# =============================================================================
# STEP 1 — String sanitisation helpers
# =============================================================================

def _clean_currency_string(raw: object) -> float | None:
    """
    BUG-3: Convert messy monetary strings to float.

    Handles:
      - "$1,052,923"  →  1052923.0
      - "(100.00)"    →  -100.0
      - "-$2,500"     →  -2500.0
      - "62.7%"       →  0.627
      - "#DIV/0!"     →  NaN
      - "-"           →  NaN
      - ""            →  NaN
    """
    if raw is None:
        return None

    s = str(raw).strip()

    # Excel formula errors → NaN
    if s in _EXCEL_ERRORS or s in ("-", "", "N/A", "n/a"):
        return float("nan")

    # Accounting notation: (100) → -100
    negative_parens = s.startswith("(") and s.endswith(")")
    if negative_parens:
        s = "-" + s[1:-1]

    # Strip $, spaces, commas
    s = re.sub(r"[$,\s]", "", s)

    # Handle percentage: convert to decimal ratio
    is_pct = s.endswith("%")
    if is_pct:
        s = s.rstrip("%")

    try:
        value = float(s)
    except ValueError:
        return float("nan")

    return value / 100.0 if is_pct else value


def _parse_month_header(col: str) -> pd.Timestamp | None:
    """
    Parse column headers like "Jan-24", "Feb-25" into Timestamp(YYYY-MM-01).
    Returns None for non-date columns (e.g., "Detail", "Formula").
    """
    match = re.fullmatch(r"([A-Za-z]{3})-(\d{2})", col.strip())
    if not match:
        return None
    month_str, year_str = match.group(1).lower(), match.group(2)
    month_num = _MONTH_ABBR.get(month_str)
    if month_num is None:
        return None
    year = 2000 + int(year_str)
    return pd.Timestamp(year=year, month=month_num, day=1)


# =============================================================================
# STEP 2 — Confidence score from "Detail" column
# =============================================================================

_DETAIL_CONFIDENCE: dict[str, int] = {
    "given":       100,
    "calculation": 90,   # derived from given inputs
    "partial":     70,
    "quarterly":   65,   # monthly interpolated from quarterly
    "missing":     0,
}


def _detail_to_confidence(detail: str) -> int:
    """Map the CSV 'Detail' column value to a confidence score 0–100."""
    detail_lower = str(detail).strip().lower()
    for key, score in _DETAIL_CONFIDENCE.items():
        if key in detail_lower:
            return score
    return 50  # unknown


# =============================================================================
# STEP 3 — Row label → canonical kpi_key
# =============================================================================

def _resolve_kpi_key(label: str) -> tuple[str, str] | None:
    """
    Match a raw row label to (kpi_key, unit_type).
    Returns None if the label is not recognised.
    """
    normalised = label.strip().lower()
    # Remove leading/trailing punctuation and parenthetical year notes
    normalised = re.sub(r"\s*\(.*?\)", "", normalised).strip()
    for pattern, kpi_key, unit_type, _ in _ROW_LABEL_MAP:
        if pattern.search(normalised):
            return kpi_key, unit_type
    return None


# =============================================================================
# STEP 4 — Expense sign correction (BUG-4)
# =============================================================================

def _enforce_expense_sign(kpi_key: str, value: float | None) -> float | None:
    """
    BUG-4: Expense KPIs must be ≤ 0.
    If a positive value is detected for an expense line, negate it.
    """
    if value is None or np.isnan(value):
        return value
    if kpi_key in _EXPENSE_KEYS and value > 0:
        return -value
    return value


# =============================================================================
# STEP 5 — Sanity checks (BUG-2)
# =============================================================================

def _sanity_check(
    kpi_key: str,
    value: float | None,
    company_id: str,
    date: pd.Timestamp,
) -> tuple[float | None, bool]:
    """
    BUG-2: Apply financial sanity rules.

    Returns (cleaned_value, has_warning).
    If a rule is violated, value is replaced with NaN and a WARNING is logged.
    """
    if value is None or np.isnan(value):
        return value, False

    warning = False

    # Gross Margin: must be in [-0.5, 1.0]
    if kpi_key == "gross_margin":
        if value > 1.0:
            logger.warning(
                "Empresa: %s, Mes: %s, Error: gross_margin imposible (%.1f%%). "
                "Verificar si Revenue incluye todas las líneas de ingreso.",
                company_id.upper(),
                date.strftime("%b-%Y"),
                value * 100,
            )
            return float("nan"), True
        if value < -0.5:
            logger.warning(
                "Empresa: %s, Mes: %s, Error: gross_margin extremadamente negativo (%.1f%%). "
                "Posible COGS incorrecto.",
                company_id.upper(),
                date.strftime("%b-%Y"),
                value * 100,
            )
            warning = True

    # NDR: must be in [0.3, 3.0]
    elif kpi_key == "ndr_12m":
        if not (0.3 <= value <= 3.0):
            logger.warning(
                "Empresa: %s, Mes: %s, Error: NDR fuera de rango plausible (%.0f%%). "
                "Verificar si se reporta como ratio o porcentaje.",
                company_id.upper(),
                date.strftime("%b-%Y"),
                value * 100,
            )
            warning = True

    # Runway: must be ≥ 0
    elif kpi_key == "runway_months":
        if value < 0:
            logger.warning(
                "Empresa: %s, Mes: %s, Error: runway negativo (%.1f meses). "
                "Cash o Burn reportados incorrectamente.",
                company_id.upper(),
                date.strftime("%b-%Y"),
                value,
            )
            return float("nan"), True

    # EBITDA margin: warn below -500%
    elif kpi_key == "ebitda_margin":
        if value < -5.0:
            logger.warning(
                "Empresa: %s, Mes: %s, Error: EBITDA Margin extremo (%.0f%%). "
                "Revisar si EBITDA incluye gastos no operacionales.",
                company_id.upper(),
                date.strftime("%b-%Y"),
                value * 100,
            )
            warning = True

    return value, warning


# =============================================================================
# STEP 6 — Derived metric recalculation (BUG-1, BUG-5)
# =============================================================================

def _recalculate_derived_metrics(tall: pd.DataFrame, company_id: str) -> pd.DataFrame:
    """
    BUG-1 / BUG-5: Recalculate all ratio/margin KPIs from source inputs.

    Drops the CSV-provided values for derived metrics and replaces them with
    fresh calculations. Adds is_derived=True to every recalculated row.

    Derived metrics computed here:
      - gross_margin
      - ebitda_margin
      - sm_expense_ratio
      - burn_multiple   (quarterly cadence)
      - cmgr_l6m        (correct exponent: 1/5)
      - cmgr_l12m       (correct exponent: 1/11)  ← BUG-5 fix
    """
    # Pivot to wide for arithmetic, then melt back
    pivot = (
        tall[tall["company_id"] == company_id]
        .pivot_table(index="date", columns="kpi_key", values="value", aggfunc="first")
        .sort_index()
    )

    new_rows: list[dict] = []

    def _add(date: pd.Timestamp, kpi_key: str, value: float, unit_type: str) -> None:
        new_rows.append({
            "date":              date,
            "company_id":        company_id,
            "kpi_key":           kpi_key,
            "value":             value,
            "unit_type":         unit_type,
            "is_derived":        True,
            "confidence_score":  90,
            "has_formula_error": False,
        })

    for date, row in pivot.iterrows():
        rev  = row.get("net_revenue", np.nan)
        gp   = row.get("gross_profit", np.nan)
        ebitda = row.get("ebitda", np.nan)
        sm   = row.get("sm_expense", np.nan)

        # gross_margin = Gross Profit / Revenue
        if not (np.isnan(rev) or np.isnan(gp)) and rev != 0:
            gm = gp / rev
            if gm <= 1.0:  # BUG-2: only store if sane
                _add(date, "gross_margin", gm, "pct")
            else:
                logger.warning(
                    "Empresa: %s, Mes: %s, Error: gross_margin recalculado > 100%% (%.1f%%). "
                    "Dato Inconsistente — se excluye.",
                    company_id.upper(),
                    date.strftime("%b-%Y"),
                    gm * 100,
                )

        # ebitda_margin = EBITDA / Revenue
        if not (np.isnan(rev) or np.isnan(ebitda)) and rev != 0:
            _add(date, "ebitda_margin", ebitda / rev, "pct")

        # sm_expense_ratio = S&M / Revenue
        if not (np.isnan(rev) or np.isnan(sm)) and rev != 0:
            _add(date, "sm_expense_ratio", sm / rev, "pct")

    # ── CMGR recalculations — require rolling window ──────────────────────────
    if "net_revenue" in pivot.columns:
        rev_series = pivot["net_revenue"].dropna()

        for i, (date, _) in enumerate(pivot.iterrows()):
            # L6M CMGR: months [i-5 .. i], correct exponent = 1/5 (5 intervals)
            if i >= 5:
                m_start = rev_series.iloc[i - 5] if i - 5 < len(rev_series) else np.nan
                m_end   = rev_series.get(date, np.nan)
                if not (np.isnan(m_start) or np.isnan(m_end)) and m_start > 0:
                    cmgr = (m_end / m_start) ** (1 / 5) - 1
                    _add(date, "cmgr_l6m", cmgr, "pct")

            # L12M CMGR: months [i-11 .. i], correct exponent = 1/11 (BUG-5 fix)
            if i >= 11:
                m_start = rev_series.iloc[i - 11] if i - 11 < len(rev_series) else np.nan
                m_end   = rev_series.get(date, np.nan)
                if not (np.isnan(m_start) or np.isnan(m_end)) and m_start > 0:
                    cmgr = (m_end / m_start) ** (1 / 11) - 1
                    _add(date, "cmgr_l12m", cmgr, "pct")

    # ── Burn Multiple (quarterly) ─────────────────────────────────────────────
    # burn_multiple = sum(quarterly_burn) / delta(quarterly_arr)
    # Only meaningful if both burn and arr/booked_arr are present.
    if "burn" in pivot.columns:
        arr_col = None
        for candidate in ("booked_arr", "arr", "mrr"):
            if candidate in pivot.columns:
                arr_col = candidate
                break

        if arr_col:
            burn_q = pivot["burn"].resample("QE").sum()
            arr_q  = pivot[arr_col].resample("QE").last()
            arr_delta = arr_q.diff()

            for q_date in burn_q.index:
                b  = burn_q.get(q_date, np.nan)
                da = arr_delta.get(q_date, np.nan)
                if not (np.isnan(b) or np.isnan(da)) and da != 0:
                    bm = abs(b) / abs(da)
                    # Re-index to last month of quarter
                    row_date = q_date.to_timestamp() if hasattr(q_date, "to_timestamp") else q_date
                    _add(row_date, "burn_multiple", bm, "ratio")

    if not new_rows:
        return tall

    derived_df = pd.DataFrame(new_rows)

    # Remove the CSV-sourced versions of derived KPIs before concat
    derived_kpi_keys = set(derived_df["kpi_key"].unique())
    tall_filtered = tall[
        ~((tall["company_id"] == company_id) & (tall["kpi_key"].isin(derived_kpi_keys)))
    ]

    return pd.concat([tall_filtered, derived_df], ignore_index=True)


# =============================================================================
# MAIN PROCESSING FUNCTION
# =============================================================================

def process_cometa_dataset(
    file_path: str | Path,
    company_name: str,
    vertical: Vertical | None = None,
) -> pd.DataFrame:
    """
    Clean and normalise a single Cometa MasterDatabase CSV.

    Parameters
    ----------
    file_path    : Path to the CSV file.
    company_name : Human-readable company name (e.g. "SIMETRIK").
                   Used for logging and as the company_id source.
    vertical     : Override the vertical lookup. If None, looked up from
                   COMPANY_VERTICAL_MAP using company_name.

    Returns
    -------
    pd.DataFrame in tall/long format (see module docstring for schema).
    """
    file_path  = Path(file_path)
    company_id = company_name.strip().lower().replace(" ", "_")
    # Normalise "m1" → "moradauno" for burn/arr maps that use full names
    _display   = company_name.upper()

    if vertical is None:
        vertical = COMPANY_VERTICAL_MAP.get(company_name.upper(), "OTH")

    logger.info("Processing %s (%s) from %s", _display, vertical, file_path.name)

    # ── Read raw CSV ──────────────────────────────────────────────────────────
    try:
        raw = pd.read_csv(file_path, header=0, dtype=str, na_filter=False)
    except Exception as exc:
        logger.error("Error leyendo %s: %s", file_path, exc)
        return pd.DataFrame()

    if raw.empty or raw.shape[1] < 4:
        logger.warning("Empresa: %s, Error: CSV vacío o con menos de 4 columnas.", _display)
        return pd.DataFrame()

    # ── Identify date columns ─────────────────────────────────────────────────
    # The first column is the row label; columns 2+ may be date headers.
    # Non-date columns (Detail, Formula, Ask) are metadata.
    col_dates: dict[str, pd.Timestamp] = {}
    for col in raw.columns[1:]:
        ts = _parse_month_header(col)
        if ts is not None:
            col_dates[col] = ts

    if not col_dates:
        logger.warning(
            "Empresa: %s, Error: No se encontraron columnas de fecha con formato Mon-YY.",
            _display,
        )
        return pd.DataFrame()

    # ── Extract metadata columns ──────────────────────────────────────────────
    label_col   = raw.columns[0]
    detail_col  = "Detail" if "Detail" in raw.columns else None
    formula_col = "Formula" if "Formula" in raw.columns else None

    # ── Build records ─────────────────────────────────────────────────────────
    records: list[dict] = []

    for _, row in raw.iterrows():
        raw_label = str(row[label_col]).strip()
        if not raw_label or raw_label.lower() in ("nan", ""):
            continue

        resolved = _resolve_kpi_key(raw_label)
        if resolved is None:
            logger.debug("Empresa: %s, Etiqueta no reconocida: '%s' — omitiendo.", _display, raw_label)
            continue

        kpi_key, unit_type = resolved

        detail_val = str(row.get(detail_col, "")).strip() if detail_col else ""
        base_confidence = _detail_to_confidence(detail_val)

        # Skip rows that are purely "Missing" with no data at all
        if base_confidence == 0:
            all_empty = all(
                str(row.get(col, "")).strip() in ("", "-", "N/A") or
                str(row.get(col, "")) in _EXCEL_ERRORS
                for col in col_dates
            )
            if all_empty:
                logger.debug(
                    "Empresa: %s, KPI: %s — marcado Missing y sin valores. Omitiendo.",
                    _display, kpi_key,
                )
                continue

        for col, date in col_dates.items():
            raw_val = str(row.get(col, "")).strip()

            # Detect Excel formula errors before conversion
            has_formula_error = raw_val in _EXCEL_ERRORS

            # Convert to float
            value = _clean_currency_string(raw_val)

            # BUG-4: correct expense sign
            value = _enforce_expense_sign(kpi_key, value)

            # BUG-2: sanity check
            value, had_warning = _sanity_check(kpi_key, value, company_id, date)

            # Confidence: drop to 0 if formula error, 50 if we set it to NaN
            confidence = base_confidence
            if has_formula_error:
                confidence = 0
            elif value is not None and not np.isnan(value):
                pass  # keep base confidence
            elif had_warning:
                confidence = 10   # data present but flagged

            records.append({
                "date":              date,
                "company_id":        company_id,
                "vertical":          vertical,
                "kpi_key":           kpi_key,
                "value":             float("nan") if value is None else value,
                "unit_type":         unit_type,
                "confidence_score":  confidence,
                "is_derived":        False,
                "has_formula_error": has_formula_error,
                "burn_definition":   BURN_DEFINITION_MAP.get(company_id),
                "arr_type":          ARR_TYPE_MAP.get(company_id, "unknown")
                                     if kpi_key in ("arr", "booked_arr", "mrr") else None,
                "data_granularity":  (
                    "quarterly_interpolated"
                    if "quarterly" in detail_val.lower() or "partial (q)" in detail_val.lower()
                    else "monthly"
                ),
            })

    if not records:
        logger.warning("Empresa: %s, Error: Ningún KPI reconocido en el archivo.", _display)
        return pd.DataFrame()

    tall = pd.DataFrame(records)

    # ── Recalculate derived metrics (BUG-1, BUG-5) ───────────────────────────
    tall = _recalculate_derived_metrics(tall, company_id)

    # ── BUG-6: Normalise standard_burn_type column ────────────────────────────
    burn_def = BURN_DEFINITION_MAP.get(company_id, "unknown")
    burn_mask = tall["kpi_key"] == "burn"
    tall.loc[burn_mask, "burn_definition"] = burn_def

    # ── Temporal dimensions — fill after derived rows are added ──────────────
    # Re-derive for ALL rows (including newly added derived ones) so that
    # period_year / period_quarter / period_month are never NaN.
    tall["date"]           = pd.to_datetime(tall["date"])
    tall["period_year"]    = tall["date"].dt.year.astype("Int64")
    tall["period_month"]   = tall["date"].dt.month.astype("Int64")
    tall["period_quarter"] = tall["date"].dt.quarter.map({1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"})

    # ── Deduplicate: keep one row per (company, kpi, date) ───────────────────
    # Prefer is_derived=True (recalculated) over raw CSV values.
    tall = (
        tall
        .sort_values("is_derived", ascending=False)
        .drop_duplicates(subset=["company_id", "kpi_key", "date"], keep="first")
        .reset_index(drop=True)
    )

    # ── Final column order ────────────────────────────────────────────────────
    output_cols = [
        "date", "company_id", "vertical", "kpi_key", "value", "unit_type",
        "confidence_score", "is_derived", "has_formula_error",
        "burn_definition", "arr_type", "data_granularity",
        "period_year", "period_quarter", "period_month",
    ]
    for col in output_cols:
        if col not in tall.columns:
            tall[col] = None

    logger.info(
        "Empresa: %s — %d registros limpios, %d KPIs únicos, %d meses.",
        _display,
        len(tall),
        tall["kpi_key"].nunique(),
        tall["date"].nunique(),
    )

    return tall[output_cols]


# =============================================================================
# BATCH PROCESSOR
# =============================================================================

def process_all(
    master_db_dir: str | Path,
    output_path: str | Path | None = None,
) -> pd.DataFrame:
    """
    Process all 16 MasterDatabase CSV files in a directory.

    Parameters
    ----------
    master_db_dir : Directory containing "Master Database - COMPANY.csv" files.
    output_path   : If provided, writes the combined DataFrame to this CSV path.

    Returns
    -------
    pd.DataFrame — full portfolio, tall format, ready for BigQuery.
    """
    master_db_dir = Path(master_db_dir)
    csv_files = list(master_db_dir.glob("Master Database - *.csv"))

    if not csv_files:
        logger.error("No se encontraron archivos 'Master Database - *.csv' en %s", master_db_dir)
        return pd.DataFrame()

    all_frames: list[pd.DataFrame] = []
    failed: list[str] = []

    for csv_path in sorted(csv_files):
        # Extract company name from filename: "Master Database - SIMETRIK.csv" → "SIMETRIK"
        match = re.search(r"Master Database - (.+)\.csv$", csv_path.name, re.IGNORECASE)
        if not match:
            logger.warning("No se pudo extraer el nombre de empresa de: %s", csv_path.name)
            continue

        company_name = match.group(1).strip().upper()
        vertical     = COMPANY_VERTICAL_MAP.get(company_name, "OTH")

        try:
            df = process_cometa_dataset(csv_path, company_name, vertical)
            if not df.empty:
                all_frames.append(df)
            else:
                failed.append(company_name)
        except Exception as exc:  # noqa: BLE001
            logger.error("Empresa: %s, Error inesperado: %s", company_name, exc, exc_info=True)
            failed.append(company_name)

    if not all_frames:
        logger.error("Ningún archivo procesado correctamente.")
        return pd.DataFrame()

    combined = pd.concat(all_frames, ignore_index=True)
    combined = combined.sort_values(["company_id", "kpi_key", "date"]).reset_index(drop=True)

    if failed:
        logger.warning(
            "Empresas con errores o sin datos: %s",
            ", ".join(failed),
        )

    # ── Summary stats ─────────────────────────────────────────────────────────
    total       = len(combined)
    n_companies = combined["company_id"].nunique()
    n_kpis      = combined["kpi_key"].nunique()
    n_errors    = combined["has_formula_error"].sum()
    n_nan       = combined["value"].isna().sum()
    pct_fill    = (1 - n_nan / total) * 100 if total else 0

    logger.info(
        "\n── Portfolio Summary ──────────────────────────────────\n"
        "  Empresas procesadas : %d\n"
        "  KPIs únicos         : %d\n"
        "  Registros totales   : %d\n"
        "  Celdas con valor    : %.1f%%\n"
        "  Errores de fórmula  : %d\n"
        "──────────────────────────────────────────────────────",
        n_companies, n_kpis, total, pct_fill, n_errors,
    )

    if output_path is not None:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        combined.to_csv(output_path, index=False)
        logger.info("Dataset exportado a: %s", output_path)

    return combined


# =============================================================================
# LEGACY PAYLOAD BUILDER
# Bridges the EDA master_db DataFrame → fact_portfolio_history rows.
# All rows carry source="legacy" and quality_score=0.60.
# row_id format: {company_slug}_{YYYYMM}_{kpi_ref}  — same as verified loads,
# preventing collisions when a Founder later submits verified data for the
# same company+period+metric (MERGE will UPDATE, not INSERT).
# =============================================================================

def _build_kpi_ref_index() -> dict[str, str]:
    """
    Builds a metric_id (snake_case) → kpi_ref (KPI-XXX) mapping from
    loading_brain_v1.json.  Called once and cached at module level.
    """
    import json as _json
    from pathlib import Path as _Path

    brain_path = _Path(__file__).resolve().parents[2] / "assets" / "loading_brain_v1.json"
    with brain_path.open(encoding="utf-8") as fh:
        brain = _json.load(fh)

    return {m["metric_id"]: m["kpi_ref"] for m in brain.get("metrics", [])}


_KPI_REF_INDEX: dict[str, str] | None = None


def _get_kpi_ref(metric_id: str) -> str | None:
    """Returns KPI-XXX for a snake_case metric_id, or None if unknown."""
    global _KPI_REF_INDEX
    if _KPI_REF_INDEX is None:
        _KPI_REF_INDEX = _build_kpi_ref_index()
    return _KPI_REF_INDEX.get(metric_id)


def build_legacy_payload(df: "pd.DataFrame") -> list[dict]:
    """
    Converts the tall-format DataFrame produced by process_all() into a list
    of rows ready for insertion into `cometa_portfolio.fact_portfolio_history`.

    Contract
    --------
    - source        = "legacy"    — identifies EDA / historical data
    - quality_score = 0.60        — historically uploaded, not gatekeeper-verified
    - status_tier   = "GOLD" if value present, "MISSING" otherwise
    - row_id format = {company_slug}_{YYYYMM}_{kpi_ref}

    Only rows where the kpi_key can be mapped to a KPI-XXX ref are included.
    Unmapped kpi_keys are logged as warnings (not errors).

    Parameters
    ----------
    df : DataFrame with columns [date, company_id, vertical, kpi_key, value,
                                  unit_type, confidence_score, is_derived,
                                  has_formula_error, ...]
         as produced by master_db_preprocessor.process_all().

    Returns
    -------
    list[dict] — each dict maps directly to a `fact_portfolio_history` column.
    """
    import uuid as _uuid
    from datetime import datetime as _datetime, timezone as _tz

    rows: list[dict] = []
    load_id       = str(_uuid.uuid4())
    load_ts       = _datetime.now(_tz.utc).isoformat()
    skipped_keys: set[str] = set()

    required_cols = {"date", "company_id", "kpi_key", "value"}
    missing_cols  = required_cols - set(df.columns)
    if missing_cols:
        logger.error("build_legacy_payload: DataFrame missing columns: %s", missing_cols)
        return []

    for _, row in df.iterrows():
        kpi_key = str(row["kpi_key"])
        kpi_ref = _get_kpi_ref(kpi_key)

        if kpi_ref is None:
            skipped_keys.add(kpi_key)
            continue

        company_slug = str(row["company_id"]).lower().strip()
        period_date  = row["date"]
        if hasattr(period_date, "strftime"):
            period_str = period_date.strftime("%Y%m")
            period_iso = period_date.strftime("%Y-%m-%d")
        else:
            period_str = str(period_date).replace("-", "")[:6]
            period_iso = str(period_date)[:10]

        row_id = f"{company_slug}_{period_str}_{kpi_ref}"

        raw_value = row.get("value")
        try:
            numeric_value = float(raw_value) if raw_value is not None and str(raw_value) not in ("nan", "") else None
        except (ValueError, TypeError):
            numeric_value = None

        has_err = bool(row.get("has_formula_error", False))
        status_tier = "MISSING" if numeric_value is None else ("GOLD" if not has_err else "PARTIAL")

        rows.append({
            "row_id":             row_id,
            "company_name":       company_slug.upper(),
            "company_slug":       company_slug,
            "period":             period_iso,
            "metric_id":          kpi_ref,
            "metric_name":        kpi_key.replace("_", " ").title(),
            "value":              numeric_value,
            "value_type":         "real",
            "currency":           "USD",
            "unit":               str(row.get("unit_type", "")),
            "status_tier":        status_tier,
            "given_or_silver":    "GIVEN",
            "quality_score":      0.60,
            "is_innegociable":    False,   # resolved below via kpi_ref lookup
            "source":             "legacy",
            "source_file":        None,
            "input_form_version": None,
            "formula_bq":         None,
            "physics_violation":  False,
            "flag_review":        False,
            "founder_alert":      False,
            "sector_scope":       str(row.get("vertical", "ALL")),
            "load_id":            load_id,
            "load_timestamp":     load_ts,
            "loaded_by":          "legacy_migration_v1",
            "confirmed_by":       None,
            "last_updated":       None,
            "is_deleted":         False,
        })

    if skipped_keys:
        logger.warning(
            "build_legacy_payload: %d kpi_key(s) not in loading_brain index "
            "(no KPI-XXX ref) — skipped: %s",
            len(skipped_keys),
            ", ".join(sorted(skipped_keys)[:20]),
        )

    logger.info(
        "build_legacy_payload: %d rows ready for fact_portfolio_history "
        "(load_id=%s, source=legacy, quality=0.60)",
        len(rows), load_id[:8],
    )
    return rows


# =============================================================================
# CLI ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    _base = Path(__file__).resolve().parent.parent.parent
    _master_db = _base / "MasterDatabase"
    _output    = _base / "data" / "processed" / "portfolio_clean.csv"

    if not _master_db.exists():
        print(f"[ERROR] Directorio no encontrado: {_master_db}", file=sys.stderr)
        sys.exit(1)

    result = process_all(_master_db, output_path=_output)
    print(f"\nDataset final: {len(result):,} registros — guardado en {_output}")
