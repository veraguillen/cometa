"use client";

/**
 * BentoCharts — Recharts visualization panel.
 *
 * Two rendering modes, driven automatically by the `results` prop:
 *
 *   Time-series  (results.length > 1)
 *     X axis = quarters/periods (Q1, Q2, Q3, Q4 — or Q1'22, Q2'23 for multi-year)
 *     Chart 1  Revenue trend      → totalRevenue per period (AreaChart, span-2)
 *     Chart 2  Margin evolution   → grossMargin + ebitdaMargin % per period (BarChart)
 *     Chart 3  Cash in bank       → cashInBank per period (AreaChart, span-2)
 *     Chart 4  Performance heatmap → current period snapshot (unchanged)
 *     Null values = gap in the line (connectNulls=false, Recharts default)
 *
 *   Snapshot  (results absent or length ≤ 1)
 *     Original cross-sectional charts comparing KPI types for the current period.
 *
 * toK() correctly converts raw BQ USD strings like "2,400,000" to K units (÷1000).
 */

import { motion } from "framer-motion";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { extractKPIs } from "@/services/analyst";
import type { AnalysisResult } from "@/lib/schemas";

// ── Props ─────────────────────────────────────────────────────────────────────

interface BentoChartsProps {
  kpis:     Record<string, string>;
  loading?: boolean;
  /** Ordered, filtered result set. When >1 item activates time-series charts. */
  results?: AnalysisResult[];
}

// ── Animations ────────────────────────────────────────────────────────────────

const item = {
  hidden: { opacity: 0, y: 16, filter: "blur(4px)" },
  show:   { opacity: 1, y: 0,  filter: "blur(0px)",
            transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] as const } },
};

// ── Chart card wrapper ────────────────────────────────────────────────────────

function ChartCard({
  title, badge, children, span = 1,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
  span?: number;
}) {
  return (
    <motion.div
      variants={item}
      className={`kpi-card${span === 2 ? " col-span-2" : ""}`}
    >
      <div className="flex items-center gap-2 mb-4">
        <span
          className="text-[10px] uppercase tracking-widest"
          style={{ color: "var(--cometa-fg-muted)" }}
        >
          {title}
        </span>
        {badge && (
          <span
            className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-widest"
            style={{
              color:      "var(--cometa-accent)",
              background: "color-mix(in srgb, var(--cometa-accent) 12%, transparent)",
              border:     "1px solid color-mix(in srgb, var(--cometa-accent) 20%, transparent)",
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {children}
    </motion.div>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipPayload { value: number | null; name?: string; color?: string }

/** Format a tooltip value: names ending in "%" → percent, rest → monetary (K/M) */
function fmtTooltip(value: number, name?: string): string {
  if (name?.endsWith("%")) return `${value.toFixed(1)}%`;
  // monetary in K units
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}M`;
  return `$${value.toFixed(0)}K`;
}

const CustomTooltip = ({
  active, payload, label,
}: { active?: boolean; payload?: TooltipPayload[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg px-3 py-2 text-[11px] shadow-lg"
      style={{
        background:     "var(--cometa-card-bg)",
        border:         "1px solid var(--cometa-card-border)",
        color:          "var(--cometa-fg)",
        backdropFilter: "blur(16px)",
      }}
    >
      <div className="mb-1" style={{ color: "var(--cometa-fg-muted)" }}>{label}</div>
      {payload.map((p, i) => {
        if (p.value == null) return null;
        return (
          <div key={i} style={{ color: p.color ?? "var(--cometa-accent)", fontWeight: 400 }}>
            {p.name ? `${p.name}: ` : ""}{fmtTooltip(p.value, p.name)}
          </div>
        );
      })}
    </div>
  );
};

// ── Numeric helpers ───────────────────────────────────────────────────────────

/**
 * Convert any string value to K units for monetary charts.
 *
 * Handles:
 *   "2.4M"       → 2 400 K
 *   "340K"        → 340 K
 *   "2,400,000"   → 2 400 K  (raw BQ USD — divided by 1 000)
 *   "500 000"     → 500 K
 *   "45.2" / "18" → 45.2 / 18 (small numbers: %, rates — returned as-is)
 */
function toK(v: string | undefined): number | null {
  if (!v || v === "—" || v === "…") return null;
  const upper = v.toUpperCase();
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  if (isNaN(n)) return null;
  if (upper.includes("M")) return n * 1_000;
  if (upper.includes("K")) return n;
  // Raw base-currency value from BQ (e.g. 2 400 000 USD) → K
  if (Math.abs(n) >= 10_000) return n / 1_000;
  return n;
}

/**
 * Parse a percentage value to a number in % units.
 *   "18.3%" → 18.3
 *   "18.3"  → 18.3  (already in % points, abs ≥ 5)
 *   "0.45"  → 45    (BQ decimal ratio, abs < 5 → × 100)
 */
function toPct(v: string | undefined): number | null {
  if (!v || v === "—" || v === "…") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  if (isNaN(n)) return null;
  return Math.abs(n) < 5 ? n * 100 : n;
}

// ── Period label helpers ──────────────────────────────────────────────────────

/** Extract year from BQ period_id P2023Q4M12 → "2023" */
function pidYear(pid: string): string {
  return pid.match(/P(20\d{2})/)?.[1] ?? "";
}

/**
 * Short X-axis label.
 *   multiYear=false → "Q4"
 *   multiYear=true  → "Q4'23"
 */
function periodLabel(pid: string, multiYear: boolean): string {
  const bq = pid.match(/P(20\d{2})Q([1-4])/);
  if (bq) return multiYear ? `Q${bq[2]}'${bq[1].slice(2)}` : `Q${bq[2]}`;
  const iso = pid.match(/^(20\d{2})-(\d{2})/);
  if (iso) return multiYear ? `${iso[1].slice(2)}/${iso[2]}` : `M${iso[2]}`;
  return pid.slice(0, 6);
}

// ── Heatmap config ────────────────────────────────────────────────────────────

const HEATMAP_METRICS = [
  { key: "revenueGrowth", label: "Rev Growth" },
  { key: "grossMargin",   label: "Gross Mgn"  },
  { key: "ebitdaMargin",  label: "EBITDA"     },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function BentoCharts({ kpis, loading, results }: BentoChartsProps) {
  const accentColor  = "var(--cometa-accent)";
  const mutedStroke  = "var(--cometa-card-border)";
  const axisColor    = "var(--cometa-fg-muted)";
  const greenColor   = "hsl(142,71%,45%)";

  // ── Mode detection ──────────────────────────────────────────────────────────
  const isTimeSeries = !!results && results.length > 1;
  const multiYear    = isTimeSeries &&
    new Set(results!.map(r => pidYear(r.metadata?.processed_at ?? ""))).size > 1;

  // ── Time-series builders ────────────────────────────────────────────────────
  /**
   * Build one data point per result for a given KPI key.
   * monetary=true  → value in K units (toK)
   * monetary=false → raw number (toPct, for %)
   * null = gap in the chart (quarter has no data)
   */
  function buildSeries(
    kpiKey: string,
    monetary: boolean,
  ): { name: string; value: number | null }[] {
    return (results ?? []).map(r => {
      const snap  = extractKPIs([r]);
      const raw   = snap[kpiKey as keyof typeof snap] ?? "—";
      const value = monetary ? toK(raw) : toPct(raw);
      const pid   = r.metadata?.processed_at ?? r.date ?? "";
      return { name: periodLabel(pid, multiYear), value };
    });
  }

  // ── Snapshot data (single-period view) ─────────────────────────────────────
  const snapshotRevenueData = [
    { name: "Revenue",   value: toK(kpis.totalRevenue)    },
    { name: "Cash Flow", value: toK(kpis.annualCashFlow)  },
    { name: "Net Income",value: toK(kpis.netIncome)       },
    { name: "Cash Bank", value: toK(kpis.cashInBank)      },
  ].filter((d): d is { name: string; value: number } => d.value !== null);

  const snapshotBurnData = [
    { name: "WC Debt", value: toK(kpis.workingCapitalDebt) },
    { name: "Net WC",  value: toK(kpis.netWorkingCapital)  },
  ].filter((d): d is { name: string; value: number } => d.value !== null);

  const snapshotCashData = [
    { name: "Cash Bank",   value: toK(kpis.cashInBank)        ?? 0 },
    { name: "Net WC",      value: toK(kpis.netWorkingCapital) ?? 0 },
    { name: "Cash Flow",   value: toK(kpis.annualCashFlow)    ?? 0 },
    { name: "Net Income",  value: toK(kpis.netIncome)         ?? 0 },
  ];

  // ── Resolved chart data ─────────────────────────────────────────────────────
  const revData     = isTimeSeries ? buildSeries("totalRevenue", true)  : snapshotRevenueData;
  const cashData    = isTimeSeries ? buildSeries("cashInBank",   true)  : snapshotCashData;
  const marginData  = isTimeSeries ? buildSeries("grossMargin",  false) : snapshotBurnData;
  const ebitdaData  = isTimeSeries ? buildSeries("ebitdaMargin", false) : [];

  // For time-series margin chart, merge grossMargin + ebitdaMargin per period
  const marginBarData: { name: string; gross: number | null; ebitda: number | null }[] =
    isTimeSeries
      ? marginData.map((d, i) => ({ name: d.name, gross: d.value, ebitda: ebitdaData[i]?.value ?? null }))
      : [];

  // ── Has-data guards ─────────────────────────────────────────────────────────
  const hasRevenue = revData.some(d => d.value != null && d.value !== 0);
  const hasCash    = cashData.some(d => d.value != null && d.value !== 0);
  const hasMargin  = isTimeSeries
    ? marginBarData.some(d => d.gross != null || d.ebitda != null)
    : snapshotBurnData.length > 0;

  // ── Heatmap (always snapshot) ───────────────────────────────────────────────
  const heatRows = HEATMAP_METRICS.map(({ key, label }) => ({
    label,
    value: toPct(kpis[key]),
  }));
  const maxPct = Math.max(...heatRows.map(r => Math.abs(r.value ?? 0)), 1);

  // ── Axis formatters ─────────────────────────────────────────────────────────
  const moneyFmt = (v: number) =>
    Math.abs(v) >= 1_000 ? `$${(v / 1_000).toFixed(1)}M` : `$${v.toFixed(0)}K`;

  const pctFmt = (v: number) => `${v.toFixed(0)}%`;

  // ── Placeholder ─────────────────────────────────────────────────────────────
  const Placeholder = ({ h = "h-48" }: { h?: string }) => (
    <div className={`${h} flex items-center justify-center`}>
      {loading ? (
        <div
          className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
          style={{ borderTopColor: accentColor }}
        />
      ) : (
        <p className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
          Sin datos disponibles
        </p>
      )}
    </div>
  );

  const badge = isTimeSeries ? (multiYear ? "Multi-year" : "Quarterly") : undefined;

  return (
    <motion.div
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.1 } } }}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
    >

      {/* ── Chart 1: Revenue trend (span-2) ─────────────────────────────────── */}
      <ChartCard title="Revenue trend" badge={badge} span={2}>
        {!hasRevenue || loading ? <Placeholder /> : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revData}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={accentColor} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={accentColor} stopOpacity={0}   />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={mutedStroke} opacity={0.2} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={isTimeSeries ? moneyFmt : (v) => v >= 1000 ? `$${(v/1000).toFixed(1)}M` : `$${v}K`}
                  domain={[(min: number) => min * 0.9, (max: number) => max * 1.05]}
                  width={58}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={accentColor}
                  fill="url(#revGrad)"
                  strokeWidth={1.5}
                  dot={isTimeSeries ? { r: 3, fill: accentColor, strokeWidth: 0 } : false}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>

      {/* ── Chart 2: Margins (span-1) ────────────────────────────────────────── */}
      <ChartCard
        title={isTimeSeries ? "Margin evolution" : "Capital structure"}
        badge={badge}
      >
        {!hasMargin || loading ? <Placeholder /> : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              {isTimeSeries ? (
                /* Time-series: Gross Margin + EBITDA margin bars per quarter */
                <BarChart data={marginBarData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke={mutedStroke} opacity={0.2} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 10, fill: axisColor }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: axisColor }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={pctFmt}
                    domain={['auto', 'auto']}
                    width={36}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="gross"
                    name="Gross%"
                    fill={accentColor}
                    radius={[3, 3, 0, 0]}
                    opacity={0.8}
                    maxBarSize={18}
                  />
                  <Bar
                    dataKey="ebitda"
                    name="EBITDA%"
                    fill={greenColor}
                    radius={[3, 3, 0, 0]}
                    opacity={0.7}
                    maxBarSize={18}
                  />
                </BarChart>
              ) : (
                /* Snapshot: WC Debt vs Net WC */
                <BarChart data={snapshotBurnData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={mutedStroke} opacity={0.2} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 10, fill: axisColor }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: axisColor }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => v >= 1000 ? `$${(v/1000).toFixed(0)}M` : `$${v}K`}
                    domain={[(min: number) => min * 0.9, (max: number) => max * 1.05]}
                    width={48}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="value"
                    fill={accentColor}
                    radius={[3, 3, 0, 0]}
                    opacity={0.7}
                  />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>

      {/* ── Chart 3: Cash & liquidity (span-2) ──────────────────────────────── */}
      <ChartCard title="Cash in bank" badge={badge} span={2}>
        {!hasCash || loading ? <Placeholder /> : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cashData}>
                <defs>
                  <linearGradient id="cashGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={greenColor} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={greenColor} stopOpacity={0}   />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={mutedStroke} opacity={0.2} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: axisColor }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={isTimeSeries ? moneyFmt : (v) => v >= 1000 ? `$${(v/1000).toFixed(1)}M` : `$${v}K`}
                  domain={[(min: number) => min * 0.9, (max: number) => max * 1.05]}
                  width={58}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={greenColor}
                  fill="url(#cashGrad)"
                  strokeWidth={1.5}
                  dot={isTimeSeries ? { r: 3, fill: greenColor, strokeWidth: 0 } : false}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>

      {/* ── Chart 4: Performance heatmap (span-1) — always snapshot ─────────── */}
      <ChartCard title="Performance heatmap">
        {loading ? <Placeholder h="h-32" /> : (
          <div className="space-y-1.5">
            <div
              className="flex gap-1 text-[9px] pl-20"
              style={{ color: "var(--cometa-fg-muted)" }}
            >
              <span className="flex-1 text-center">Score</span>
            </div>
            {heatRows.map((row) => {
              const normalized = row.value != null ? Math.abs(row.value) / maxPct : 0;
              const isNeg = (row.value ?? 0) < 0;
              return (
                <div key={row.label} className="flex gap-1 items-center">
                  <span
                    className="text-[10px] w-20 shrink-0"
                    style={{ color: "var(--cometa-fg-muted)" }}
                  >
                    {row.label}
                  </span>
                  <div
                    className="flex-1 h-6 rounded-sm flex items-center justify-center text-[9px]"
                    style={{
                      background: isNeg
                        ? `rgba(248,113,113,${normalized * 0.6})`
                        : `color-mix(in srgb, var(--cometa-accent) ${Math.round(normalized * 60)}%, transparent)`,
                      color: normalized > 0.6 ? "var(--cometa-bg)" : "var(--cometa-fg-muted)",
                    }}
                  >
                    {row.value != null
                      ? `${row.value > 0 ? "+" : ""}${row.value.toFixed(1)}%`
                      : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ChartCard>

    </motion.div>
  );
}
