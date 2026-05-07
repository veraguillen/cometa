"use client";

/**
 * ExecutiveSummaryText — prose KPI summary for the analyst dashboard header.
 *
 * Exports `buildExecutiveSummary(kpis, isLegacy, periodLabel)` as a pure
 * function so the AITerminal can send the same pre-computed string to
 * /api/chat as `executive_summary`.
 */

interface ExecutiveSummaryTextProps {
  companyId: string | null;
  kpis:      Record<string, string>;
  loading:   boolean;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Monetary formatter: raw number or "$2,400,000" / "2.4M" → "$2.4M" / "$840K"
 * Returns null when the value is not parseable.
 */
function fmtMoney(v: string): string | null {
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  if (isNaN(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Percentage formatter:
 *   - "0.99"  → "99%"   (BQ decimal ratio — abs < 5 treated as ratio)
 *   - "45.2"  → "45.2%" (already a percentage point)
 *   - "45.2%" → "45.2%" (has symbol — strip and reformat)
 * Returns null when not parseable.
 */
function fmtPct(v: string): string | null {
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  if (isNaN(n)) return null;
  const pct = Math.abs(n) < 5 ? n * 100 : n;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

// ── Pure summary builder ──────────────────────────────────────────────────────

/**
 * Builds an elegant, analyst-grade prose paragraph from the KPI map.
 *
 * @param kpis        - Record of camelCase KPI key → raw string value
 * @param isLegacy    - true when data comes from BigQuery (not a PDF upload)
 * @param periodLabel - Human-readable label like "Q4 2024" (from formatVaultDate)
 *
 * Returns null when there is nothing meaningful to show (no real KPI values
 * and isLegacy is false), so the dashboard can render its own empty-state.
 */
export function buildExecutiveSummary(
  kpis:        Record<string, string>,
  isLegacy    = false,
  periodLabel?: string,
): string | null {
  // Filter out placeholder values — "—" and "…" are not real data
  const real = (v: string | undefined): string | null => {
    if (!v || v === "—" || v === "…" || v.trim() === "") return null;
    return v;
  };

  const revRaw    = real(kpis["totalRevenue"]);
  const growthRaw = real(kpis["revenueGrowth"]);
  const marginRaw = real(kpis["grossMargin"]) ?? real(kpis["ebitdaMargin"]);
  const marginKey = real(kpis["grossMargin"]) ? "bruto" : "EBITDA";
  const cashRaw   = real(kpis["cashInBank"]);

  const revFmt    = revRaw    ? fmtMoney(revRaw)    : null;
  const marginFmt = marginRaw ? fmtPct(marginRaw)   : null;
  const cashFmt   = cashRaw   ? fmtMoney(cashRaw)   : null;

  // Nothing to show — fall back to BQ generic or return null
  if (!revFmt && !marginFmt && !cashFmt) {
    return isLegacy
      ? "Datos históricos consolidados disponibles en BigQuery."
      : null;
  }

  // ── Growth direction clause ──────────────────────────────────────────────
  let growthClause = "";
  if (growthRaw) {
    const n      = parseFloat(growthRaw.replace(/[^0-9.\-]/g, ""));
    const pctVal = Math.abs(n) < 5 ? n * 100 : n;
    const pctStr = fmtPct(growthRaw);
    if (pctStr) {
      growthClause =
        pctVal >= 0
          ? `, con una expansión del ${pctStr}`
          : `, registrando un ajuste a la baja del ${fmtPct(String(Math.abs(pctVal)))}`;
    }
  }

  // ── Compose sentences ────────────────────────────────────────────────────
  const intro = periodLabel ? `Durante ${periodLabel}, ` : "";

  // Primary: revenue
  let prose = revFmt
    ? `${intro}la empresa reportó ingresos de ${revFmt}${growthClause}.`
    : `${intro}la empresa operó durante el período analizado.`;

  // Secondary: margin + cash
  const secondary: string[] = [];
  if (marginFmt) secondary.push(`margen ${marginKey} del ${marginFmt}`);
  if (cashFmt)   secondary.push(`caja disponible de ${cashFmt}`);

  if (secondary.length === 1) {
    prose += ` Operó con un ${secondary[0]}.`;
  } else if (secondary.length === 2) {
    prose += ` Operó con un ${secondary[0]} y ${secondary[1]}.`;
  }

  return prose;
}

// ── Component (used in contexts outside the main dashboard card) ─────────────

export default function ExecutiveSummaryText({
  companyId,
  kpis,
  loading,
}: ExecutiveSummaryTextProps) {
  if (!companyId) return null;

  if (loading) {
    return (
      <div
        className="h-2.5 w-48 animate-pulse rounded-full"
        style={{ background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)" }}
      />
    );
  }

  const summary = buildExecutiveSummary(kpis);
  if (!summary) return null;

  return (
    <p
      className="text-[11px] font-light leading-relaxed"
      style={{ color: "var(--cometa-fg-muted)" }}
    >
      {summary}
    </p>
  );
}
