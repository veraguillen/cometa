-- ============================================================================
-- v_kpi_unified — Vista de comparación histórico + nuevo pipeline
-- Proyecto : cometa-mvp
-- Dataset  : BD_Cometa
--
-- Une las tres fuentes de datos sin modificar ninguna tabla original:
--
--   FUENTE 1 │ fact_portfolio_kpis   │ Excel/CSV certificado por Analista
--   FUENTE 2 │ fact_kpi_values       │ PDF/Gemini (legacy — pendiente migrar)
--   FUENTE 3 │ stg_legacy_fact_kpis  │ Excel maestro histórico del fondo
--
-- Diccionario de equivalencias (metric_id legacy → kpi_key nuevo catálogo):
--   'revenue'                  → 'KPI-001'   Total Revenue
--   'revenue_growth'           → 'KPI-006'   Revenue Growth
--   'gross_profit_margin'      → 'KPI-010'   Gross Profit Margin
--   'ebitda_margin'            → 'KPI-011'   EBITDA Margin
--   'ebitda'                   → 'KPI-012'   EBITDA
--   'annual_cash_flow'         → 'KPI-022'   Annual Cash Flow
--   'cash_in_bank_end_of_year' → 'KPI-021'   Cash in Bank (EoY)
--   'working_capital_debt'     → 'KPI-045'   Working Capital Debt
--   'mrr'                      → 'KPI-002'   Monthly Recurring Revenue
--   'churn_rate'               → 'KPI-015'   Churn Rate
--   'cac'                      → 'KPI-018'   Customer Acquisition Cost
--   'npl_ratio'                → 'KPI-056'   Non-Performing Loan Ratio
--   'gmv'                      → 'KPI-003'   Gross Merchandise Value
--   'loss_ratio'               → 'KPI-068'   Loss Ratio
--   'portfolio_size'           → 'KPI-050'   Loan Portfolio Size
--
-- Columna pipeline_stage:
--   'analyst_certified'  → dato aprobado por analista (fuente de verdad)
--   'raw_gemini'         → PDF extraído por IA sin revisión humana
--   'analyst_override'   → PDF editado manualmente por analista
--   'historical_excel'   → dato del Excel maestro del fondo
--
-- USO RECOMENDADO:
--   1. Looker Studio: conectar a esta vista en lugar de a tablas individuales.
--   2. Comparación: filtrar por company_id + period_month y pivotear pipeline_stage.
-- ============================================================================

CREATE OR REPLACE VIEW `cometa-mvp.BD_Cometa.v_kpi_unified` AS

-- ── FUENTE 1: Datos certificados por Analista (Excel/CSV pipeline) ────────────
SELECT
  fpk.company_id,
  fpk.date                                              AS period_date,
  FORMAT_DATE('%Y-%m', fpk.date)                        AS period_month,
  fpk.kpi_key,
  fpk.value,
  fpk.unit_type,
  fpk.vertical                                          AS sector,
  CAST(fpk.confidence_score AS FLOAT64) / 100.0        AS confidence,
  fpk.is_derived,
  fpk.loaded_at,
  'analyst_certified'                                   AS pipeline_stage,
  'excel_csv'                                           AS source_type,
  fpk.analyst_note,
  NULL                                                  AS legacy_metric_id,
  NULL                                                  AS legacy_period_id

FROM `cometa-mvp.BD_Cometa.fact_portfolio_kpis` fpk

UNION ALL

-- ── FUENTE 2: Datos PDF/Gemini (legacy — pendientes de migrar a certified) ────
-- Nota: tras implementar FIX-03 + FIX-04, los PDFs nuevos llegaran a
-- fact_portfolio_kpis con pipeline_stage='analyst_certified'. Esta rama
-- cubre los PDFs anteriores al refactor.
SELECT
  fkv.company_id,
  DATE(
    CAST(SUBSTR(fkv.period_id, 2, 4)  AS INT64),
    CAST(SUBSTR(fkv.period_id, 10, 2) AS INT64),
    1
  )                                                     AS period_date,
  CONCAT(
    SUBSTR(fkv.period_id, 2, 4), '-',
    SUBSTR(fkv.period_id, 10, 2)
  )                                                     AS period_month,
  CASE fkv.metric_id
    WHEN 'revenue'                  THEN 'KPI-001'
    WHEN 'revenue_growth'           THEN 'KPI-006'
    WHEN 'gross_profit_margin'      THEN 'KPI-010'
    WHEN 'ebitda_margin'            THEN 'KPI-011'
    WHEN 'ebitda'                   THEN 'KPI-012'
    WHEN 'annual_cash_flow'         THEN 'KPI-022'
    WHEN 'cash_in_bank_end_of_year' THEN 'KPI-021'
    WHEN 'working_capital_debt'     THEN 'KPI-045'
    WHEN 'mrr'                      THEN 'KPI-002'
    WHEN 'churn_rate'               THEN 'KPI-015'
    WHEN 'cac'                      THEN 'KPI-018'
    WHEN 'npl_ratio'                THEN 'KPI-056'
    WHEN 'gmv'                      THEN 'KPI-003'
    WHEN 'loss_ratio'               THEN 'KPI-068'
    WHEN 'portfolio_size'           THEN 'KPI-050'
    ELSE CONCAT('LEGACY_', fkv.metric_id)
  END                                                   AS kpi_key,
  fkv.numeric_value                                     AS value,
  fkv.unit                                              AS unit_type,
  fkv.bucket_id                                         AS sector,
  fkv.confidence                                        AS confidence,
  FALSE                                                 AS is_derived,
  fkv.created_at                                        AS loaded_at,
  CASE
    WHEN fkv.is_manually_edited = TRUE THEN 'analyst_override'
    ELSE 'raw_gemini'
  END                                                   AS pipeline_stage,
  'pdf_gemini'                                          AS source_type,
  fkv.notes                                             AS analyst_note,
  fkv.metric_id                                         AS legacy_metric_id,
  fkv.period_id                                         AS legacy_period_id

FROM `cometa-mvp.BD_Cometa.fact_kpi_values` fkv
WHERE fkv.value_status IN ('verified', 'reported')

UNION ALL

-- ── FUENTE 3: Datos históricos del Excel Maestro (stg_legacy) ────────────────
SELECT
  slk.company_id,
  DATE(
    CAST(SUBSTR(slk.period_id, 2, 4)  AS INT64),
    CAST(SUBSTR(slk.period_id, 10, 2) AS INT64),
    1
  )                                                     AS period_date,
  CONCAT(
    SUBSTR(slk.period_id, 2, 4), '-',
    SUBSTR(slk.period_id, 10, 2)
  )                                                     AS period_month,
  CASE slk.metric_id
    WHEN 'revenue'                  THEN 'KPI-001'
    WHEN 'revenue_growth'           THEN 'KPI-006'
    WHEN 'gross_profit_margin'      THEN 'KPI-010'
    WHEN 'ebitda_margin'            THEN 'KPI-011'
    WHEN 'ebitda'                   THEN 'KPI-012'
    WHEN 'annual_cash_flow'         THEN 'KPI-022'
    WHEN 'cash_in_bank_end_of_year' THEN 'KPI-021'
    WHEN 'working_capital_debt'     THEN 'KPI-045'
    WHEN 'mrr'                      THEN 'KPI-002'
    WHEN 'churn_rate'               THEN 'KPI-015'
    WHEN 'cac'                      THEN 'KPI-018'
    WHEN 'npl_ratio'                THEN 'KPI-056'
    WHEN 'gmv'                      THEN 'KPI-003'
    WHEN 'loss_ratio'               THEN 'KPI-068'
    WHEN 'portfolio_size'           THEN 'KPI-050'
    ELSE CONCAT('LEGACY_', slk.metric_id)
  END                                                   AS kpi_key,
  COALESCE(slk.normalized_value_usd, slk.numeric_value) AS value,
  slk.unit_original                                     AS unit_type,
  slk.bucket_id                                         AS sector,
  0.60                                                  AS confidence,
  FALSE                                                 AS is_derived,
  slk.created_at                                        AS loaded_at,
  'historical_excel'                                    AS pipeline_stage,
  'legacy_master_db'                                    AS source_type,
  slk.source_description                                AS analyst_note,
  slk.metric_id                                         AS legacy_metric_id,
  slk.period_id                                         AS legacy_period_id

FROM `cometa-mvp.BD_Cometa.stg_legacy_fact_kpis` slk
WHERE slk.value_status = 'valid'
;


-- ============================================================================
-- CONSULTA: Comparación lado a lado — las tres fuentes para una empresa
-- Filtrar por company_id y pivotear por pipeline_stage
-- ============================================================================
-- SELECT
--   company_id,
--   period_month,
--   kpi_key,
--   MAX(CASE WHEN pipeline_stage = 'historical_excel'  THEN value END)  AS valor_historico,
--   MAX(CASE WHEN pipeline_stage = 'raw_gemini'        THEN value END)  AS valor_pdf_ia,
--   MAX(CASE WHEN pipeline_stage = 'analyst_certified' THEN value END)  AS valor_certificado,
--   MAX(CASE WHEN pipeline_stage = 'analyst_certified' THEN confidence END) AS confianza_final
-- FROM `cometa-mvp.BD_Cometa.v_kpi_unified`
-- WHERE company_id = 'simetrik'
-- GROUP BY 1, 2, 3
-- ORDER BY period_month DESC, kpi_key;


-- ============================================================================
-- LOOKER STUDIO — Configuracion recomendada
-- ============================================================================
-- Fuente de datos: BigQuery → cometa-mvp.BD_Cometa.v_kpi_unified
--
-- Dimensiones clave:
--   company_id    → Empresa (filtro principal)
--   period_month  → Período (eje X de series de tiempo)
--   kpi_key       → KPI (filtro de metrica)
--   pipeline_stage → Color/leyenda para distinguir fuentes
--
-- Metricas clave:
--   value         → Valor del KPI
--   confidence    → Nivel de confianza (0.0 - 1.0)
--
-- Filtro recomendado en todos los charts:
--   pipeline_stage IN ('analyst_certified', 'analyst_override')
--   para mostrar solo datos certificados por default, con opcion de
--   activar 'historical_excel' y 'raw_gemini' para comparacion.
-- ============================================================================
