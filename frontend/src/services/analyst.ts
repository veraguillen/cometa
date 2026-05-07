/**
 * services/analyst.ts — API calls for ANALISTA role.
 * All responses validated with Zod (R-F1). New calls use apiGet/apiPost.
 */

import { apiGet, apiPost, apiClient } from "@/services/api-client";
import {
  resultsResponseSchema,
  companiesResponseSchema,
  portfolioCompaniesResponseSchema,
  coverageResponseSchema,
  cerebroResultSchema,
  finalizeAnalysisResponseSchema,
  confirmGoldResponseSchema,
  analystStagingQueueSchema,
  validateStagingResponseSchema,
  stagingRawUrlSchema,
  type AnalysisResult,
  type Company,
  type PortfolioEntry,
  type CoverageResponse,
  type KpiReviewRow,
  type CerebroResult,
  type FinalizeAnalysisResponse,
  type ConfirmGoldResponse,
  type AnalystStagingQueue,
  type ValidateStagingResponse,
  type StagingRawUrl,
} from "@/lib/schemas";

// ── Analysis results for a specific company ────────────────────────────────────
export async function getAnalysisResults(companyId: string): Promise<AnalysisResult[]> {
  const ts  = Date.now();
  const url = `/api/results?company_id=${encodeURIComponent(companyId)}&t=${ts}`;
  // Debug: log raw response before Zod parse to catch schema mismatches
  try {
    const { data: rawData } = await apiClient.get<unknown>(url);
    console.log("DATOS DESDE API (raw):", rawData);
    const res = resultsResponseSchema.parse(rawData);
    console.log("DATOS DESDE API (parsed):", res.results.length, "resultados");
    return res.results;
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      console.error("ZodError al parsear /api/results:", err.message);
    }
    throw err;
  }
}

// ── All portfolio companies visible to this analyst ───────────────────────────
/**
 * GET /api/portfolio-companies — real endpoint, returns portfolios with companies.
 * No auth required. Falls back to empty array on error.
 */
export async function getPortfolioCompanies(): Promise<PortfolioEntry[]> {
  try {
    const res = await apiGet("/api/portfolio-companies", portfolioCompaniesResponseSchema);
    return res.portfolios;
  } catch {
    return [];
  }
}

// ── Legacy company list (unused, kept for compatibility) ───────────────────────
export async function getLegacyCompanies(): Promise<Company[]> {
  try {
    const res = await apiGet("/api/companies", companiesResponseSchema);
    return res.companies;
  } catch {
    return [];
  }
}

// ── KPI source detection (IA vs Manual corrections) ──────────────────────────
/**
 * Returns a map of camelCase KPI key → "manual" for any KPIs that were
 * entered manually via MissingDataPanel (stored in data.manual_corrections).
 * All other keys default to "ia" at the call site.
 */
const SNAKE_TO_CAMEL: Record<string, string> = {
  revenue_growth:       "revenueGrowth",
  gross_margin:         "grossMargin",
  gross_profit_margin:  "grossMargin",
  ebitda_margin:        "ebitdaMargin",
  cash_in_bank:         "cashInBank",
  annual_cash_flow:     "annualCashFlow",
  working_capital_debt: "workingCapitalDebt",
  net_working_capital:  "netWorkingCapital",
  total_revenue:        "totalRevenue",
  net_income:           "netIncome",
  mrr:                  "totalRevenue",
  arr:                  "revenueGrowth",
  churn_rate:           "revenueGrowth",
  ebitda:               "ebitdaMargin",
};

export function extractKPISources(
  results: AnalysisResult[],
): Record<string, "ia" | "manual"> {
  if (results.length === 0) return {};
  const latest  = results[results.length - 1];
  const manual  = (latest.data as Record<string, unknown>)?.manual_corrections as
    Record<string, unknown> | undefined;
  if (!manual) return {};
  const sources: Record<string, "ia" | "manual"> = {};
  for (const rawKey of Object.keys(manual)) {
    const camel = SNAKE_TO_CAMEL[rawKey];
    if (camel) sources[camel] = "manual";
  }
  return sources;
}

// ── Cerebro — pre-validacion de KPIs antes de la Vista de Analista ────────────

/**
 * POST /api/analyst/cerebro
 * Enriquece kpi_rows con reglas de fisica financiera y cross-checks derivados.
 * Retorna filas con physics_violation, cerebro_alert, Net Burn y Runway calculados.
 */
export async function runCerebro(kpiRows: Record<string, unknown>[]): Promise<CerebroResult> {
  return apiPost("/api/analyst/cerebro", { kpi_rows: kpiRows }, cerebroResultSchema);
}

// ── Finalize Analysis — certificar y escribir en Gold + BQ ───────────────────

/**
 * POST /api/analyst/finalize-analysis
 * Cierra el ciclo de validacion:
 *   1. Sube JSON final a gs://cometa-vc-gold-prod/...
 *   2. Copia el PDF de raw/ a gold/certified/
 *   3. UPSERT en fact_portfolio_history via MERGE
 */
export async function finalizeAnalysis(params: {
  loadId:        string;
  slug:          string;
  periodo:       string;
  sourceFileUri: string;
  analystId:     string;
  currency:      string;
  kpiRows:       KpiReviewRow[];
  forceApprove?: boolean;
}): Promise<FinalizeAnalysisResponse> {
  return apiPost(
    "/api/analyst/finalize-analysis",
    {
      load_id:         params.loadId,
      slug:            params.slug,
      periodo:         params.periodo,
      source_file_uri: params.sourceFileUri,
      analyst_id:      params.analystId,
      currency:        params.currency,
      kpi_rows:        params.kpiRows,
      force_approve:   params.forceApprove ?? false,
    },
    finalizeAnalysisResponseSchema,
  );
}

// ── Confirm Gold — analista certifica Excel/CSV pendiente → BQ MERGE ─────────

/**
 * POST /api/analyst/confirm-gold
 * Unico disparador del MERGE a fact_portfolio_kpis para el pipeline Excel/CSV.
 * Solo accesible con rol ANALISTA (@cometa.vc).
 */
export async function confirmGold(params: {
  load_id:      string;
  filename:     string;
  company_slug: string;
  company_name: string;
  period_str:   string;
  sector:       string;
}): Promise<ConfirmGoldResponse> {
  return apiPost("/api/analyst/confirm-gold", params, confirmGoldResponseSchema);
}

// ── Coverage heatmap ──────────────────────────────────────────────────────────
/**
 * GET /api/analyst/coverage — Portfolio KPI coverage matrix.
 * Returns the full company × period grid used by PortfolioHeatmap.
 *
 * Cache-busting: ?t=<timestamp> prevents the browser from serving a
 * previously cached 410/4xx response for this URL.
 *
 * Throws on network or schema error (caller decides how to handle).
 */
export async function fetchCoverage(portfolioId?: string | null): Promise<CoverageResponse> {
  const params = new URLSearchParams();
  if (portfolioId) params.set("portfolio_id", portfolioId);
  params.set("t", String(Date.now())); // cache-bust
  const url = `/api/analyst/coverage?${params.toString()}`;
  try {
    return await apiGet(url, coverageResponseSchema);
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number; data?: unknown } };
    const status   = axiosErr?.response?.status;
    const body     = axiosErr?.response?.data;
    console.error(
      `[Coverage] Error en ${url} — HTTP ${status ?? "network"} —`,
      body ?? err,
    );
    throw err;
  }
}

// ── Convenience: extract the latest KPIs from a result set ───────────────────
export function extractKPIs(results: AnalysisResult[]): Record<string, string> {
  if (results.length === 0) return {};
  // Use the most recent result in the supplied set (caller controls which set)
  const latest = results[results.length - 1];
  const fm = (latest.data as Record<string, unknown>)?.financial_metrics_2025 as
    Record<string, unknown> | undefined;
  if (!fm) return {};

  /**
   * Navigate `path` inside `fm` and return the terminal value as a string.
   *
   * Handles three storage formats produced by the pipeline:
   *   • BQ flat:          fm.section.subkey = { value: "45.2", unit: "%" }
   *                       → path ends at the string  →  return it directly
   *   • Standard wrapper: fm.section.subkey = { value: "45.2", unit: "%" }
   *                       → path ends at the object  →  return obj.value
   *   • Gemini nested:    fm.section.subkey.value = { value: "45.2%" }
   *                       → path ends at inner obj   →  return inner.value
   */
  function val(path: string[]): string {
    let node: unknown = fm;
    for (const key of path) {
      if (node === null || node === undefined || typeof node !== "object") return "—";
      node = (node as Record<string, unknown>)[key];
    }
    if (node === null || node === undefined) return "—";
    // Terminal is already a primitive (BQ format: path included "value" key)
    if (typeof node === "string") return node || "—";
    if (typeof node === "number") return String(node);
    // Terminal is an object { value: "..." [, unit] }
    const obj = node as Record<string, unknown>;
    const v = obj.value;
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v || "—";
    if (typeof v === "number") return String(v);
    // Double-nested Gemini: { value: { value: "..." } }
    const inner = (v as Record<string, unknown>)?.value;
    return inner != null ? String(inner) : "—";
  }

  return {
    revenueGrowth:      val(["revenue_growth", "value"]),
    grossMargin:        val(["profit_margins", "gross_profit_margin", "value"]),
    ebitdaMargin:       val(["profit_margins", "ebitda_margin", "value"]),
    cashInBank:         val(["cash_flow_indicators", "cash_in_bank_end_of_year", "value"]),
    annualCashFlow:     val(["cash_flow_indicators", "annual_cash_flow", "value"]),
    workingCapitalDebt: val(["debt_ratios", "working_capital_debt", "value"]),
    netWorkingCapital:  val(["debt_ratios", "net_working_capital", "value"]),
    totalRevenue:       val(["revenue", "total_revenue", "value"]),
    netIncome:          val(["income", "net_income", "value"]),
  };
}

// ── Mesa de Control — Analyst Staging Queue ────────────────────────────────────

/** GET /api/analyst/staging/pending — lista de batches pendientes de revisión. */
export async function getStagingQueue(
  companyId?: string,
): Promise<AnalystStagingQueue> {
  const url = companyId
    ? `/api/analyst/staging/pending?company_id=${encodeURIComponent(companyId)}`
    : "/api/analyst/staging/pending";
  return apiGet(url, analystStagingQueueSchema);
}

/** POST /api/analyst/staging/validate — aprobar o rechazar un batch. */
export async function validateStaging(params: {
  staging_id:     string;
  action:         "VALIDATED" | "REJECTED";
  rejection_note?: string;
}): Promise<ValidateStagingResponse> {
  return apiPost("/api/analyst/staging/validate", params, validateStagingResponseSchema);
}

/**
 * GET /api/analyst/staging/raw-url — URL firmada para abrir el archivo fuente.
 *
 * Acepta DOS formas de identificar el archivo:
 *   • stagingId — busca source_file en fact_kpi_staging (flujo Mesa de Control)
 *   • gcsUri    — firma directamente la URI de GCS (flujo RawDataBrowser)
 *
 * Exactamente uno de los dos debe estar presente.
 */
export async function getStagingRawUrl(
  params: { stagingId: string; gcsUri?: never } | { stagingId?: never; gcsUri: string },
): Promise<StagingRawUrl> {
  const qs = params.stagingId
    ? `staging_id=${encodeURIComponent(params.stagingId)}`
    : `gcs_uri=${encodeURIComponent(params.gcsUri!)}`;
  return apiGet(`/api/analyst/staging/raw-url?${qs}`, stagingRawUrlSchema);
}
