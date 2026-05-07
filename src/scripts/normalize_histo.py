#!/usr/bin/env python3
"""
normalize_histo.py — ETL pipeline for Cometa historical Excel data.

Reads:
  histo/Copy of Portfolio Data - CIII.xlsx  (Fondo CIII, 20 companies)
  histo/Copy of Portfolio Data - VII.xlsx   (Fondo VII, 10 companies)

Outputs:
  histo/legacy_ready.jsonl        — one JSON record per KPI·period row
  histo/load_stg_legacy.sql       — BigQuery DDL + staging load script
  histo/diagnostic_report.txt     — pre-run audit report

Run:
  .\\venv\\Scripts\\python.exe src/scripts/normalize_histo.py

Safety guarantee:
  This script NEVER writes to fact_kpi_values directly.
  All data lands in stg_legacy_fact_kpis. A human must review
  the validation query (STEP 3) before running the promotion INSERT (STEP 4).
"""

from __future__ import annotations

import io
import json
import re
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

# Force UTF-8 output on Windows (avoids cp1252 UnicodeEncodeError with emoji/arrows)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT         = Path(__file__).parent.parent.parent
HISTO        = ROOT / "histo"
CIII_FILE    = HISTO / "Copy of Portfolio Data - CIII.xlsx"
VII_FILE     = HISTO / "Copy of Portfolio Data - VII.xlsx"
OUTPUT_JSONL = HISTO / "legacy_ready.jsonl"
OUTPUT_SQL   = HISTO / "load_stg_legacy.sql"
OUTPUT_DIAG  = HISTO / "diagnostic_report.txt"

# ── Excel error sentinels ──────────────────────────────────────────────────────
EXCEL_ERRORS: frozenset[str] = frozenset({
    "#REF!", "#VALUE!", "#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#####",
})

# ── Catalog IDs (base/catalogo_maestro_final.md + base/DiccionarioYDiagrama.md) ──────
# fund_id:   F001 = Cometa CIII  |  F002 = Fondo VII
FUND_ID_MAP: dict[str, str] = {"CIII": "F001", "VII": "F002"}

# bucket_id: mirrors dim_bucket in the base data dictionary
BUCKET_ID_MAP: dict[str, str] = {
    "ALL":   "B01",
    "SAAS":  "B02",
    "ECOM":  "B03",
    "INSUR": "B04",
    "LEND":  "B05",
    "OTH":   "B06",
}

# metric_id: Kxxx per kpi_key — canonical per base/catalogo_maestro_final.md
METRIC_ID_MAP: dict[str, str] = {
    "revenue":                  "K001",
    "ebitda":                   "K002",
    "gross_profit_margin":      "K003",
    "ebitda_margin":            "K004",
    "revenue_growth":           "K005",
    "cash_in_bank_end_of_year": "K006",
    "annual_cash_flow":         "K007",
    "working_capital_debt":     "K008",
    "cogs":                     "K009",
    "mrr":                      "K010",
    "churn_rate":               "K011",
    "cac":                      "K012",
    "portfolio_size":           "K013",
    "npl_ratio":                "K014",
    "gmv":                      "K015",
    "loss_ratio":               "K016",
}

# Quarter → last calendar month (used to build PYYYYQxMyy period_id)
_Q_END_MONTH: dict[str, str] = {"1": "03", "2": "06", "3": "09", "4": "12"}


def to_canonical_period(internal_key: str) -> str:
    """Convert internal '2020-Q1' → canonical 'P2020Q1M03' per base/DiccionarioYDiagrama.md."""
    parts = internal_key.split("-Q")
    if len(parts) != 2:
        return internal_key  # passthrough for unexpected formats
    year, q = parts[0], parts[1]
    month = _Q_END_MONTH.get(q, "00")
    return f"P{year}Q{q}M{month}"


# ── Official KPI registry (mirrors src/core/db_writer.py DIM_METRIC + KPI_REGISTRY) ──
# kpi_key → { label, unit }
KPI_REGISTRY: dict[str, dict[str, str]] = {
    # Core financial — all sectors
    "revenue_growth":          {"label": "Revenue Growth",          "unit": "%"},
    "gross_profit_margin":     {"label": "Gross Profit Margin",      "unit": "%"},
    "ebitda_margin":           {"label": "EBITDA Margin",            "unit": "%"},
    "cash_in_bank_end_of_year":{"label": "Cash in Bank",            "unit": "$"},
    "annual_cash_flow":        {"label": "Annual Cash Flow",         "unit": "$"},
    "working_capital_debt":    {"label": "Working Capital Debt",     "unit": "$"},
    # Base metrics
    "revenue":                 {"label": "Total Revenue",            "unit": "$"},
    "ebitda":                  {"label": "EBITDA",                   "unit": "$"},
    "cogs":                    {"label": "Cost of Goods Sold",       "unit": "$"},
    # Sector metrics
    "mrr":                     {"label": "Monthly Recurring Revenue","unit": "$"},
    "churn_rate":              {"label": "Churn Rate",               "unit": "%"},
    "cac":                     {"label": "Customer Acquisition Cost","unit": "$"},
    "portfolio_size":          {"label": "Loan Portfolio Size",      "unit": "$"},
    "npl_ratio":               {"label": "Non-Performing Loan Ratio","unit": "%"},
    "gmv":                     {"label": "Gross Merchandise Value",  "unit": "$"},
    "loss_ratio":              {"label": "Loss Ratio",               "unit": "%"},
}

# ── Canonical KPI alias map ────────────────────────────────────────────────────
# Maps every Excel row-label variant → kpi_key from KPI_REGISTRY.
# Keys NOT in KPI_REGISTRY are intentionally excluded (the system won't store them).
KPI_ALIAS_MAP: dict[str, str] = {
    # ── Revenue & growth ──────────────────────────────────────────────────────
    "revenue":                    "revenue",
    "total revenue":              "revenue",
    "net revenue":                "revenue",
    "mrr":                        "mrr",
    "gmv":                        "gmv",
    "tpv":                        "gmv",
    "total sales volume":         "gmv",
    "total transaction value":    "gmv",
    # Excel growth labels → canonical revenue_growth
    "cmgr % (qoq)":              "revenue_growth",
    "qoq growth":                 "revenue_growth",
    "yoy growth":                 "revenue_growth",
    # ── Margins ───────────────────────────────────────────────────────────────
    "gross margin %":             "gross_profit_margin",
    "gross margin":               "gross_profit_margin",
    "ebitda margin %":            "ebitda_margin",
    "ebitda margin":              "ebitda_margin",
    # ── EBITDA / Cash ─────────────────────────────────────────────────────────
    "ebitda":                     "ebitda",
    "cash":                       "cash_in_bank_end_of_year",
    "cash & equivalents":         "cash_in_bank_end_of_year",
    "annual cash flow":           "annual_cash_flow",
    "cash flow":                  "annual_cash_flow",
    # ── COGS proxy (gross income ≈ revenue - COGS) ────────────────────────────
    "gross income":               "cogs",       # will be negated at derivation time — stored raw
    "gross profit":               "cogs",
    # ── SaaS ──────────────────────────────────────────────────────────────────
    "churn":                      "churn_rate",
    "churn %":                    "churn_rate",
    "churn rate":                 "churn_rate",
    "cac":                        "cac",
    "customer acquisition cost":  "cac",
    # ── Lending ───────────────────────────────────────────────────────────────
    "loan book":                  "portfolio_size",
    "loan portfolio":             "portfolio_size",
    "non performing loans":       "npl_ratio",
    "npl %":                      "npl_ratio",
    "npl":                        "npl_ratio",
    # ── Insurance ─────────────────────────────────────────────────────────────
    "loss ratio":                 "loss_ratio",
    "loss ratio %":               "loss_ratio",
    # ── Debt ──────────────────────────────────────────────────────────────────
    "debt":                       "working_capital_debt",
    "total debt":                 "working_capital_debt",
    "working capital debt":       "working_capital_debt",
}

# ── Company → native currency ──────────────────────────────────────────────────
# Default is USD.  Add exceptions for any company that reports in another currency.
COMPANY_CURRENCY: dict[str, str] = {
    "conekta":  "MXN",
    "ivoy":     "MXN",   # iVoy sheet labels currency as MXN in row 1
    "bewe":     "EUR",
}

# ── Company → sector bucket (EXACT mirror of src/core/db_writer.py COMPANY_BUCKET) ──
# Source of truth is db_writer.py — do NOT diverge from it.
COMPANY_BUCKET: dict[str, str] = {
    # Fondo VII
    "conekta":     "SAAS",
    "kueski":      "LEND",
    "mpower":      "LEND",
    "bnext":       "SAAS",
    "yotepresto":  "LEND",
    "ivoy":        "ECOM",
    "bewe":        "SAAS",
    "skydropx":    "ECOM",
    "fund_vii_overview": "ALL",  # COMP_FUND_VII_OVERVIEW — fund-level, all KPI types apply
    "gaia":        "SAAS",
    # Fondo CIII
    "simetrik":    "SAAS",
    "guros":       "INSUR",
    "quinio":      "ECOM",
    "hackmetrix":  "SAAS",
    "hunty":       "SAAS",
    "atani":       "OTH",
    "cluvi":       "SAAS",
    "kuona":       "SAAS",
    "prometeo":    "OTH",
    "territorium": "SAAS",
    "morgana":     "INSUR",
    "duppla":      "LEND",
    "kala":        "OTH",
    "pulsar":      "SAAS",
    "solvento":    "LEND",
    "numia":       "SAAS",
}

# ── KPI sector applicability (mirrors DIM_METRIC bucket_id in db_writer.py) ─────
# Only emit rows for a company when its COMPANY_BUCKET is in the allowed set.
# KPIs absent from this dict (bucket_id=ALL) apply to every sector including OTH.
KPI_SECTORS: dict[str, frozenset[str]] = {
    "gmv":            frozenset({"ECOM"}),
    "mrr":            frozenset({"SAAS"}),
    "churn_rate":     frozenset({"SAAS"}),
    "portfolio_size": frozenset({"LEND"}),
    "npl_ratio":      frozenset({"LEND"}),
    "loss_ratio":     frozenset({"INSUR"}),
}

# ── Excel sheet name → system canonical key ───────────────────────────────────
SHEET_TO_KEY: dict[str, str] = {
    # Fondo VII
    "welcome":    "fund_vii_overview",  # COMP_FUND_VII_OVERVIEW — consolidated Fondo VII view
    "conekta":    "conekta",
    "kueski":     "kueski",
    "mpower":     "mpower",
    "ytp":        "yotepresto",  # alias: YTP → yotepresto
    "skydropx":   "skydropx",
    "ivoy":       "ivoy",
    "bnext":      "bnext",
    "bewe":       "bewe",
    "gaia":       "gaia",        # COMP_GAIA — Fondo VII
    "bitso":      "__EXCLUDE__", # no data — sheet exists but is empty
    # Fondo CIII
    "simetrik":   "simetrik",
    "guros":      "guros",
    "quinio":     "quinio",
    "hackmetrix": "hackmetrix",
    "hunty":      "hunty",
    "atani":      "atani",
    "cluvi":      "cluvi",
    "kuona":      "kuona",
    "prometeo":   "prometeo",
    "morgana":    "morgana",
    "territorium":"territorium",
    "m1":         "__EXCLUDE__",  # removed — not a portfolio company
    "duppla":     "duppla",
    "kala":       "kala",
    "pulsar":     "pulsar",
    "solvento":   "solvento",
    "numia":      "numia",
    "r2":         "__EXCLUDE__",  # not a portfolio company
    "bd":         "__EXCLUDE__",  # summary matrix sheet, not a company
    "opp fund":   "__EXCLUDE__", # fund entity, not a portfolio company
}

# ── PORTFOLIO_MAP mirror (source of truth: src/core/db_writer.py) ─────────────
PORTFOLIO_MAP_KEYS: frozenset[str] = frozenset({
    "conekta", "kueski", "mpower", "bnext", "yotepresto", "ivoy",
    "bewe", "skydropx", "fund_vii_overview", "gaia",
    "simetrik", "guros", "quinio", "hackmetrix", "hunty", "atani",
    "cluvi", "kuona", "prometeo", "territorium", "morgana",
    "duppla", "kala", "pulsar", "solvento", "numia",
    # bd, m1 excluded — not portfolio companies
})

PORTFOLIO_FUND: dict[str, str] = {
    "conekta": "VII",  "kueski": "VII",   "mpower": "VII",   "bnext": "VII",
    "yotepresto": "VII", "ivoy": "VII",   "bewe": "VII",     "skydropx": "VII",
    "fund_vii_overview": "VII",            "gaia": "VII",
    "simetrik": "CIII","guros": "CIII",   "quinio": "CIII",  "hackmetrix": "CIII",
    "hunty": "CIII",   "atani": "CIII",   "cluvi": "CIII",   "kuona": "CIII",
    "prometeo": "CIII","territorium":"CIII",                   "morgana": "CIII",
    "duppla": "CIII",  "kala": "CIII",    "pulsar": "CIII",  "solvento": "CIII",
    "numia": "CIII",
}

# ── Meta/reference sheet patterns (never contain company P&L data) ────────────
# A sheet is skipped if its lowercased name starts-with or contains any of these.
_META_PATTERNS: tuple[str, ...] = (
    "summary", "chart", "annual", "burn analysis", "rounds", "sourcing",
    "fx", "revenues", "cash burn", "gross margin", "ebitda", "kpi 1",
    "kpi 2", "kpi 3", "cash", "holiday", "borrar", "mail merge",
    "sheet13", "copy of",
)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _is_meta_sheet(name: str) -> bool:
    n = name.lower().strip()
    return any(n.startswith(p) or p in n for p in _META_PATTERNS)


# Curly apostrophe (U+2019) appears in Excel quarter labels: Q1'20
_PERIOD_RE = re.compile(r"Q(\d)['\u2019](\d{2})")


def parse_period(label: str) -> Optional[str]:
    """'Q1\u201920' or "Q1'20" → '2020-Q1'.  Returns None if not a valid quarter."""
    m = _PERIOD_RE.match(str(label).strip())
    if not m:
        return None
    q, yr = m.group(1), int(m.group(2))
    return f"{2000 + yr}-Q{q}"


def clean_value(v: object) -> Optional[float]:
    """
    Convert a raw cell value to float or None (never coerces None to 0).

    Rules:
    - NaN / None / blank / Excel error strings → None
    - "NA", "N/A", "-"                         → None
    - Numeric string (possibly with commas)    → float
    - Already a number                         → float (if not NaN)
    """
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        if not s or s in EXCEL_ERRORS or s.upper() in ("NA", "N/A", "-", "—"):
            return None
        try:
            return float(s.replace(",", "").replace("%", ""))
        except ValueError:
            return None
    try:
        fv = float(v)  # type: ignore[arg-type]
        return None if (fv != fv) else fv  # NaN check without importing math
    except (TypeError, ValueError):
        return None


def normalize_kpi_key(raw: str) -> Optional[str]:
    """Map a raw Excel metric label to the canonical kpi_key. None if unknown."""
    cleaned = re.sub(r"\s+", " ", str(raw).strip().lower())
    return KPI_ALIAS_MAP.get(cleaned)


def kpi_label(kpi_key: str) -> str:
    """Return the human-readable label for a kpi_key from the registry."""
    return KPI_REGISTRY.get(kpi_key, {}).get("label", kpi_key)


def kpi_unit(kpi_key: str) -> str:
    """Return the canonical unit for a kpi_key from the registry."""
    return KPI_REGISTRY.get(kpi_key, {}).get("unit", "")


# ── FX loader ──────────────────────────────────────────────────────────────────

def load_fx_table(xl: pd.ExcelFile) -> dict[str, dict[str, float]]:
    """
    Parse the 'fx' sheet → { period_id → { currency_code → rate_to_usd } }

    rate_to_usd means: 1 unit of that currency = rate_to_usd USD.
    So to convert MXN amount to USD: amount / (1 USD → MXN rate)
                                  = amount * rate_to_usd
    """
    fx: dict[str, dict[str, float]] = {}
    try:
        df = xl.parse("fx", header=None, dtype=object)
    except Exception:
        return fx

    # Locate the header row (contains ≥2 quarter patterns like Q1'20)
    header_idx: Optional[int] = None
    for i, row in df.iterrows():
        hits = sum(
            1 for c in row
            if pd.notna(c) and _PERIOD_RE.search(str(c))
        )
        if hits >= 2:
            header_idx = int(str(i))
            break

    if header_idx is None:
        # Fallback: look for period labels in the first column as row index
        _parse_fx_row_oriented(df, fx)
        return fx

    # Header row contains period labels as column names
    df.columns = [str(c) if pd.notna(c) else "" for c in df.iloc[header_idx]]
    df = df.iloc[header_idx + 1:].reset_index(drop=True)

    # Find the period-label column (first col that has Q patterns in values)
    period_col: Optional[str] = None
    for col in df.columns:
        vals = df[col].dropna().astype(str)
        if vals.apply(lambda x: bool(_PERIOD_RE.match(x))).sum() > 3:
            period_col = col
            break
    if period_col is None:
        period_col = df.columns[0]

    for _, row in df.iterrows():
        period = parse_period(str(row.get(period_col, "")))
        if not period:
            continue
        fx.setdefault(period, {})
        for col in df.columns:
            if col == period_col:
                continue
            col_l = col.lower()
            val = clean_value(row.get(col))
            if val is None or val <= 0:
                continue
            # Column names like "1 USD = X MXN" → 1 MXN = 1/X USD
            if "mxn" in col_l:
                fx[period]["MXN"] = (1.0 / val) if ("usd" in col_l) else val
            elif "eur" in col_l and "usd" in col_l:
                # "1 EUR = X USD" → rate is direct USD
                # "1 USD = X EUR" → invert
                is_eur_base = col_l.startswith("1 eur") or col_l.startswith("eur")
                fx[period]["EUR"] = val if is_eur_base else (1.0 / val)
            elif "cop" in col_l and "usd" in col_l:
                fx[period]["COP"] = 1.0 / val

    return fx


def _parse_fx_row_oriented(df: pd.DataFrame, fx: dict) -> None:
    """Fallback FX parser for row-oriented layouts (periods as rows, currencies as cols)."""
    for _, row in df.iterrows():
        vals = [str(c) for c in row if pd.notna(c)]
        period_hits = [v for v in vals if _PERIOD_RE.match(v)]
        if not period_hits:
            continue
        period = parse_period(period_hits[0])
        if not period:
            continue
        fx.setdefault(period, {})
        numeric_vals = [clean_value(c) for c in row if pd.notna(c) and not _PERIOD_RE.match(str(c))]
        numeric_vals = [v for v in numeric_vals if v is not None and v > 0]
        # Heuristic: first large number is MXN rate (typically 17–25)
        for v in numeric_vals:
            if 15 < v < 30 and "MXN" not in fx[period]:
                fx[period]["MXN"] = 1.0 / v
            elif 0.8 < v < 1.5 and "EUR" not in fx[period]:
                fx[period]["EUR"] = v  # assume EUR/USD


# ── Company sheet parser ───────────────────────────────────────────────────────

def parse_company_sheet(
    sheet_name: str,
    xl: pd.ExcelFile,
    fx_table: dict[str, dict[str, float]],
    default_portfolio_id: str,
    ingested_at: str,
) -> list[dict]:
    """
    Parse one company sheet and return a list of long-format KPI records.

    Each record schema mirrors fact_kpi_values with extra legacy columns:
      id, company_id, kpi_key, period_id, value, currency_original,
      normalized_value_usd, portfolio_id, is_valid, confidence_score,
      source_description, created_at, last_upload_at
    """
    records: list[dict] = []
    # Deduplication guard: some sheets have two metric rows that map to the same
    # kpi_key (e.g. "CMGR % (QoQ)" and "QoQ Growth" both → revenue_growth).
    # We keep the first non-null value encountered for each (kpi_key, period_id).
    _seen: dict[tuple[str, str], int] = {}  # (kpi_key, period_id) → index in records

    system_key = SHEET_TO_KEY.get(sheet_name.lower().strip())
    if system_key is None:
        # Derive from sheet name if not in map
        system_key = re.sub(r"[^a-z0-9]", "_", sheet_name.lower().strip()).strip("_")
    if system_key == "__EXCLUDE__":
        return records

    portfolio_id = PORTFOLIO_FUND.get(system_key, default_portfolio_id)
    currency     = COMPANY_CURRENCY.get(system_key, "USD")

    try:
        df_raw = xl.parse(sheet_name, header=None, dtype=object)
    except Exception as exc:
        print(f"  ⚠️  Could not read '{sheet_name}': {exc}", file=sys.stderr)
        return records

    # ── Detect header row (has ≥2 quarter-pattern columns) ──────────────────
    header_row_idx: Optional[int] = None
    for i, row in df_raw.iterrows():
        hits = sum(1 for c in row if pd.notna(c) and _PERIOD_RE.match(str(c).strip()))
        if hits >= 2:
            header_row_idx = int(str(i))
            break

    if header_row_idx is None:
        print(f"  ⚠️  No quarter columns found in '{sheet_name}' — skipping", file=sys.stderr)
        return records

    header_cells = list(df_raw.iloc[header_row_idx])

    # Map column index → period_id for all quarter columns
    period_col_map: dict[int, str] = {}
    for col_idx, cell in enumerate(header_cells):
        pid = parse_period(str(cell))
        if pid:
            period_col_map[col_idx] = pid

    if not period_col_map:
        return records

    # Metric label is in column 0 (first column)
    metric_col_idx = 0

    # ── Iterate data rows ────────────────────────────────────────────────────
    for row_idx in range(header_row_idx + 1, len(df_raw)):
        row = df_raw.iloc[row_idx]

        raw_label = row.iloc[metric_col_idx] if pd.notna(row.iloc[metric_col_idx]) else ""
        metric_raw = str(raw_label).strip()
        if not metric_raw or metric_raw.lower() in ("nan", "none", ""):
            continue  # blank row

        kpi_key = normalize_kpi_key(metric_raw)
        if kpi_key is None:
            continue  # section header or unknown metric — skip

        # Skip KPIs that don't apply to this company's sector.
        # e.g. gmv is only for ECOM — blank rows in Excel template are NOT real gaps.
        # bucket="ALL" (fund overviews) bypasses sector filtering — all KPI types apply.
        bucket = COMPANY_BUCKET.get(system_key, "OTH")
        allowed_sectors = KPI_SECTORS.get(kpi_key)
        if allowed_sectors and bucket != "ALL" and bucket not in allowed_sectors:
            continue  # sector-irrelevant KPI — skip entire metric row

        for col_idx, period_key in period_col_map.items():
            # Skip periods beyond 2025 — do not touch 2026+ data (compare on internal key)
            if period_key > "2025-Q4":
                continue
            period_id = to_canonical_period(period_key)  # PYYYYQxMyy

            raw_cell = row.iloc[col_idx] if col_idx < len(row) else None
            raw_str  = str(raw_cell).strip() if raw_cell is not None else ""

            # Skip #DIV/0! / #REF! in revenue_growth — formula artifact when the
            # company has no prior quarter to compute QoQ growth (inaugural period).
            if kpi_key == "revenue_growth" and raw_str in ("#DIV/0!", "#REF!"):
                continue

            # Detect explicit Excel errors — these become missing_legacy rows
            is_excel_error = raw_str in EXCEL_ERRORS

            value = clean_value(raw_cell)
            dedup_key = (kpi_key, period_id)

            if value is None:
                # Only emit a sentinel NULL if no row exists yet for this (kpi, period).
                # This avoids duplicate missing_legacy rows from alias collisions.
                if dedup_key in _seen:
                    continue
                comp_id_canonical = f"COMP_{system_key.upper()}"
                # Emit a sentinel NULL row so analysts can fill it in the dashboard
                records.append({
                    "id":                   str(uuid.uuid4()),
                    "company_id":           comp_id_canonical,
                    "metric_id":            METRIC_ID_MAP.get(kpi_key, ""),
                    "kpi_key":              kpi_key,
                    "kpi_label":            kpi_label(kpi_key),
                    "period_id":            period_id,
                    "raw_value":            raw_str if raw_str else None,
                    "numeric_value":        None,
                    "unit":                 kpi_unit(kpi_key),
                    "currency_original":    currency,
                    "normalized_value_usd": None,
                    "fx_rate":              None,
                    "fund_id":              FUND_ID_MAP.get(portfolio_id, ""),
                    "bucket_id":            BUCKET_ID_MAP.get(bucket, "B06"),
                    "portfolio_id":         portfolio_id,
                    "is_valid":             False,
                    "value_status":         "excel_error" if is_excel_error else "missing_legacy",
                    "confidence_score":     1.0,
                    "source_description":   "Legacy Portfolio",
                    "created_at":           ingested_at,
                    "last_upload_at":       ingested_at,
                })
                _seen[dedup_key] = len(records) - 1
                continue

            # FX: convert to USD when needed
            if currency == "USD":
                value_usd = value
                fx_rate   = 1.0
            else:
                fx_rate   = fx_table.get(period_id, {}).get(currency)
                value_usd = round(value * fx_rate, 6) if fx_rate else None

            comp_id_canonical = f"COMP_{system_key.upper()}"
            if dedup_key in _seen:
                existing_idx = _seen[dedup_key]
                if records[existing_idx]["value_status"] == "missing_legacy":
                    records[existing_idx] = {
                        "id":                   records[existing_idx]["id"],
                        "company_id":           comp_id_canonical,
                        "metric_id":            METRIC_ID_MAP.get(kpi_key, ""),
                        "kpi_key":              kpi_key,
                        "kpi_label":            kpi_label(kpi_key),
                        "period_id":            period_id,
                        "raw_value":            raw_str,
                        "numeric_value":        value,
                        "unit":                 kpi_unit(kpi_key),
                        "currency_original":    currency,
                        "normalized_value_usd": value_usd,
                        "fx_rate":              fx_rate,
                        "fund_id":              FUND_ID_MAP.get(portfolio_id, ""),
                        "bucket_id":            BUCKET_ID_MAP.get(bucket, "B06"),
                        "portfolio_id":         portfolio_id,
                        "is_valid":             True,
                        "value_status":         "valid",
                        "confidence_score":     1.0,
                        "source_description":   "Legacy Portfolio",
                        "created_at":           ingested_at,
                        "last_upload_at":       ingested_at,
                    }
                continue  # skip duplicate — first valid value wins

            new_record = {
                "id":                   str(uuid.uuid4()),
                "company_id":           comp_id_canonical,
                "metric_id":            METRIC_ID_MAP.get(kpi_key, ""),
                "kpi_key":              kpi_key,
                "kpi_label":            kpi_label(kpi_key),
                "period_id":            period_id,
                "raw_value":            raw_str,
                "numeric_value":        value,
                "unit":                 kpi_unit(kpi_key),
                "currency_original":    currency,
                "normalized_value_usd": value_usd,
                "fx_rate":              fx_rate,
                "fund_id":              FUND_ID_MAP.get(portfolio_id, ""),
                "bucket_id":            BUCKET_ID_MAP.get(bucket, "B06"),
                "portfolio_id":         portfolio_id,
                "is_valid":             True,
                "value_status":         "valid",
                "confidence_score":     1.0,
                "source_description":   "Legacy Portfolio",
                "created_at":           ingested_at,
                "last_upload_at":       ingested_at,
            }
            records.append(new_record)
            _seen[dedup_key] = len(records) - 1

    return records


# ── Workbook processor ─────────────────────────────────────────────────────────

def process_workbook(
    file_path: Path,
    expected_portfolio: str,
    ingested_at: str,
) -> tuple[list[dict], list[str], list[str]]:
    """
    Open a workbook, extract all company sheets.

    Returns:
        all_records    — list of long-format KPI dicts
        processed_log  — human-readable log of processed sheets
        skipped_log    — human-readable log of skipped sheets
    """
    all_records: list[dict] = []
    processed_log: list[str] = []
    skipped_log:   list[str] = []

    print(f"\n[open] {file_path.name}", flush=True)
    xl = pd.ExcelFile(file_path, engine="openpyxl")

    # Load FX table once per workbook
    fx_table = load_fx_table(xl)
    print(
        f"   [fx] {len(fx_table)} periods loaded, "
        f"currencies: {sorted({c for p in fx_table.values() for c in p})}",
        flush=True,
    )

    for sheet in xl.sheet_names:
        if _is_meta_sheet(sheet):
            skipped_log.append(sheet)
            continue

        sheet_lower = sheet.lower().strip()
        mapped_key  = SHEET_TO_KEY.get(sheet_lower)

        if mapped_key == "__EXCLUDE__":
            skipped_log.append(f"{sheet} [fund entity — excluded]")
            continue

        records = parse_company_sheet(
            sheet_name=sheet,
            xl=xl,
            fx_table=fx_table,
            default_portfolio_id=expected_portfolio,
            ingested_at=ingested_at,
        )
        all_records.extend(records)
        system_key = mapped_key or re.sub(r"[^a-z0-9]", "_", sheet_lower).strip("_")
        processed_log.append(f"{sheet:<16} → {system_key:<16}  ({len(records):>5,} rows)")

    return all_records, processed_log, skipped_log


# ── SQL generator ──────────────────────────────────────────────────────────────

def _generate_sql(project: str = "cometa-mvp", dataset: str = "cometa_vault") -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return f"""-- ================================================================
-- Cometa Legacy ETL — Staging Load Script
-- Generated : {ts}
-- Source    : histo/legacy_ready.jsonl
-- Staging   : {project}.{dataset}.stg_legacy_fact_kpis
-- Production: {project}.{dataset}.fact_kpi_values
-- ================================================================

-- ── STEP 0: Create dim_company master catalogue ───────────────────
-- Run ONCE. entity_type distinguishes portfolio startups from fund overviews.

CREATE OR REPLACE TABLE `{project}.{dataset}.dim_company` (
  comp_id       STRING NOT NULL,
  company_id    STRING NOT NULL,
  display_name  STRING,
  portfolio_id  STRING NOT NULL,
  entity_type   STRING NOT NULL,   -- 'COMPANY' | 'FUND_OVERVIEW'
  sector        STRING,            -- 'SAAS'|'LEND'|'ECOM'|'INSUR'|'OTH'|NULL
  is_active     BOOL   NOT NULL
);

INSERT INTO `{project}.{dataset}.dim_company`
  (comp_id, company_id, display_name, portfolio_id, entity_type, sector, is_active)
VALUES
  -- Fondo VII — OVERVIEW
  ('COMP_FUND_VII_OVERVIEW', 'fund_vii_overview', 'Fondo VII — Overview Consolidado', 'VII', 'FUND_OVERVIEW', NULL,    TRUE),
  -- Fondo VII — companies
  ('COMP_CONEKTA',    'conekta',    'Conekta',    'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_KUESKI',     'kueski',     'Kueski',     'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_MPOWER',     'mpower',     'MPower',     'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_BNEXT',      'bnext',      'Bnext',      'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_YOTEPRESTO', 'yotepresto', 'YoTePresto', 'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_IVOY',       'ivoy',       'iVoy',       'VII',  'COMPANY', 'ECOM',  TRUE),
  ('COMP_BEWE',       'bewe',       'Bewe',       'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_SKYDROPX',   'skydropx',   'Skydropx',   'VII',  'COMPANY', 'ECOM',  TRUE),
  ('COMP_GAIA',       'gaia',       'Gaia',       'VII',  'COMPANY', 'SAAS',  TRUE),
  -- Fondo CIII — companies
  ('COMP_SIMETRIK',    'simetrik',    'Simetrik',    'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_GUROS',       'guros',       'Guros',       'CIII', 'COMPANY', 'INSUR', TRUE),
  ('COMP_QUINIO',      'quinio',      'Quinio',      'CIII', 'COMPANY', 'ECOM',  TRUE),
  ('COMP_HACKMETRIX',  'hackmetrix',  'Hackmetrix',  'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_HUNTY',       'hunty',       'Hunty',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_ATANI',       'atani',       'Atani',       'CIII', 'COMPANY', 'OTH',   TRUE),
  ('COMP_CLUVI',       'cluvi',       'Cluvi',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_KUONA',       'kuona',       'Kuona',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_PROMETEO',    'prometeo',    'Prometeo',    'CIII', 'COMPANY', 'OTH',   TRUE),
  ('COMP_TERRITORIUM', 'territorium', 'Territorium', 'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_MORGANA',     'morgana',     'Morgana',     'CIII', 'COMPANY', 'INSUR', TRUE),
  ('COMP_DUPPLA',      'duppla',      'Duppla',      'CIII', 'COMPANY', 'LEND',  TRUE),
  ('COMP_KALA',        'kala',        'Kala',        'CIII', 'COMPANY', 'OTH',   TRUE),
  ('COMP_PULSAR',      'pulsar',      'Pulsar',      'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_SOLVENTO',    'solvento',    'Solvento',    'CIII', 'COMPANY', 'LEND',  TRUE),
  ('COMP_NUMIA',       'numia',       'Numia',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_R2',          'r2',          'R2',          'CIII', 'COMPANY', 'LEND',  TRUE);

-- ── STEP 1: Create (or replace) the staging table ────────────────
-- Schema is aligned with base/DiccionarioYDiagrama.md (fact_kpi contract)
CREATE OR REPLACE TABLE `{project}.{dataset}.stg_legacy_fact_kpis` (
  id                    STRING    NOT NULL,
  company_id            STRING    NOT NULL,   -- COMP_* format  (e.g. 'COMP_SIMETRIK')
  metric_id             STRING,               -- Kxxx format    (e.g. 'K001')
  kpi_key               STRING    NOT NULL,   -- snake_case name (e.g. 'revenue')
  kpi_label             STRING,
  period_id             STRING    NOT NULL,   -- PYYYYQxMyy     (e.g. 'P2020Q1M03')
  raw_value             STRING,
  numeric_value         FLOAT64,
  unit                  STRING,
  currency_original     STRING,
  normalized_value_usd  FLOAT64,
  fx_rate               FLOAT64,
  fund_id               STRING,               -- F001 / F002
  bucket_id             STRING,               -- B01-B06
  portfolio_id          STRING,               -- 'CIII' | 'VII'  (legacy label)
  is_valid              BOOL,
  value_status          STRING,               -- 'valid' | 'missing_legacy' | 'excel_error'
  confidence_score      FLOAT64,
  source_description    STRING,
  created_at            TIMESTAMP,
  last_upload_at        TIMESTAMP
);

-- ── STEP 2: Load JSONL from GCS ──────────────────────────────────
-- Upload command (run from repo root):
--   gsutil cp histo/legacy_ready.jsonl \\
--     gs://ingesta-financiera-raw-cometa-mvp/legacy/legacy_ready.jsonl

LOAD DATA INTO `{project}.{dataset}.stg_legacy_fact_kpis`
FROM FILES (
  format                = 'NEWLINE_DELIMITED_JSON',
  uris                  = ['gs://ingesta-financiera-raw-cometa-mvp/legacy/legacy_ready.jsonl'],
  ignore_unknown_values = TRUE
);

-- ── STEP 3: Validate — REVIEW BEFORE PROCEEDING ──────────────────
SELECT
  s.company_id,
  d.display_name,
  d.entity_type,
  s.portfolio_id,
  COUNT(*)                                                          AS total_rows,
  COUNTIF(s.value_status = 'valid')                                AS valid_rows,
  COUNTIF(s.value_status = 'missing_legacy')                       AS missing_rows,
  COUNT(DISTINCT s.kpi_key)                                        AS distinct_kpis,
  MIN(s.period_id)                                                 AS earliest_period,
  MAX(s.period_id)                                                 AS latest_period,
  COUNTIF(s.normalized_value_usd IS NULL
          AND s.currency_original != 'USD'
          AND s.value_status = 'valid')                            AS missing_fx_rows
FROM `{project}.{dataset}.stg_legacy_fact_kpis` s
LEFT JOIN `{project}.{dataset}.dim_company` d USING (comp_id)
GROUP BY 1, 2, 3, 4
ORDER BY d.entity_type DESC, s.portfolio_id, s.company_id;

-- ── STEP 4: Promote to production (ONLY after reviewing STEP 3) ──
-- Safety gates:
--   1. value_status = 'valid'   — never insert missing_legacy
--   2. period_id <= '2025-Q4'   — never touch 2026+ data
--   3. NOT EXISTS               — never overwrite existing rows
--
-- INSERT INTO `{project}.{dataset}.fact_kpi`
--   (submission_id, company_id, fund_id, bucket_id, period_id, metric_id,
--    value, value_status, notes, created_at)
-- SELECT
--   CONCAT('LEGACY_', s.id)                         AS submission_id,
--   s.company_id,
--   s.fund_id,
--   s.bucket_id,
--   s.period_id,
--   s.metric_id,
--   COALESCE(s.normalized_value_usd, s.numeric_value) AS value,
--   'reported'                                       AS value_status,
--   s.source_description                             AS notes,
--   s.created_at
-- FROM `{project}.{dataset}.stg_legacy_fact_kpis` s
-- WHERE s.value_status = 'valid'
--   AND s.period_id <= 'P2025Q4M12'                 -- gate: no 2026+ data
--   AND NOT EXISTS (
--     SELECT 1 FROM `{project}.{dataset}.fact_kpi` p
--     WHERE p.company_id = s.company_id
--       AND p.metric_id  = s.metric_id
--       AND p.period_id  = s.period_id
--   );

-- ── STEP 5: Audit after promotion ────────────────────────────────
-- SELECT d.entity_type, f.portfolio_id, COUNT(*) AS rows_loaded, MIN(f.created_at) AS load_ts
-- FROM `{project}.{dataset}.fact_kpi_values` f
-- LEFT JOIN `{project}.{dataset}.dim_company` d USING (comp_id)
-- WHERE f.source_description = 'Legacy Portfolio'
-- GROUP BY 1, 2 ORDER BY 1, 2;
"""


# ── Main ───────────────────────────────────────────────────────────────────────

def run() -> None:  # noqa: C901 (complexity OK for a single-run ETL script)
    ingested_at = datetime.now(timezone.utc).isoformat()
    now_ts      = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    all_records:   list[dict] = []
    report_lines:  list[str]  = []

    # ── Process both workbooks ───────────────────────────────────────────────
    workbook_logs: list[tuple[str, list[str], list[str]]] = []
    for file_path, expected_fund in [(CIII_FILE, "CIII"), (VII_FILE, "VII")]:
        if not file_path.exists():
            print(f"❌ FILE NOT FOUND: {file_path}", file=sys.stderr)
            workbook_logs.append((file_path.name, [], [f"FILE NOT FOUND: {file_path}"]))
            continue
        records, processed, skipped = process_workbook(file_path, expected_fund, ingested_at)
        all_records.extend(records)
        workbook_logs.append((file_path.name, processed, skipped))

    # ── Discrepancy analysis ─────────────────────────────────────────────────
    found_keys         = {r["company_id"] for r in all_records}
    in_system_not_xl   = PORTFOLIO_MAP_KEYS - found_keys
    in_xl_not_system   = found_keys - PORTFOLIO_MAP_KEYS

    # ── Stats ────────────────────────────────────────────────────────────────
    kpi_counts     = Counter(r["kpi_key"]     for r in all_records)
    company_counts = Counter(r["company_id"]  for r in all_records)
    period_set     = sorted({r["period_id"]   for r in all_records})
    fx_missing     = sum(
        1 for r in all_records
        if r["currency_original"] != "USD" and r["normalized_value_usd"] is None
    )

    # ── Build diagnostic report ──────────────────────────────────────────────
    sep  = "=" * 68
    thin = "─" * 68

    report_lines = [
        sep,
        "  COMETA HISTORICAL ETL -- DIAGNOSTIC REPORT",
        f"  Generated: {now_ts}",
        sep,
        "",
    ]

    for wb_name, processed, skipped in workbook_logs:
        report_lines.append(f"[FILE]  {wb_name}")
        report_lines.append(f"    [OK]  Company sheets processed ({len(processed)}):")
        for p in processed:
            report_lines.append(f"         · {p}")
        report_lines.append(f"    [SKIP] Meta sheets skipped ({len(skipped)}):")
        for s in skipped:
            report_lines.append(f"         · {s}")
        report_lines.append("")

    report_lines += [
        thin,
        "  DISCREPANCY ANALYSIS",
        thin,
        "",
        f"  Companies found in Excel:             {len(found_keys)}",
        f"  Companies in PORTFOLIO_MAP (system):  {len(PORTFOLIO_MAP_KEYS)}",
        "",
        "  ⚠️  IN SYSTEM but NOT found in Excel — no historical data will load:",
    ]
    for k in sorted(in_system_not_xl):
        fund = PORTFOLIO_FUND.get(k, "?")
        report_lines.append(f"       · {k:<18}  [{fund}]")

    report_lines += [
        "",
        "  ⚠️  IN EXCEL but NOT in system PORTFOLIO_MAP — need entry or exclusion:",
    ]
    for k in sorted(in_xl_not_system):
        report_lines.append(f"       · {k}")

    report_lines += [
        "",
        thin,
        "  OUTPUT SUMMARY",
        thin,
        f"  Total KPI rows generated:  {len(all_records):,}",
        f"  Distinct companies:        {len(company_counts)}",
        f"  Distinct KPI keys:         {len(kpi_counts)}",
        f"  Period range:              "
        f"{period_set[0] if period_set else '—'} → {period_set[-1] if period_set else '—'}",
        f"  FX conversion failures:    {fx_missing:,}  "
        f"(non-USD rows where no FX rate found for that period)",
        "",
        "  Top KPI keys by row count:",
    ]
    for k, cnt in kpi_counts.most_common(12):
        report_lines.append(f"       {k:<32} {cnt:>6,}")

    report_lines += [
        "",
        "  Rows per company (descending):",
    ]
    for k, cnt in sorted(company_counts.items(), key=lambda x: -x[1]):
        fund = PORTFOLIO_FUND.get(k, "?")
        report_lines.append(f"       {k:<20} [{fund}]  {cnt:>6,}")

    report_lines += [
        "",
        thin,
        "  FILES GENERATED",
        thin,
        f"  {OUTPUT_JSONL}",
        f"  {OUTPUT_SQL}",
        f"  {OUTPUT_DIAG}",
        "",
        "  NEXT STEPS",
        "  1. Review this report — confirm discrepancies are acceptable.",
        "  2. gsutil cp histo/legacy_ready.jsonl \\",
        "       gs://ingesta-financiera-raw-cometa-mvp/legacy/legacy_ready.jsonl",
        "  3. Run STEP 1 and STEP 2 of load_stg_legacy.sql in BigQuery console.",
        "  4. Run STEP 3 (validation query) — review every row looks correct.",
        "  5. Uncomment and run STEP 4 (INSERT) only after review approval.",
        sep,
    ]

    report_text = "\n".join(report_lines)

    # ── Write outputs ────────────────────────────────────────────────────────
    print(f"\n{report_text}")

    OUTPUT_DIAG.write_text(report_text, encoding="utf-8")

    with OUTPUT_JSONL.open("w", encoding="utf-8") as f:
        for rec in all_records:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")

    OUTPUT_SQL.write_text(_generate_sql(), encoding="utf-8")

    print(f"\n📄 Diagnostic : {OUTPUT_DIAG}")
    print(f"📦 JSONL      : {OUTPUT_JSONL}  ({len(all_records):,} records)")
    print(f"🗄️  SQL        : {OUTPUT_SQL}")
    print("\n✅ ETL complete — review diagnostic_report.txt before loading to BigQuery.")


if __name__ == "__main__":
    run()
