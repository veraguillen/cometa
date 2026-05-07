"use client";

/**
 * /analyst/dashboard — Analyst Workstation v5.
 *
 * Layout "Full-Width":
 *   ┌─ AppHeader (logo + tab nav + tools) ─────────────────────────────────────┐
 *   │  [Portfolio] [Analytics] [Ingestión]                                     │
 *   ├───────────────────────────────────────────────────────────────────────────┤
 *   │  Content — full width, no sidebar, no right panel                        │
 *   └───────────────────────────────────────────────────────────────────────────┘
 *   [Cometa AI FAB — bottom-right floating]
 */

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { useRouter, useSearchParams }            from "next/navigation";
import { motion, AnimatePresence }               from "framer-motion";
import { validateSession, type UserInfo }        from "@/services/api-client";
import AppHeader        from "@/components/analyst/AppHeader";
import AITerminal       from "@/components/analyst/AITerminal";
import LookerEmbed      from "@/components/analyst/LookerEmbed";
import RawDataBrowser, { type StageReviewData } from "@/components/analyst/RawDataBrowser";
import KpiReviewPanel   from "@/components/analyst/KpiReviewPanel";
import InviteFounder    from "@/components/analyst/InviteFounder";
import PortfolioHeatmap from "@/components/analyst/PortfolioHeatmap";
import { DashboardProvider, useDashboardStore, type UiAction } from "@/store/dashboardStore";
import { useAnalystData }       from "@/hooks/useAnalystData";
import { usePeriodFilter }      from "@/hooks/usePeriodFilter";
import { usePortfolioMetadata } from "@/hooks/usePortfolioMetadata";
import { buildExecutiveSummary } from "@/components/analyst/ExecutiveSummaryText";
import { extractKPIs, fetchCoverage } from "@/services/analyst";
import { formatVaultDate } from "@/lib/utils";
import { type CerebroResult, type FinalizeAnalysisResponse } from "@/lib/schemas";
import { AlertTriangle, CheckCircle2, RefreshCw, X } from "lucide-react";
import SettingsPage from "@/components/analyst/SettingsPage";

// ── Types ────────────────────────────────────────────────────────────────────

export type MainTab = "portfolio" | "analytics" | "ingestion" | "settings";

interface IngestReview {
  loadId:        string;
  slug:          string;
  periodo:       string;
  sourceFileUri: string;
  analystId:     string;
  currency:      string;
  cerebroResult: CerebroResult;
}

interface CoverageSummary {
  compliance: number | null;
  riskCount:  number | null;
  loaded:     boolean;
}

// ── Executive Summary Widget ──────────────────────────────────────────────────

function SummaryWidget({
  label,
  value,
  description,
  accent,
  loading,
}: {
  label:       string;
  value:       string;
  description: string;
  accent:      string;
  loading?:    boolean;
}) {
  return (
    <div
      className="rounded-xl px-5 py-4 flex flex-col gap-1.5"
      style={{
        background: "color-mix(in srgb, var(--cometa-fg) 3%, transparent)",
        border:     "1px solid var(--cometa-card-border)",
      }}
    >
      <span
        className="text-[10px] uppercase tracking-widest"
        style={{ color: "var(--cometa-fg-muted)" }}
      >
        {label}
      </span>
      {loading ? (
        <div
          className="h-8 w-20 rounded-md animate-pulse"
          style={{ background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)" }}
        />
      ) : (
        <span
          className="text-[30px] font-light"
          style={{ color: accent, lineHeight: 1.1, letterSpacing: "-0.02em" }}
        >
          {value}
        </span>
      )}
      <span
        className="text-[11px]"
        style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}
      >
        {description}
      </span>
    </div>
  );
}

// ── AIPanel — store-connected, floating FAB ───────────────────────────────────

function AIPanel({
  companyId,
  executiveSummary,
  onSwitchToAnalytics,
}: {
  companyId?:           string | null;
  executiveSummary?:    string | null;
  onSwitchToAnalytics?: () => void;
}) {
  const { dispatchUiAction } = useDashboardStore();

  function handleUiAction(action: UiAction) {
    dispatchUiAction(action);
    if (action.action === "SET_FILTER") onSwitchToAnalytics?.();
  }

  return (
    <AITerminal
      companyId={companyId}
      executiveSummary={executiveSummary}
      onUiAction={handleUiAction}
    />
  );
}

// ── Page (inner — uses useSearchParams, must be inside Suspense) ─────────────

function AnalystDashboardInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [user,             setUser]             = useState<UserInfo | null>(null);
  const [hydrated,         setHydrated]         = useState(false);

  // Bootstrap from URL: /analyst/dashboard?company_id=C015 → auto-select company
  const urlCompanyId = searchParams.get("company_id") ?? searchParams.get("company") ?? null;
  const [activeTab,        setActiveTab]        = useState<MainTab>(urlCompanyId ? "analytics" : "portfolio");
  const [selectedCompanyId,setSelectedCompanyId]= useState<string | null>(urlCompanyId);
  const [inviteModalOpen,  setInviteModalOpen]  = useState(false);
  const [showUploadBanner, setShowUploadBanner] = useState(false);
  const [ingestReview,     setIngestReview]     = useState<IngestReview | null>(null);
  const [coverageSummary,  setCoverageSummary]  = useState<CoverageSummary>({
    compliance: null,
    riskCount:  null,
    loaded:     false,
  });

  const { results, loading: _loading, error } = useAnalystData(selectedCompanyId);
  const periodFilter = usePeriodFilter();
  const { metaError } = usePortfolioMetadata();

  const filteredResults = periodFilter.filterByPeriod(
    results, (r) => r.metadata?.processed_at,
  );

  const activeResult = useMemo(() => {
    for (let i = filteredResults.length - 1; i >= 0; i--) {
      const fm = (filteredResults[i].data as Record<string, unknown>)
        ?.financial_metrics_2025 as Record<string, unknown> | undefined;
      if (fm && Object.keys(fm).length > 0) return filteredResults[i];
    }
    return null;
  }, [filteredResults]);

  const kpisFiltered = useMemo(
    () => activeResult ? extractKPIs([activeResult]) : extractKPIs(filteredResults),
    [activeResult, filteredResults],
  );

  const autoYearRef = useRef<string | null>(null);
  useEffect(() => {
    if (!results.length || autoYearRef.current === selectedCompanyId) return;
    const years = results
      .map((r) => {
        const m = (r.metadata?.processed_at ?? "").match(/P?(20\d{2})/);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter((y): y is number => y !== null);
    if (years.length > 0) {
      periodFilter.setYear(Math.max(...years));
      autoYearRef.current = selectedCompanyId;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const isLegacy = useMemo(() => {
    const src = activeResult
      ? (activeResult.data as Record<string, unknown>)?._source
      : results.find((r) => (r.data as Record<string, unknown>)?._source === "bigquery_legacy")?.data?._source;
    return src === "bigquery_legacy";
  }, [activeResult, results]);

  const lastProcessedAt =
    activeResult?.metadata?.processed_at
    ?? filteredResults.at(-1)?.metadata?.processed_at
    ?? results.at(-1)?.metadata?.processed_at;

  const periodLabel      = formatVaultDate(lastProcessedAt);
  const executiveSummary = buildExecutiveSummary(kpisFiltered, isLegacy, periodLabel);

  // Load coverage summary when portfolio tab is active
  useEffect(() => {
    if (activeTab !== "portfolio") return;
    setCoverageSummary({ compliance: null, riskCount: null, loaded: false });
    fetchCoverage(null)
      .then((res) => {
        const { periods, companies, cells } = res;
        if (periods.length === 0 || companies.length === 0) {
          setCoverageSummary({ compliance: 0, riskCount: 0, loaded: true });
          return;
        }
        const latestPeriod  = periods[periods.length - 1];
        const latestCells   = cells.filter((c) => c.period === latestPeriod);
        const withData      = new Set(latestCells.map((c) => c.company)).size;
        const riskCount     = latestCells.filter((c) => c.status === "missing").length;
        const compliance    = Math.round((withData / companies.length) * 100);
        setCoverageSummary({ compliance, riskCount, loaded: true });
      })
      .catch(() => setCoverageSummary({ compliance: null, riskCount: null, loaded: true }));
  }, [activeTab]);

  useEffect(() => { validateSession().then((u) => { setUser(u); setHydrated(true); }); }, []);

  if (!hydrated) return null;

  function handleCompanyClick(key: string) {
    const canonicalId = key.trim();
    setSelectedCompanyId(canonicalId);
    periodFilter.reset();
    autoYearRef.current = null;
    setActiveTab("analytics");
    // Sync URL so the company selection is bookmarkable/shareable
    router.replace(`/analyst/dashboard?company_id=${encodeURIComponent(canonicalId)}`, { scroll: false });
  }

  const complianceColor =
    coverageSummary.compliance === null ? "var(--cometa-fg-muted)"
    : coverageSummary.compliance >= 75   ? "#10b981"
    : coverageSummary.compliance >= 40   ? "#f59e0b"
    : "#f87171";

  const riskColor =
    coverageSummary.riskCount === null ? "var(--cometa-fg-muted)"
    : coverageSummary.riskCount === 0   ? "#10b981"
    : coverageSummary.riskCount <= 2    ? "#f59e0b"
    : "#f87171";

  return (
    <DashboardProvider>
      <div
        className="flex h-screen flex-col overflow-hidden"
        style={{ background: "#03091a" }}
      >
        {/* ── Metadata error banner (non-blocking) ── */}
        {metaError && (
          <div
            className="flex items-center gap-2 px-4 py-1.5 text-[11px]"
            style={{ background: "rgba(251,191,36,0.08)", borderBottom: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24" }}
          >
            <AlertTriangle size={11} />
            <span>Los metadatos del portfolio no pudieron cargarse. Algunas columnas mostrarán "—".</span>
          </div>
        )}

        {/* ── Top Navbar ── */}
        <AppHeader
          user={user}
          selectedCompanyId={selectedCompanyId}
          onInviteClick={() => setInviteModalOpen(true)}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          hasError={!!error}
        />

        {/* ── Content — full width ── */}
        <div className={`flex-1 ${activeTab === "analytics" ? "overflow-hidden" : "overflow-y-auto pb-24"}`}>

          {/* ─ Portfolio tab: Executive Summary + Health Heatmap ─ */}
          {activeTab === "portfolio" && (
            <div className="p-6 space-y-6 max-w-7xl mx-auto">

              {/* 3 Executive Summary Widgets */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <SummaryWidget
                  label="Cumplimiento"
                  value={
                    !coverageSummary.loaded ? "…"
                    : coverageSummary.compliance !== null
                      ? `${coverageSummary.compliance}%`
                      : "—"
                  }
                  description="de empresas con reporte este período"
                  accent={complianceColor}
                  loading={!coverageSummary.loaded}
                />
                <SummaryWidget
                  label="Riesgo"
                  value={
                    !coverageSummary.loaded ? "…"
                    : coverageSummary.riskCount !== null
                      ? String(coverageSummary.riskCount)
                      : "—"
                  }
                  description="empresas en estado crítico"
                  accent={riskColor}
                  loading={!coverageSummary.loaded}
                />
                <SummaryWidget
                  label="Runway Promedio"
                  value="—"
                  description="meses de vida del portafolio"
                  accent="var(--cometa-fg-muted)"
                />
              </div>

              {/* Health Heatmap */}
              <PortfolioHeatmap onCompanyClick={handleCompanyClick} />
            </div>
          )}

          {/* ─ Analytics tab — true full screen ─ */}
          {activeTab === "analytics" && (
            <div className="h-full flex flex-col">
              {/* Upload success banner */}
              <AnimatePresence>
                {showUploadBanner && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="shrink-0 flex items-center gap-3 px-5 py-2.5"
                    style={{ background: "rgba(74,222,128,0.08)", borderBottom: "1px solid rgba(74,222,128,0.2)" }}
                  >
                    <CheckCircle2 size={14} style={{ color: "#4ade80" }} />
                    <span className="text-[12px] flex-1" style={{ color: "#4ade80" }}>
                      Datos cargados exitosamente a BigQuery — fact_portfolio_kpis actualizado.
                    </span>
                    <button
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-opacity hover:opacity-80 shrink-0"
                      style={{ color: "#000", background: "#4ade80", border: "1px solid #4ade80" }}
                    >
                      <RefreshCw size={11} />
                      Actualizar Reporte en Looker
                    </button>
                    <button
                      onClick={() => setShowUploadBanner(false)}
                      className="shrink-0 p-1 transition-opacity hover:opacity-60"
                      style={{ color: "#475569" }}
                    >
                      <X size={13} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Looker iframe — rest of the screen */}
              <div className="flex-1 min-h-0">
                <LookerEmbed
                  companyId={selectedCompanyId}
                  className="h-full w-full"
                />
              </div>
            </div>
          )}

          {/* ─ Ingestion tab ─ */}
          {activeTab === "ingestion" && (
            <div className="h-full">
              {ingestReview ? (
                <KpiReviewPanel
                  loadId={ingestReview.loadId}
                  slug={ingestReview.slug}
                  periodo={ingestReview.periodo}
                  sourceFileUri={ingestReview.sourceFileUri}
                  analystId={ingestReview.analystId}
                  currency={ingestReview.currency}
                  cerebroResult={ingestReview.cerebroResult}
                  onFinalized={(_result: FinalizeAnalysisResponse) => {
                    setIngestReview(null);
                    setShowUploadBanner(true);
                    setActiveTab("analytics");
                  }}
                  onCancel={() => setIngestReview(null)}
                />
              ) : (
                <RawDataBrowser
                  analystId={user?.user_id ?? "ANA-000000"}
                  onApprove={(data: StageReviewData) => {
                    setIngestReview({
                      loadId:        data.loadId,
                      slug:          data.slug,
                      periodo:       data.periodo,
                      sourceFileUri: data.sourceFileUri,
                      analystId:     data.analystId,
                      currency:      data.currency,
                      cerebroResult: data.cerebroResult,
                    });
                  }}
                />
              )}
            </div>
          )}

          {/* ─ Settings tab ─ */}
          {activeTab === "settings" && <SettingsPage />}

        </div>

        {/* ── Floating Cometa AI FAB ── */}
        <AIPanel
          companyId={selectedCompanyId}
          executiveSummary={executiveSummary}
          onSwitchToAnalytics={() => setActiveTab("analytics")}
        />
      </div>

      <InviteFounder
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
      />
    </DashboardProvider>
  );
}

// ── Page export — Suspense wrapper required for useSearchParams ───────────────

export default function AnalystDashboardPage() {
  return (
    <Suspense fallback={null}>
      <AnalystDashboardInner />
    </Suspense>
  );
}
