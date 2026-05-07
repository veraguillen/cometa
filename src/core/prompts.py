"""
prompts.py
──────────
Master System Prompt para Gemini — motor de extracción y mapeo de KPIs.

Fuente única de verdad para todos los prompts de IA en el pipeline.
Importado por kpi_mapper.py (flujo Excel) y data_contract.py (flujo PDF).

Uso:
    from src.core.prompts import build_extraction_prompt
    prompt = build_extraction_prompt(catalog=catalog_str, period_id="P2026Q1M01", source="EXCEL")
"""

from __future__ import annotations

# ── Mapa semántico — visible para Gemini en el prompt ──────────────────────────
# REGLA DE MANTENIMIENTO — solo incluir metric_ids que cumplan AMBAS condiciones:
#   1. Existen en loading_brain_v1.json  (son el ID canónico del sistema)
#   2. given_or_silver == "GIVEN"        (los SILVER se calculan en BQ, no se extraen)
#
# Cada vez que se agregue un KPI al master, añadir su entrada aquí con sus
# sinónimos en español, inglés y abreviaturas habituales en reportes de VC.
#
# Organización interna:
#   [PL]   Estado de Resultados
#   [BS]   Balance General
#   [CF]   Flujo de Caja
#   [UE]   Unit Economics / Métricas de Clientes y SaaS
#   [RISK] Riesgo de Cartera (Lending / Insurtech)
#   [HC]   Headcount
#   [SECT] Sector específico (Marketplace, Insurtech, Lending)

_SEMANTIC_MAP = """
## MAPA SEMÁNTICO OBLIGATORIO

Cuando encuentres cualquiera de estos términos (en cualquier idioma),
mapeálos al metric_id correspondiente.
IMPORTANTE: usa el metric_id EXACTO de esta tabla. No lo modifiques.

| Términos observados en el documento                                                     | metric_id               |
|-----------------------------------------------------------------------------------------|-------------------------|
| Ventas, Ingresos, Revenue, Sales, Facturación, Total de Ventas, Net Revenue             | revenue                 |
| Ganancia Bruta, Gross Profit, Utilidad Bruta, Margen Bruto (valor absoluto)             | gross_profit            |
| EBITDA, Earnings Before Interest Taxes Depreciation, Resultado Operativo Ajustado       | ebitda                  |
| EBT, Earnings Before Taxes, Utilidad Antes de Impuestos, Pre-Tax Income                 | ebt                     |
| Net Income, Utilidad Neta, Resultado Neto, Bottom Line, Ganancia Neta                   | net_income              |
| COGS, Costo de Ventas, Cost of Goods Sold, Costo de Servicio, Costo de Productos        | cogs                    |
| S&M, Sales & Marketing, Gasto en Ventas y Marketing, Marketing Expense, S&M Expense     | sm_expense              |
| Caja, Efectivo, Cash, Cash in Bank, Saldo de Caja, Tesorería, Disponible                | cash                    |
| Burn, Burn Rate, Quema de Caja, Burn Mensual, Cash Burn, Net Burn                       | burn                    |
| Flujo de Caja Operativo, Operating Cash Flow, FCO, Flujo Operativo                      | operating_cash_flow     |
| Deuda Total, Total Debt, Deuda Financiera, Pasivo Financiero, Net Debt, Deuda Neta      | total_debt              |
| Portafolio de Créditos, Total Loan Portfolio, Cartera Total, Loan Book, Cartera Activa  | total_loan_portfolio    |
| MRR, Ingreso Recurrente Mensual, Monthly Recurring Revenue                              | mrr                     |
| CAC, Costo de Adquisición de Cliente, Cost per Acquisition, Customer Acquisition Cost   | cac                     |
| Blended CAC, CAC Combinado, CAC Total (pagado + orgánico)                               | blended_cac             |
| CAC Payback, Meses de Recuperación del CAC, Payback Period, Time to Recover CAC         | cac_payback_months      |
| LTV/CAC, Ratio LTV sobre CAC, Unit Economics, Lifetime Value / CAC                      | ltv_cac_ratio           |
| NDR, Net Dollar Retention, Retención Neta de Ingresos, NRR, Net Revenue Retention       | ndr_12m                 |
| Clientes que Cancelaron, # Churn, Churn Count, Clientes Perdidos, Bajas de Clientes     | churn_customers         |
| Nuevos Clientes, New Customers, Clientes Adquiridos, New Accounts, New Users            | new_customers           |
| Clientes Activos, Active Clients, Active Customers, Usuarios Activos, MAU               | active_clients          |
| Clientes Facturados, Invoiced Clients, Cuentas Facturadas, Paying Customers             | invoiced_clients        |
| GMV, Gross Merchandise Value, Valor Bruto de Transacciones, Volumen de Ventas Brutas    | gmv                     |
| NPL, Non-Performing Loans, Cartera Vencida, Mora, Cartera en Default                   | default_rate_npl        |
| Default Rate, Tasa de Impago, Tasa de Default, Tasa de Morosidad General                | default_rate            |
| Loss Ratio, Ratio de Siniestralidad, Claims Ratio, Índice de Pérdidas (seguros)         | loss_ratio              |
| Loss Rate, Tasa de Pérdida, Write-off Rate, Tasa de Castigo de Cartera                  | loss_rate               |
| Empleados, Headcount, Plantilla, Personal, Staff, Team Size, FTEs, Colaboradores        | employees               |
| Costo de Nómina, Total Salary Cost, Masa Salarial, Payroll Cost, Costo de Personal      | total_salary_cost       |
| Empleadas Mujeres, Female Employees, Mujeres en el Equipo, Headcount Femenino           | female_employees        |
| Take Rate, Blended Take Rate, Comisión Plataforma, Platform Fee, Revenue Rate           | blended_take_rate       |
| Prima Bruta, Gross Written Premium, GWP, Primas Emitidas, Total Primas                  | gross_written_premium   |
"""

# ── Reglas de conversión numérica — siempre incluidas ──────────────────────────

_NUMERIC_RULES = """
## REGLAS DE CONVERSIÓN NUMÉRICA OBLIGATORIAS

1. Porcentajes: 36% → 36.0 (NUNCA 0.36). Siempre en puntos porcentuales.
2. Millones:   $4.2M → 4200000.0
3. Miles:      $320K → 320000.0
4. Miles de M: $1.2B → 1200000000.0
5. Negativos:  -$1.5M → -1500000.0
6. Con comas:  1,200,000 → 1200000.0
7. Múltiples períodos: toma SIEMPRE el valor del período más reciente.
"""

# ── Reglas de oro — siempre incluidas ──────────────────────────────────────────

_GOLDEN_RULES = """
## REGLAS DE ORO — NO NEGOCIABLES

1. EXACTITUD DE IDs: Usa EXACTAMENTE el metric_id del catálogo. No lo parafrasees.
   ✅ "revenue"   ❌ "total_revenue" / "revenues" / "ingresos"
   ✅ "mrr"       ❌ "monthly_mrr" / "mrr_amount" / "mrr_usd"

2. OMISIÓN EN CASO DE DUDA: Si no estás seguro de que un valor corresponde
   exactamente a un metric_id, OMÍTELO del resultado. Es preferible omitir
   que mapear incorrectamente y contaminar la base de datos.

3. SIN INVENTAR VALORES: Solo extrae valores que están explícitamente escritos
   en el documento. NUNCA calcules, estimes ni inferencies un valor ausente.

4. SIN DUPLICADOS: Si un metric_id ya fue mapeado, no lo repitas.
   Conserva el valor del período más reciente.

5. SOLO NUMÉRICOS: Solo incluye métricas cuyo valor sea un número.
   No incluyas valores como "N/A", "pending", "-", "n.d.", etc.
"""

# ── Formato de salida — fijo e invariable ──────────────────────────────────────

_OUTPUT_FORMAT = """
## FORMATO DE SALIDA OBLIGATORIO

Responde EXCLUSIVAMENTE con el siguiente JSON.
SIN texto antes ni después. SIN bloques markdown. SIN comillas de código.
SOLO el objeto JSON crudo, empezando con {{ y terminando con }}:

{{
  "metrics": [
    {{"metric_id": "<id_del_catalogo>", "value": <float>, "period_id": "{period_id}", "source": "{source}"}},
    ...
  ]
}}

Si no encuentras ningún valor numérico mapeable con certeza:
{{"metrics": []}}
"""

# ── Función pública ────────────────────────────────────────────────────────────


def build_extraction_prompt(
    catalog: str,
    period_id: str,
    source: str,
    raw_data_label: str = "el documento adjunto",
) -> str:
    """
    Construye el prompt completo para Gemini.

    Parameters
    ----------
    catalog         : Catálogo de KPIs serializado como texto (metric_id + display_name + aliases).
    period_id       : Período canónico que se inyectará en cada métrica (ej. "P2026Q1M01").
    source          : "PDF" o "EXCEL".
    raw_data_label  : Descripción del input (para personalizar el mensaje inicial).

    Returns
    -------
    str — prompt completo listo para enviarse a Gemini.
    """
    output_block = _OUTPUT_FORMAT.format(period_id=period_id, source=source)

    return (
        f"Eres un motor de extracción financiera de precisión VC.\n"
        f"Tu ÚNICA tarea es analizar {raw_data_label} e identificar métricas financieras,\n"
        "mapeándolas al catálogo canónico de KPIs con máxima exactitud.\n\n"
        + _GOLDEN_RULES
        + "\n"
        + _NUMERIC_RULES
        + "\n"
        + _SEMANTIC_MAP
        + "\n"
        + output_block
        + f"\n\n## CATÁLOGO CANÓNICO DE KPIs\n\n{catalog}"
    )
