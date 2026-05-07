"""
vc_validator.py
───────────────
Cerebro — Capa de pre-validacion entre la extraccion de Gemini y la Vista de Analista.

Aplica reglas de fisica financiera VC y calcula cross-checks derivados ANTES de
presentar los datos al analista para su aprobacion.

Reglas:
  REQUIRED_VC_KPIS : Revenue, Cash in Bank, EBITDA, Burn Rate, Runway, Headcount
  Cross-checks     : Net Burn = |annual_cash_flow| / 12 (si es negativo)
                     Runway   = Cash in Bank / Net Burn mensual
  Fisica financiera:
    VIO-001 — EBITDA > Revenue (algebraicamente imposible)
    VIO-002 — Cash in Bank < 0 (saldo imposible)
    VIO-003 — Runway <= 0 con caja y burn presentes
    VIO-004 — Gross Margin > 100 % o < -100 %

Outputs:
  enriched_rows   — kpi_rows originales + campos physics_violation + cerebro_alert
  derived_rows    — filas calculadas (net_burn, runway_months) no presentes en Gemini
  violations      — lista de mensajes de error de fisica
  missing_required— KPIs obligatorios ausentes
  cross_checks    — dict de metricas derivadas calculadas
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from src.schemas import UnifiedKPIContract


# ── KPIs requeridos para el dashboard VC ────────────────────────────────────

REQUIRED_VC_KPIS: list[str] = [
    "revenue",
    "cash_in_bank_end_of_year",
    "ebitda",
    "annual_cash_flow",       # proxy de burn rate
    "gross_profit_margin",
]

# KPIs opcionales que enriquecen el cuadro si estan presentes
OPTIONAL_VC_KPIS: list[str] = [
    "revenue_growth",
    "ebitda_margin",
    "mrr",
    "churn_rate",
    "cac",
]

# KPIs requeridos para validate_financial_physics() — usa metric_ids del catálogo
# de 109 KPIs (sin alias legacy). "cash" en lugar de "cash_in_bank_end_of_year".
_REQUIRED_UNIFIED: list[str] = [
    "revenue",
    "cash",              # canonical id para saldo de caja
    "ebitda",
    "annual_cash_flow",  # proxy de burn si "burn" no está presente
    "gross_profit_margin",
]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _val_index(kpi_rows: list[dict]) -> dict[str, float]:
    """Construye indice kpi_key -> numeric_value para KPIs validos."""
    return {
        r["kpi_key"]: r["numeric_value"]
        for r in kpi_rows
        if r.get("is_valid") and r.get("numeric_value") is not None
    }


def _fmt(value: float, unit: Optional[str] = None) -> str:
    """Formatea un numero para mensajes de alerta."""
    if unit == "%":
        return f"{value:.2f}%"
    if unit in ("$", "$M", "$K"):
        if abs(value) >= 1_000_000:
            return f"${value / 1_000_000:.2f}M"
        if abs(value) >= 1_000:
            return f"${value / 1_000:.1f}K"
        return f"${value:,.0f}"
    return f"{value:,.2f}"


# ── Motor de validacion ──────────────────────────────────────────────────────

def run_cerebro(kpi_rows: list[dict]) -> dict:
    """
    Aplica las reglas del Cerebro a la lista de kpi_rows del contrato de datos.

    Parameters
    ----------
    kpi_rows : list[dict]
        Filas del contrato generado por build_contract() en data_contract.py.
        Cada fila contiene: kpi_key, kpi_label, numeric_value, unit, is_valid,
        confidence, source_description, raw_value, period_id, etc.

    Returns
    -------
    {
        "enriched_rows"        : list[dict]  — filas originales enriquecidas
        "derived_rows"         : list[dict]  — filas calculadas (net_burn, runway)
        "violations"           : list[str]   — mensajes de fisica violada
        "missing_required"     : list[str]   — KPIs requeridos ausentes
        "has_physics_violations": bool
        "cross_checks"         : dict        — metricas derivadas calculadas
        "approval_blocked"     : bool        — True si hay fisica violada sin resolver
    }
    """
    idx = _val_index(kpi_rows)
    violations: list[str] = []
    enriched: list[dict]  = []

    for row in kpi_rows:
        enriched_row = dict(row)
        # Inicializar campos del Cerebro si no existen
        enriched_row.setdefault("physics_violation", False)
        enriched_row.setdefault("cerebro_alert", None)

        key   = row.get("kpi_key", "")
        value = row.get("numeric_value")
        unit  = row.get("unit")

        if value is None:
            enriched.append(enriched_row)
            continue

        # ── VIO-001: EBITDA > Revenue ────────────────────────────────────────
        if key == "ebitda":
            revenue = idx.get("revenue")
            if revenue is not None and value > revenue:
                msg = (
                    f"VIO-001 — EBITDA ({_fmt(value)}) supera Revenue ({_fmt(revenue)}). "
                    "Esto es algebraicamente imposible; revisa las cifras del reporte."
                )
                enriched_row["physics_violation"] = True
                enriched_row["cerebro_alert"]     = msg
                violations.append(msg)

        # ── VIO-002: Cash in Bank < 0 ────────────────────────────────────────
        elif key == "cash_in_bank_end_of_year" and value < 0:
            msg = (
                f"VIO-002 — Cash in Bank ({_fmt(value, '$')}) es negativo. "
                "Un saldo de caja no puede ser menor a cero; verifica el PDF."
            )
            enriched_row["physics_violation"] = True
            enriched_row["cerebro_alert"]     = msg
            violations.append(msg)

        # ── VIO-004: Gross Margin fuera de rango [-100%, 100%] ───────────────
        elif key == "gross_profit_margin" and (value > 100.0 or value < -100.0):
            msg = (
                f"VIO-004 — Gross Profit Margin ({_fmt(value, '%')}) fuera del rango "
                "[-100%, 100%]. Verifica si el valor esta en decimales o en porcentaje."
            )
            enriched_row["physics_violation"] = True
            enriched_row["cerebro_alert"]     = msg
            violations.append(msg)

        enriched.append(enriched_row)

    # ── Calculo de Net Burn y Runway ─────────────────────────────────────────
    derived: list[dict] = []
    cross_checks: dict  = {
        "net_burn_computed":   False,
        "net_burn_monthly":    None,
        "runway_computed":     False,
        "runway_months":       None,
    }

    cash      = idx.get("cash_in_bank_end_of_year")
    cash_flow = idx.get("annual_cash_flow")   # negativo = empresa quemando caja
    period_id = kpi_rows[0].get("period_id", "") if kpi_rows else ""
    sub_id    = kpi_rows[0].get("submission_id", "") if kpi_rows else ""

    if cash_flow is not None and cash_flow < 0:
        net_burn_monthly = abs(cash_flow) / 12.0

        if "net_burn" not in idx:
            derived.append({
                "submission_id":      sub_id,
                "kpi_key":            "net_burn",
                "kpi_label":          "Net Burn (Monthly, calc.)",
                "raw_value":          _fmt(net_burn_monthly, "$"),
                "numeric_value":      round(net_burn_monthly, 2),
                "unit":               "$",
                "period_id":          period_id,
                "source_description": "cerebro_calculated",
                "is_valid":           True,
                "physics_violation":  False,
                "cerebro_alert":      None,
                "confidence":         0.90,
                "original_currency":  "USD",
                "fx_rate":            1.0,
                "normalized_value_usd": round(net_burn_monthly, 2),
            })
            cross_checks["net_burn_computed"]  = True
            cross_checks["net_burn_monthly"]   = round(net_burn_monthly, 2)

        # ── Runway = Cash / Net Burn mensual ──────────────────────────────────
        if cash is not None and net_burn_monthly > 0 and "runway_months" not in idx:
            runway = cash / net_burn_monthly
            is_violation = runway <= 0

            if is_violation:
                msg = (
                    f"VIO-003 — Runway ({runway:.1f} meses) es <= 0 con Cash={_fmt(cash, '$')} "
                    f"y Net Burn={_fmt(net_burn_monthly, '$')}/mes. Urgente revisión."
                )
                violations.append(msg)

            derived.append({
                "submission_id":      sub_id,
                "kpi_key":            "runway_months",
                "kpi_label":          "Runway (months, calc.)",
                "raw_value":          f"{runway:.1f}",
                "numeric_value":      round(runway, 1),
                "unit":               "months",
                "period_id":          period_id,
                "source_description": "cerebro_calculated",
                "is_valid":           True,
                "physics_violation":  is_violation,
                "cerebro_alert":      msg if is_violation else None,
                "confidence":         0.90,
                "original_currency":  None,
                "fx_rate":            None,
                "normalized_value_usd": None,
            })
            cross_checks["runway_computed"] = True
            cross_checks["runway_months"]   = round(runway, 1)

    # ── KPIs requeridos ausentes ─────────────────────────────────────────────
    missing_required = [k for k in REQUIRED_VC_KPIS if k not in idx]

    all_rows         = enriched + derived
    has_violations   = any(r.get("physics_violation") for r in all_rows)

    return {
        "enriched_rows":         enriched,
        "derived_rows":          derived,
        "violations":            violations,
        "missing_required":      missing_required,
        "has_physics_violations": has_violations,
        "cross_checks":          cross_checks,
        "approval_blocked":      has_violations,
    }


# ── Adaptador para UnifiedKPIContract ────────────────────────────────────────

# Unidad canónica de cada metric_id — usada para enriquecer el resultado del Cerebro
# con la etiqueta de unidad correcta sin acceder a los archivos de assets en runtime.
_UNIT_MAP: dict[str, str] = {
    "revenue": "$", "gross_profit": "$", "ebitda": "$", "cash": "$",
    "burn": "$", "annual_cash_flow": "$", "net_income": "$", "cogs": "$",
    "working_capital_debt": "$", "portfolio_size": "$", "gmv": "$",
    "cac": "$", "mrr": "$", "arr": "$", "ltv": "$", "net_debt": "$",
    "gross_profit_margin": "%", "ebitda_margin": "%", "churn_rate": "%",
    "revenue_growth": "%", "npl_ratio": "%", "loss_ratio": "%", "take_rate": "%",
    "employees": "count", "active_customers": "count", "nps": "count",
    "runway_months": "months",
}

# Etiqueta de display para el panel de revisión
_LABEL_MAP: dict[str, str] = {
    "revenue": "Revenue", "gross_profit": "Gross Profit", "ebitda": "EBITDA",
    "cash": "Cash in Bank", "burn": "Burn Rate", "annual_cash_flow": "Annual Cash Flow",
    "gross_profit_margin": "Gross Profit Margin", "ebitda_margin": "EBITDA Margin",
    "mrr": "MRR", "arr": "ARR", "churn_rate": "Churn Rate", "cac": "CAC",
    "ltv": "LTV", "employees": "Employees", "gmv": "GMV", "npl_ratio": "NPL Ratio",
    "loss_ratio": "Loss Ratio", "portfolio_size": "Portfolio Size",
    "revenue_growth": "Revenue Growth", "cogs": "COGS", "net_income": "Net Income",
    "working_capital_debt": "Working Capital Debt", "net_debt": "Net Debt",
    "runway_months": "Runway (months)", "take_rate": "Take Rate",
    "nps": "NPS", "active_customers": "Active Customers",
}


def run_cerebro_unified(contract: "UnifiedKPIContract") -> dict:
    """
    Aplica las reglas del Cerebro a un UnifiedKPIContract.

    Adapta el contrato al formato list[dict] que run_cerebro() espera y
    devuelve el mismo shape de resultado que run_cerebro(), enriquecido con
    las etiquetas de display del _LABEL_MAP.

    Parameters
    ----------
    contract : UnifiedKPIContract
        Objeto validado producido por extract_excel_to_contract() o
        extract_pdf_to_contract().

    Returns
    -------
    dict — mismo shape que run_cerebro():
        {
            "enriched_rows"        : list[dict],
            "derived_rows"         : list[dict],
            "violations"           : list[str],
            "missing_required"     : list[str],
            "has_physics_violations": bool,
            "cross_checks"         : dict,
            "approval_blocked"     : bool,
        }

    La clave "kpi_key" en cada fila es el metric_id canónico del contrato,
    lo que garantiza que el frontend puede renderizar la tabla correctamente.
    """
    period_id = contract.metrics[0].period_id if contract.metrics else ""

    # Convertir UnifiedKPIMetric → dict compatible con run_cerebro()
    kpi_rows: list[dict] = []
    for m in contract.metrics:
        # El Cerebro legacy usa kpi_key para cash_in_bank_end_of_year.
        # Mapeamos "cash" → alias que usa el Cerebro legacy.
        cerebro_key = "cash_in_bank_end_of_year" if m.metric_id == "cash" else m.metric_id

        kpi_rows.append({
            "kpi_key":              cerebro_key,
            "kpi_label":            _LABEL_MAP.get(m.metric_id, m.metric_id),
            "numeric_value":        m.value,
            "unit":                 _UNIT_MAP.get(m.metric_id),
            "is_valid":             True,
            "period_id":            period_id,
            "submission_id":        "",
            "raw_value":            str(m.value),
            "source_description":   m.source,
            "confidence":           None,   # Gemini no retorna confidence en UnifiedKPIContract
            "original_currency":    "USD",
            "fx_rate":              1.0,
            "normalized_value_usd": m.value,
        })

    cerebro = run_cerebro(kpi_rows)

    # Post-procesar enriched_rows: restaurar metric_id original (cash en lugar de
    # cash_in_bank_end_of_year) para que el frontend use los IDs del catálogo de 109 KPIs.
    for row in cerebro["enriched_rows"]:
        if row.get("kpi_key") == "cash_in_bank_end_of_year":
            row["kpi_key"] = "cash"
            row["kpi_label"] = _LABEL_MAP.get("cash", "Cash in Bank")

    return cerebro


# ── Motor nativo para UnifiedKPIContract ─────────────────────────────────────

def validate_financial_physics(contract: "UnifiedKPIContract") -> dict:
    """
    Aplica reglas de física financiera VC directamente sobre UnifiedKPIContract.

    A diferencia de run_cerebro_unified(), opera sobre los metric_ids canónicos
    del catálogo de 109 KPIs sin alias legacy (ej. "cash", no
    "cash_in_bank_end_of_year"). Esta es la función principal del flujo unificado.

    Reglas implementadas
    --------------------
    VIO-C01 — Burn Rate mensual > Cash Balance  → Runway < 1 mes (crítico)
    VIO-C02 — Cash Balance < 0                  → saldo imposible
    VIO-C03 — EBITDA > Revenue                  → algebraicamente imposible
    VIO-C04 — Gross Profit Margin ∉ [-100, 100] → valor fuera de rango

    Cross-checks derivados
    ----------------------
    net_burn_monthly  — abs(annual_cash_flow) / 12  (si burn directo ausente)
    runway_months     — cash / net_burn_monthly
    VIO-C05 — Runway <= 0 con caja y burn presentes

    Parameters
    ----------
    contract : UnifiedKPIContract
        Contrato validado producido por extract_excel_to_contract() o
        extract_pdf_to_contract().

    Returns
    -------
    dict — mismo shape que run_cerebro():
        {
            "enriched_rows"        : list[dict],
            "derived_rows"         : list[dict],
            "violations"           : list[str],
            "missing_required"     : list[str],
            "has_physics_violations": bool,
            "cross_checks"         : dict,
            "approval_blocked"     : bool,
        }
    """
    period_id = contract.metrics[0].period_id if contract.metrics else ""

    # Índice metric_id → value para lookups O(1)
    idx: dict[str, float] = {m.metric_id: m.value for m in contract.metrics}

    violations: list[str] = []
    enriched:   list[dict] = []

    for m in contract.metrics:
        row: dict = {
            "kpi_key":              m.metric_id,
            "kpi_label":            _LABEL_MAP.get(m.metric_id, m.metric_id),
            "numeric_value":        m.value,
            "unit":                 _UNIT_MAP.get(m.metric_id),
            "is_valid":             True,
            "period_id":            period_id,
            "submission_id":        "",
            "raw_value":            str(m.value),
            "source_description":   m.source,
            "confidence":           None,
            "original_currency":    "USD",
            "fx_rate":              1.0,
            "normalized_value_usd": m.value,
            "physics_violation":    False,
            "cerebro_alert":        None,
        }

        # ── VIO-C01: Burn Rate > Cash Balance → Runway < 1 mes ───────────────
        if m.metric_id == "burn" and m.value > 0:
            cash = idx.get("cash")
            if cash is not None and cash >= 0 and m.value > cash:
                msg = (
                    f"VIO-C01 — Burn Rate mensual ({_fmt(m.value, '$')}) supera el "
                    f"Cash Balance ({_fmt(cash, '$')}). "
                    "Runway < 1 mes: situación crítica."
                )
                row["physics_violation"] = True
                row["cerebro_alert"]     = msg
                violations.append(msg)

        # ── VIO-C02: Cash Balance < 0 ─────────────────────────────────────────
        elif m.metric_id == "cash" and m.value < 0:
            msg = (
                f"VIO-C02 — Cash Balance ({_fmt(m.value, '$')}) es negativo. "
                "Un saldo de caja no puede ser menor a cero; verifica el reporte."
            )
            row["physics_violation"] = True
            row["cerebro_alert"]     = msg
            violations.append(msg)

        # ── VIO-C03: EBITDA > Revenue ─────────────────────────────────────────
        elif m.metric_id == "ebitda":
            revenue = idx.get("revenue")
            if revenue is not None and m.value > revenue:
                msg = (
                    f"VIO-C03 — EBITDA ({_fmt(m.value)}) supera Revenue "
                    f"({_fmt(revenue)}). Algebraicamente imposible; "
                    "revisa las cifras del reporte."
                )
                row["physics_violation"] = True
                row["cerebro_alert"]     = msg
                violations.append(msg)

        # ── VIO-C04: Gross Profit Margin fuera de rango [-100%, 100%] ─────────
        elif (
            m.metric_id == "gross_profit_margin"
            and (m.value > 100.0 or m.value < -100.0)
        ):
            msg = (
                f"VIO-C04 — Gross Profit Margin ({_fmt(m.value, '%')}) fuera del "
                "rango [-100%, 100%]. Verifica si el valor está en decimales o "
                "en porcentaje."
            )
            row["physics_violation"] = True
            row["cerebro_alert"]     = msg
            violations.append(msg)

        enriched.append(row)

    # ── Cross-checks derivados ─────────────────────────────────────────────────
    derived: list[dict] = []
    cross_checks: dict  = {
        "net_burn_computed": False,
        "net_burn_monthly":  None,
        "runway_computed":   False,
        "runway_months":     None,
    }

    cash      = idx.get("cash")
    burn      = idx.get("burn")             # burn mensual directo
    cash_flow = idx.get("annual_cash_flow") # fallback si burn ausente

    # Prioridad: "burn" directo > derivado de annual_cash_flow
    net_burn_monthly: Optional[float] = None
    if burn is not None and burn > 0:
        net_burn_monthly = burn
    elif cash_flow is not None and cash_flow < 0:
        net_burn_monthly = abs(cash_flow) / 12.0
        derived.append({
            "kpi_key":              "net_burn",
            "kpi_label":            "Net Burn (Monthly, calc.)",
            "raw_value":            _fmt(net_burn_monthly, "$"),
            "numeric_value":        round(net_burn_monthly, 2),
            "unit":                 "$",
            "period_id":            period_id,
            "submission_id":        "",
            "source_description":   "cerebro_calculated",
            "is_valid":             True,
            "physics_violation":    False,
            "cerebro_alert":        None,
            "confidence":           0.90,
            "original_currency":    "USD",
            "fx_rate":              1.0,
            "normalized_value_usd": round(net_burn_monthly, 2),
        })
        cross_checks["net_burn_computed"] = True
        cross_checks["net_burn_monthly"]  = round(net_burn_monthly, 2)

    # Runway = Cash / Net Burn mensual
    if (
        cash is not None
        and net_burn_monthly is not None
        and net_burn_monthly > 0
        and "runway_months" not in idx
    ):
        runway       = cash / net_burn_monthly
        is_violation = runway <= 0
        vio_msg: Optional[str] = None
        if is_violation:
            vio_msg = (
                f"VIO-C05 — Runway ({runway:.1f} meses) es <= 0 con "
                f"Cash={_fmt(cash, '$')} y Net Burn={_fmt(net_burn_monthly, '$')}/mes. "
                "Urgente revisión."
            )
            violations.append(vio_msg)

        derived.append({
            "kpi_key":              "runway_months",
            "kpi_label":            "Runway (months, calc.)",
            "raw_value":            f"{runway:.1f}",
            "numeric_value":        round(runway, 1),
            "unit":                 "months",
            "period_id":            period_id,
            "submission_id":        "",
            "source_description":   "cerebro_calculated",
            "is_valid":             True,
            "physics_violation":    is_violation,
            "cerebro_alert":        vio_msg,
            "confidence":           0.90,
            "original_currency":    None,
            "fx_rate":              None,
            "normalized_value_usd": None,
        })
        cross_checks["runway_computed"] = True
        cross_checks["runway_months"]   = round(runway, 1)

    # ── KPIs requeridos ausentes ───────────────────────────────────────────────
    missing_required = [k for k in _REQUIRED_UNIFIED if k not in idx]

    all_rows       = enriched + derived
    has_violations = any(r.get("physics_violation") for r in all_rows)

    return {
        "enriched_rows":          enriched,
        "derived_rows":           derived,
        "violations":             violations,
        "missing_required":       missing_required,
        "has_physics_violations": has_violations,
        "cross_checks":           cross_checks,
        "approval_blocked":       has_violations,
    }
