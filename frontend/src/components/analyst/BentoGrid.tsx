"use client";

/**
 * BentoGrid — 10-card KPI mosaic.
 *   grid-cols-2 sm:grid-cols-3 lg:grid-cols-5, stagger 0.05s
 * Accepts kpiSources (ia|manual per key) and lastUpdate (ISO timestamp)
 * and forwards them to each KPICard for badge + timestamp display.
 */

import { motion } from "framer-motion";
import KPICard, { kpiCardVariant } from "@/components/analyst/KPICard";

interface BentoGridProps {
  kpis:          Record<string, string>;
  totalDocs?:    number;
  loading?:      boolean;
  kpiSources?:   Record<string, "ia" | "manual">;
  lastUpdate?:   string;   // ISO timestamp — passed to every card
  submissionId?: string;   // file_hash for PUT /api/kpi-update
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

export default function BentoGrid({
  kpis,
  totalDocs    = 0,
  loading,
  kpiSources   = {},
  lastUpdate,
  submissionId,
}: BentoGridProps) {
  const v = (key: string) => (loading ? "…" : (kpis[key] ?? "—"));

  // Cards that always render (as placeholder or real value)
  const ALWAYS_SHOW = new Set(["totalRevenue", "cashInBank", "_docs"]);

  // Core financial KPIs: shown as ghost cards when empty so the analyst sees what's missing
  const CORE_KPIS = new Set(["totalRevenue", "grossMargin", "ebitdaMargin", "cashInBank"]);

  const cards: {
    label:    string;
    kpiKey:   string;   // camelCase — for kpiSources lookup
    metricId: string;   // snake_case — for PUT /api/kpi-update
    value:    string;
    unit?:    string;
    change?:  number | null;
  }[] = [
    { label: "Revenue Growth",     kpiKey: "revenueGrowth",     metricId: "revenue_growth",       value: v("revenueGrowth"),     unit: "YoY", change: parseChange(kpis.revenueGrowth) },
    { label: "Gross Margin",       kpiKey: "grossMargin",        metricId: "gross_profit_margin",  value: v("grossMargin"),       change: parseChange(kpis.grossMargin) },
    { label: "EBITDA Margin",      kpiKey: "ebitdaMargin",       metricId: "ebitda_margin",        value: v("ebitdaMargin"),      change: parseChange(kpis.ebitdaMargin) },
    { label: "Cash in Bank",       kpiKey: "cashInBank",         metricId: "cash_in_bank",         value: v("cashInBank"),        unit: "EoY", change: signOf(kpis.cashInBank) },
    { label: "Annual Cash Flow",   kpiKey: "annualCashFlow",     metricId: "annual_cash_flow",     value: v("annualCashFlow"),    change: signOf(kpis.annualCashFlow) },
    { label: "WC Debt",            kpiKey: "workingCapitalDebt", metricId: "working_capital_debt", value: v("workingCapitalDebt"),change: signOf(kpis.workingCapitalDebt, true) },
    { label: "Net Working Capital",kpiKey: "netWorkingCapital",  metricId: "net_working_capital",  value: v("netWorkingCapital"), change: signOf(kpis.netWorkingCapital) },
    { label: "Total Revenue",      kpiKey: "totalRevenue",       metricId: "total_revenue",        value: v("totalRevenue"),      change: signOf(kpis.totalRevenue) },
    { label: "Net Income",         kpiKey: "netIncome",          metricId: "net_income",           value: v("netIncome"),         change: signOf(kpis.netIncome) },
    { label: "Documentos",         kpiKey: "_docs",              metricId: "",                     value: loading ? "…" : String(totalDocs), unit: "reportes", change: null },
  ];

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3"
    >
      {cards
        .filter((card) => {
          // While loading show all skeletons so the grid doesn't collapse
          if (loading) return true;
          // Core KPIs always appear (real value or ghost placeholder)
          if (CORE_KPIS.has(card.kpiKey)) return true;
          // Docs counter always shows
          if (ALWAYS_SHOW.has(card.kpiKey)) return true;
          // All other cards: hide when empty
          return card.value !== "—" && card.value !== "…" && card.value !== "";
        })
        .map((card) => {
          const isEmpty = !loading && (card.value === "—" || card.value === "…" || card.value === "");
          const isGhost = isEmpty && CORE_KPIS.has(card.kpiKey);
          return (
            <motion.div key={card.label} variants={kpiCardVariant}>
              <KPICard
                label={card.label}
                value={card.value}
                unit={card.unit}
                change={card.change}
                source={kpiSources[card.kpiKey] ?? "ia"}
                lastUpdate={lastUpdate}
                metricId={card.metricId || undefined}
                submissionId={submissionId}
                ghost={isGhost}
              />
            </motion.div>
          );
        })}
    </motion.div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseChange(v: string | undefined): number | null {
  if (!v || v === "—" || v === "…") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

function signOf(v: string | undefined, lowerIsBetter = false): number | null {
  if (!v || v === "—" || v === "…") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  if (isNaN(n)) return null;
  const raw = n === 0 ? 0 : n > 0 ? 0.001 : -0.001;
  return lowerIsBetter ? -raw : raw;
}
