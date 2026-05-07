"use client";

/**
 * PortfolioHeatmap — Coverage matrix: companies (Y) × periods (X).
 *
 * Uses exclusively CSS custom properties from globals.css so it renders
 * correctly in all four themes (Pearl, Obsidian, Slate, Umber).
 *
 * Cell semáforo:
 *   verified → var(--cometa-accent) · 100% opacity (green/steel depending on theme)
 *   legacy   → #F59E0B amber (universal semantic color)
 *   missing  → #EF4444 red with subtle pulse when data is critical
 *   no-data  → var(--cometa-card-border) striped — company never reported this period
 *
 * Navigation: click any data cell → /analyst/dashboard?company_id=[slug]
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, RefreshCw, CheckCircle2, Clock, XCircle } from "lucide-react";
import { fetchCoverage }                from "@/services/analyst";
import type { CoverageCell, CoverageCompany, CoverageResponse } from "@/lib/schemas";

// ── Period label helpers ──────────────────────────────────────────────────────

const MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

/** "P2025Q1M01" → "Ene" · "P2025Q1M02" → "Feb" · fallback "Q1 '25" */
function periodShort(p: string): string {
  const monthly = p.match(/^P(\d{4})Q[1-4]M(\d{2})$/);
  if (monthly) {
    const idx = parseInt(monthly[2], 10) - 1;
    return MONTH_NAMES[idx] ?? `M${monthly[2]}`;
  }
  const quarterly = p.match(/^P(\d{4})Q([1-4])/);
  if (quarterly) return `Q${quarterly[2]} '${quarterly[1].slice(2)}`;
  return p.slice(0, 7);
}

/** Extract year string from canonical period */
function periodYear(p: string): string {
  const m = p.match(/^P(\d{4})/);
  return m ? m[1] : "?";
}

/** Group an array of periods by year for the double-row header */
function groupPeriodsByYear(periods: string[]): Array<{ year: string; periods: string[] }> {
  const map = new Map<string, string[]>();
  for (const p of periods) {
    const y = periodYear(p);
    if (!map.has(y)) map.set(y, []);
    map.get(y)!.push(p);
  }
  return Array.from(map.entries()).map(([year, ps]) => ({ year, periods: ps }));
}

// ── Status config — only semantic status colors hardcoded; brand colors via CSS vars ──

type CellStatus = CoverageCell["status"] | "nodata";

const STATUS_CONFIG: Record<CellStatus, {
  bg:        string;
  fg:        string;
  label:     string;
  Icon:      React.ComponentType<{ size?: number; strokeWidth?: number }>;
  pulse:     boolean;
}> = {
  verified: {
    bg:    "#10b981",
    fg:    "#000000",
    label: "Salud óptima",
    Icon:  CheckCircle2,
    pulse: false,
  },
  legacy: {
    bg:    "#f59e0b",
    fg:    "#000000",
    label: "Alerta",
    Icon:  Clock,
    pulse: false,
  },
  missing: {
    bg:    "#f87171",
    fg:    "#ffffff",
    label: "Crítico",
    Icon:  XCircle,
    pulse: true,
  },
  nodata: {
    bg:    "transparent",
    fg:    "var(--cometa-fg-muted)",
    label: "Sin datos",
    Icon:  XCircle,
    pulse: false,
  },
};

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipInfo {
  company: string;
  period:  string;
  status:  CellStatus;
  cell:    CoverageCell | null;
  x:       number;
  y:       number;
}

function Tooltip({ info }: { info: TooltipInfo }) {
  const cfg  = STATUS_CONFIG[info.status];
  const cell = info.cell;

  return (
    <motion.div
      key={`${info.company}-${info.period}`}
      initial={{ opacity: 0, scale: 0.92, y: 4 }}
      animate={{ opacity: 1, scale: 1,    y: 0 }}
      exit={{    opacity: 0, scale: 0.92, y: 4 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-none fixed z-50 rounded-xl px-3 py-2 text-[11px] shadow-xl"
      style={{
        left:        info.x + 12,
        top:         info.y - 8,
        background:  "var(--cometa-card-bg)",
        border:      "1px solid var(--cometa-card-border)",
        color:       "var(--cometa-fg)",
        backdropFilter: "blur(16px)",
        maxWidth:    220,
        transform:   "translateY(-100%)",
      }}
    >
      {/* Status dot + label */}
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: cfg.bg === "transparent" ? "var(--cometa-card-border)" : cfg.bg }}
        />
        <span style={{ color: "var(--cometa-fg)", fontWeight: 500 }}>{cfg.label}</span>
      </div>

      {/* Company · period */}
      <p className="truncate" style={{ color: "var(--cometa-fg-muted)" }}>
        {info.company}
      </p>
      <p style={{ color: "var(--cometa-fg-muted)" }}>
        {periodShort(info.period)}
      </p>

      {/* KPI counts */}
      {cell && cell.kpi_count > 0 && (
        <div
          className="mt-1.5 pt-1.5 flex gap-3"
          style={{ borderTop: "1px solid var(--cometa-card-border)" }}
        >
          <span style={{ color: "var(--cometa-accent)" }}>
            {cell.verified_count} verificados
          </span>
          <span style={{ color: "#F59E0B" }}>
            {cell.legacy_count} legacy
          </span>
          <span style={{ color: "var(--cometa-fg-muted)" }}>
            {cell.kpi_count} total
          </span>
        </div>
      )}
    </motion.div>
  );
}

// ── Single cell ───────────────────────────────────────────────────────────────

interface HeatCellProps {
  status:   CellStatus;
  cell:     CoverageCell | null;
  company:  string;
  period:   string;
  onClick:  () => void;
  onEnter:  (info: Omit<TooltipInfo, "x" | "y">, e: React.MouseEvent) => void;
  onLeave:  () => void;
}

function HeatCell({ status, cell, company, period, onClick, onEnter, onLeave }: HeatCellProps) {
  const cfg       = STATUS_CONFIG[status];
  const isNoData  = status === "nodata";
  const isMissing = status === "missing";

  return (
    <motion.button
      whileHover={{ scale: isNoData ? 1 : 1.08 }}
      whileTap={isNoData ? {} : { scale: 0.94 }}
      onClick={isNoData ? undefined : onClick}
      onMouseEnter={(e) => onEnter({ company, period, status, cell }, e)}
      onMouseLeave={onLeave}
      className="relative rounded-md flex items-center justify-center"
      style={{
        width:      36,
        height:     36,
        background: isNoData
          ? "color-mix(in srgb, var(--cometa-card-border) 40%, transparent)"
          : cfg.bg,
        cursor:     isNoData ? "default" : "pointer",
        border:     isNoData
          ? "1px dashed color-mix(in srgb, var(--cometa-card-border) 60%, transparent)"
          : "1px solid transparent",
        // Pulse keyframe via inline animation for "missing" cells
        animation:  isMissing ? "cometa-pulse 2s ease-in-out infinite" : undefined,
      }}
      aria-label={`${company} · ${periodShort(period)} · ${cfg.label}`}
    >
      {!isNoData && (
        <span style={{ color: cfg.fg, opacity: 0.9, display: "inline-flex" }}>
          <cfg.Icon size={14} strokeWidth={1.5} />
        </span>
      )}
    </motion.button>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  const items: Array<{ status: CellStatus; label: string }> = [
    { status: "verified", label: "Salud óptima — KPIs en meta" },
    { status: "legacy",   label: "Alerta — variaciones moderadas" },
    { status: "missing",  label: "Crítico — burn rate alto / runway bajo" },
    { status: "nodata",   label: "Sin datos subidos" },
  ];

  return (
    <div className="flex items-center gap-4 flex-wrap">
      {items.map(({ status, label }) => {
        const cfg = STATUS_CONFIG[status];
        return (
          <div key={status} className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{
                background: status === "nodata"
                  ? "color-mix(in srgb, var(--cometa-card-border) 40%, transparent)"
                  : cfg.bg,
                border: status === "nodata"
                  ? "1px dashed color-mix(in srgb, var(--cometa-card-border) 60%, transparent)"
                  : "none",
              }}
            />
            <span className="text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PortfolioHeatmapProps {
  /** When provided, restricts the heatmap to this portfolio/fund. */
  portfolioId?:    string | null;
  /** Called when the user clicks a company row or cell. Receives the company key. */
  onCompanyClick?: (companyKey: string) => void;
}

export default function PortfolioHeatmap({ portfolioId, onCompanyClick }: PortfolioHeatmapProps) {
  const router = useRouter();

  const [data,    setData]    = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  // Build lookup map for O(1) cell retrieval
  const cellMap = useRef(new Map<string, CoverageCell>());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCoverage(portfolioId);
      setData(res);
      // Rebuild lookup
      const map = new Map<string, CoverageCell>();
      for (const cell of res.cells) {
        map.set(`${cell.company}||${cell.period}`, cell);
      }
      cellMap.current = map;
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      const status   = axiosErr?.response?.status;
      const detail   = (axiosErr?.response?.data as { detail?: string })?.detail;
      console.error("[PortfolioHeatmap] Error cargando cobertura:", err);
      if (status === 401) {
        setError("Sesión expirada. Recarga la página para iniciar sesión de nuevo.");
      } else if (status === 403) {
        setError("Acceso denegado. Este mapa es exclusivo para analistas Cometa.");
      } else if (detail) {
        setError(`Error del servidor: ${detail}`);
      } else {
        setError(`Error HTTP ${status ?? "de red"} al cargar el mapa. Ver consola para detalles.`);
      }
    } finally {
      setLoading(false);
    }
  }, [portfolioId]); // re-fetch when the selected fund changes

  useEffect(() => { load(); }, [load]);

  const handleCellEnter = useCallback(
    (info: Omit<TooltipInfo, "x" | "y">, e: React.MouseEvent) => {
      setTooltip({ ...info, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleCellLeave = useCallback(() => setTooltip(null), []);

  const handleCellClick = useCallback((company: string) => {
    if (onCompanyClick) {
      onCompanyClick(company);
    } else {
      router.push(`/analyst/dashboard?company_id=${encodeURIComponent(company)}`);
    }
  }, [onCompanyClick, router]);

  // ── Skeleton loader ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="kpi-card space-y-4">
        <div className="flex items-center justify-between">
          <div
            className="h-3 w-40 animate-pulse rounded-full"
            style={{ background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)" }}
          />
          <div
            className="h-3 w-20 animate-pulse rounded-full"
            style={{ background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)" }}
          />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-2">
              <div
                className="h-9 w-32 animate-pulse rounded-md"
                style={{
                  background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
                  animationDelay: `${i * 80}ms`,
                }}
              />
              {[1, 2, 3, 4, 5, 6].map((j) => (
                <div
                  key={j}
                  className="h-9 w-9 animate-pulse rounded-md"
                  style={{
                    background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                    animationDelay: `${(i * 6 + j) * 40}ms`,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <div
        className="kpi-card flex items-start gap-3 rounded-xl"
        style={{
          background: "color-mix(in srgb, #f87171 8%, transparent)",
          border:     "1px solid color-mix(in srgb, #f87171 20%, transparent)",
        }}
      >
        <AlertCircle size={16} style={{ color: "#f87171", marginTop: 1 }} />
        <div className="flex-1">
          <p className="text-[12px]" style={{ color: "#f87171" }}>{error}</p>
          <button
            onClick={load}
            className="mt-2 flex items-center gap-1 text-[11px] transition-opacity hover:opacity-70"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            <RefreshCw size={11} />
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!data || data.companies.length === 0) {
    return (
      <div
        className="kpi-card flex flex-col items-center justify-center py-20 text-center"
        style={{ border: "1px dashed var(--cometa-card-border)" }}
      >
        <p className="text-[13px]" style={{ color: "var(--cometa-fg-muted)" }}>
          Sin datos de cobertura disponibles.
        </p>
        <p className="mt-1 text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.5 }}>
          Los datos aparecerán aquí cuando las startups suban sus primeros documentos.
        </p>
      </div>
    );
  }

  const yearGroups = groupPeriodsByYear(data.periods);

  // ── Grid ──────────────────────────────────────────────────────────────────
  return (
    <div className="kpi-card space-y-4">

      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p
            className="text-[10px] uppercase tracking-widest"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            Mapa de Salud del Portafolio
          </p>
          <p
            className="mt-0.5 text-[11px]"
            style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}
          >
            {data.companies.length} startups · {data.periods.length} períodos
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-lg p-1.5 transition-opacity hover:opacity-70"
          style={{ color: "var(--cometa-fg-muted)" }}
          title="Refrescar"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Scrollable grid */}
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: "4px" }}>
          <thead>
            {/* Year header */}
            <tr>
              {/* Company column spacer */}
              <th className="w-36" />
              {yearGroups.map(({ year, periods }) => (
                <th
                  key={year}
                  colSpan={periods.length}
                  className="text-center text-[9px] pb-1 uppercase tracking-widest"
                  style={{ color: "var(--cometa-fg-muted)" }}
                >
                  {year}
                </th>
              ))}
            </tr>
            {/* Period header */}
            <tr>
              <th />
              {data.periods.map((p) => (
                <th
                  key={p}
                  className="text-center text-[9px] pb-2"
                  style={{ color: "var(--cometa-fg-muted)", minWidth: 44 }}
                >
                  {periodShort(p)}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {data.companies.map((co, rowIdx) => (
              <motion.tr
                key={co.key}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: rowIdx * 0.04 }}
              >
                {/* Company label */}
                <td className="pr-3 text-right">
                  <button
                    onClick={() => handleCellClick(co.key)}
                    className="max-w-[128px] truncate text-[11px] text-right transition-opacity hover:opacity-70"
                    style={{ color: "var(--cometa-fg)", fontWeight: 400 }}
                    title={co.display}
                  >
                    {co.display}
                  </button>
                </td>

                {/* Data cells */}
                {data.periods.map((period) => {
                  const cell   = cellMap.current.get(`${co.key}||${period}`) ?? null;
                  const status: CellStatus = cell ? cell.status : "nodata";

                  return (
                    <td key={period} className="p-0">
                      <HeatCell
                        status={status}
                        cell={cell}
                        company={co.key}
                        period={period}
                        onClick={() => handleCellClick(co.key)}
                        onEnter={handleCellEnter}
                        onLeave={handleCellLeave}
                      />
                    </td>
                  );
                })}
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div
        className="pt-3"
        style={{ borderTop: "1px solid var(--cometa-card-border)" }}
      >
        <Legend />
      </div>

      {/* Floating tooltip */}
      <AnimatePresence>
        {tooltip && <Tooltip info={tooltip} />}
      </AnimatePresence>
    </div>
  );
}
