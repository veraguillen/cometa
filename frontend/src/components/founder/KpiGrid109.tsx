"use client";

/**
 * KpiGrid109 — Full-width 109-KPI grid · Cyber-Finance design system.
 *
 * Layout: full-width accordions, uppercase tracking-widest titles,
 * generous cell padding, transparent inputs that glow on focus.
 *
 * Groups:
 *   💰 CORE FINANCIALS   — Revenue, EBITDA, Cash, P&L
 *   📈 GROWTH & SAAS     — MRR, Churn, CAC, LTV, GMV
 *   👥 TALENT & OPS      — Headcount, Burn Rate, OpEx
 *   🛡️ EFFICIENCY        — Runway, Magic Number, Ratios
 *   📊 ADDITIONAL INSIGHTS — any KPI not mapped to the above 4 groups
 *
 * Cell states:
 *   FOUND        → emerald neon border
 *   MANUAL_FOUND → cyan border + "M" badge
 *   MISSING      → amber border
 *   MISSING + INNEGOCIABLE → red pulse glow (framer-motion)
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence, type Transition } from "framer-motion";
import { CheckCircle2, AlertCircle, Edit3, ChevronDown, PenLine } from "lucide-react";
import type { KpiGridRow } from "@/lib/schemas";

// ── Category grouping ─────────────────────────────────────────────────────────

type CatGroup = "core" | "growth" | "talent" | "efficiency" | "additional";

const CAT_GROUP_MAP: Record<string, CatGroup> = {
  income_statement:       "core",
  revenue:                "core",
  cash_flow:              "core",
  cash_flow_indicators:   "core",
  balance_sheet:          "core",
  profitability:          "core",
  cost_structure:         "core",
  debt_ratios:            "core",
  financial:              "core",

  saas_metrics:           "growth",
  growth_metrics:         "growth",
  unit_economics:         "growth",
  acquisition:            "growth",
  gmv_metrics:            "growth",
  marketplace_metrics:    "growth",
  retention:              "growth",
  growth:                 "growth",

  hr_metrics:             "talent",
  headcount:              "talent",
  operations:             "talent",
  burn_metrics:           "talent",
  operational:            "talent",

  efficiency_metrics:     "efficiency",
  runway:                 "efficiency",
  ratios:                 "efficiency",
  insurance_metrics:      "efficiency",
  fintech_metrics:        "efficiency",
  efficiency:             "efficiency",
};

/** Returns "additional" for any category not in the map — no KPI is dropped. */
function getGroup(category: string | null | undefined): CatGroup {
  if (!category) return "additional";
  const norm = category.toLowerCase().replace(/[\s-]+/g, "_");
  return CAT_GROUP_MAP[norm] ?? "additional";
}

const GROUP_DEFS = [
  {
    key:   "core"       as CatGroup,
    icon:  "💰",
    label: "CORE FINANCIALS",
    desc:  "Revenue · EBITDA · Cash",
    neon:  "#4ade80",
    dim:   "rgba(74,222,128,0.10)",
  },
  {
    key:   "growth"     as CatGroup,
    icon:  "📈",
    label: "GROWTH & SAAS",
    desc:  "MRR · Churn · CAC",
    neon:  "#60a5fa",
    dim:   "rgba(96,165,250,0.10)",
  },
  {
    key:   "talent"     as CatGroup,
    icon:  "👥",
    label: "TALENT & OPS",
    desc:  "Headcount · Burn Rate",
    neon:  "#a78bfa",
    dim:   "rgba(167,139,250,0.10)",
  },
  {
    key:   "efficiency" as CatGroup,
    icon:  "🛡️",
    label: "EFFICIENCY",
    desc:  "Runway · Magic Number",
    neon:  "#fbbf24",
    dim:   "rgba(251,191,36,0.10)",
  },
  {
    key:   "additional" as CatGroup,
    icon:  "📊",
    label: "ADDITIONAL INSIGHTS",
    desc:  "Métricas adicionales detectadas",
    neon:  "#e2e8f0",
    dim:   "rgba(226,232,240,0.07)",
  },
] as const;

// ── Formatters ────────────────────────────────────────────────────────────────

function formatVal(value: number | null, unit?: string | null): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (unit === "%" || unit?.toLowerCase().includes("pct") || unit?.toLowerCase().includes("percent")) {
    return `${n.toLocaleString("es-MX", { maximumFractionDigits: 2 })}%`;
  }
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("es-MX", { maximumFractionDigits: 2 });
}

// ── Animations ────────────────────────────────────────────────────────────────

const pulseRed = {
  boxShadow: [
    "0 0 0px rgba(239,68,68,0)",
    "0 0 14px rgba(239,68,68,0.6)",
    "0 0 0px rgba(239,68,68,0)",
  ],
};
const pulseTransition: Transition = { repeat: Infinity, duration: 1.8, ease: "easeInOut" };

// ── Props ─────────────────────────────────────────────────────────────────────

interface KpiGrid109Props {
  grid:          KpiGridRow[];
  onGridChange:  (updated: KpiGridRow[]) => void;
  focusedKpiId?: string | null;
}

// ── KPI row cell ──────────────────────────────────────────────────────────────

function KpiCell({
  row,
  isEditing,
  inputValue,
  onStartEdit,
  onInputChange,
  onCommit,
  onCancel,
}: {
  row:           KpiGridRow;
  isEditing:     boolean;
  inputValue:    string;
  onStartEdit:   () => void;
  onInputChange: (v: string) => void;
  onCommit:      () => void;
  onCancel:      () => void;
}) {
  const isMissing      = row.status === "MISSING";
  const isManualFound  = row.status === "MANUAL_FOUND";
  const isFound        = row.status === "FOUND";
  const isInnegociable = row.innegociable;

  const borderColor =
    isFound        ? "rgba(74,222,128,0.30)"  :
    isManualFound  ? "rgba(34,211,238,0.32)"  :   // cyan for manual
    isInnegociable ? "rgba(239,68,68,0.35)"   :
                     "rgba(251,191,36,0.22)";

  const bgColor =
    isFound        ? "rgba(74,222,128,0.04)"  :
    isManualFound  ? "rgba(34,211,238,0.05)"  :
    isInnegociable ? "rgba(239,68,68,0.06)"   :
                     "rgba(251,191,36,0.04)";

  return (
    <div data-kpi-id={row.kpi_id}>
      <motion.div
        className="flex items-center gap-3 rounded-xl px-4 py-2.5 cursor-pointer transition-colors"
        style={{
          background: bgColor,
          border:     `1px solid ${borderColor}`,
        }}
        animate={isInnegociable && isMissing ? pulseRed : {}}
        transition={isInnegociable && isMissing ? pulseTransition : {}}
        onClick={() => { if (isMissing && !isEditing) onStartEdit(); }}
        whileHover={isMissing ? { opacity: 0.85 } : {}}
      >
        {/* Status icon */}
        {isFound ? (
          <CheckCircle2 size={12} className="shrink-0" style={{ color: "#4ade80" }} />
        ) : isManualFound ? (
          <PenLine size={12} className="shrink-0" style={{ color: "#22d3ee" }} />
        ) : (
          <AlertCircle
            size={12}
            className="shrink-0"
            style={{ color: isInnegociable ? "#f87171" : "#fbbf24" }}
          />
        )}

        {/* Name — Inter, not monospace */}
        <span
          className="flex-1 text-[12px] font-light truncate"
          style={{ color: "#cbd5e1", fontFamily: "var(--font-sans, Inter, system-ui, sans-serif)" }}
          title={row.display_name ?? row.kpi_id}
        >
          {row.display_name ?? row.kpi_id}
          {isInnegociable && isMissing && (
            <span
              className="ml-2 text-[8px] font-semibold uppercase tracking-wider"
              style={{ color: "#f87171", fontFamily: "inherit" }}
            >
              ● obligatorio
            </span>
          )}
        </span>

        {/* Value or edit hint */}
        {isFound || isManualFound ? (
          <div className="flex items-center gap-2 shrink-0">
            <span
              className="text-[12px] tabular-nums"
              style={{
                fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
                color: isManualFound ? "#22d3ee" : "#4ade80",
              }}
            >
              {formatVal(row.value, row.unit)}
            </span>
            {isManualFound && (
              <span
                className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide"
                style={{
                  background: "rgba(34,211,238,0.12)",
                  color:      "#22d3ee",
                  border:     "1px solid rgba(34,211,238,0.28)",
                }}
              >
                M
              </span>
            )}
          </div>
        ) : (
          <span className="shrink-0 flex items-center gap-1.5">
            <Edit3
              size={10}
              style={{ color: isInnegociable ? "#f87171" : "#fbbf24", opacity: 0.7 }}
            />
            <span
              className="text-[10px]"
              style={{ color: isInnegociable ? "#f87171" : "#fbbf24", opacity: 0.7 }}
            >
              Ingresar
            </span>
          </span>
        )}
      </motion.div>

      {/* Inline edit input */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            key="input"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex gap-2 mt-2 px-1">
              <input
                autoFocus
                type="text"
                inputMode="decimal"
                placeholder={`Valor de ${row.display_name ?? row.kpi_id}…`}
                value={inputValue}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommit();
                  if (e.key === "Escape") onCancel();
                }}
                className={`
                  flex-1 rounded-xl px-4 py-2.5 text-[12px] font-light outline-none
                  transition-all duration-200
                  bg-transparent border
                `}
                style={{
                  borderColor: "rgba(34,211,238,0.15)",
                  color:       "#e2e8f0",
                  // Glow only on focus via inline trick (no Tailwind ring needed)
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "rgba(34,211,238,0.55)";
                  e.currentTarget.style.boxShadow   = "0 0 0 2px rgba(34,211,238,0.12)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "rgba(34,211,238,0.15)";
                  e.currentTarget.style.boxShadow   = "none";
                }}
              />
              <button
                onClick={onCommit}
                disabled={!inputValue.trim()}
                className="rounded-xl px-4 py-2 text-[11px] font-semibold transition-all disabled:opacity-30 hover:brightness-110 active:scale-95"
                style={{ background: "#22d3ee", color: "#020a1a" }}
              >
                OK
              </button>
              <button
                onClick={onCancel}
                className="rounded-xl px-3 py-2 text-[11px] transition-all hover:opacity-60"
                style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8" }}
              >
                ✕
              </button>
            </div>
            <p className="mt-1.5 px-2 text-[9px]" style={{ color: "#475569" }}>
              Enter para confirmar · Esc para cancelar
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Accordion group ───────────────────────────────────────────────────────────

function AccordionGroup({
  def,
  rows,
  editingId,
  inputValues,
  onStartEdit,
  onInputChange,
  onCommit,
  onCancel,
}: {
  def:           typeof GROUP_DEFS[number];
  rows:          KpiGridRow[];
  editingId:     string | null;
  inputValues:   Record<string, string>;
  onStartEdit:   (id: string) => void;
  onInputChange: (id: string, v: string) => void;
  onCommit:      (id: string) => void;
  onCancel:      () => void;
}) {
  const [open, setOpen] = useState(true);

  const found   = rows.filter((r) => r.status === "FOUND" || r.status === "MANUAL_FOUND").length;
  const missing = rows.length - found;
  const pct     = rows.length > 0 ? Math.round((found / rows.length) * 100) : 0;

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        border:     `1px solid ${def.dim.replace(/[\d.]+\)$/, "0.22)")}`,
        background: "rgba(15,23,42,0.6)",
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-all"
        style={{ background: open ? def.dim : "transparent" }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[20px] leading-none">{def.icon}</span>
        <div className="flex-1 min-w-0">
          <p
            className="text-[11px] font-semibold uppercase tracking-widest"
            style={{ color: def.neon, letterSpacing: "0.18em" }}
          >
            {def.label}
          </p>
          <p className="text-[9px] mt-0.5" style={{ color: "#64748b" }}>
            {def.desc}
          </p>
        </div>

        {/* Stats pill */}
        <div className="flex items-center gap-3 shrink-0">
          <div
            className="rounded-full px-2.5 py-0.5 text-[10px] tabular-nums"
            style={{
              fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
              background: missing === 0 ? def.dim : "rgba(255,255,255,0.04)",
              color:      missing === 0 ? def.neon : "#64748b",
              border:     `1px solid ${missing === 0 ? def.neon + "44" : "rgba(255,255,255,0.07)"}`,
            }}
          >
            {found}/{rows.length}
          </div>
          <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronDown size={14} style={{ color: "#475569" }} />
          </motion.div>
        </div>
      </button>

      {/* Content */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            {/* Mini progress bar */}
            <div className="px-5 pb-1">
              <div
                className="h-[2px] w-full rounded-full overflow-hidden"
                style={{ background: "rgba(255,255,255,0.05)" }}
              >
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    background: missing === 0 ? def.neon : `linear-gradient(90deg, ${def.neon}77, ${def.neon})`,
                    boxShadow:  pct > 60 ? `0 0 6px ${def.neon}55` : "none",
                  }}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
              </div>
            </div>

            {/* KPI rows */}
            <div className="px-4 pb-4 pt-1 space-y-1.5">
              {rows.map((row) => (
                <KpiCell
                  key={row.kpi_id}
                  row={row}
                  isEditing={editingId === row.kpi_id}
                  inputValue={inputValues[row.kpi_id] ?? ""}
                  onStartEdit={() => onStartEdit(row.kpi_id)}
                  onInputChange={(v) => onInputChange(row.kpi_id, v)}
                  onCommit={() => onCommit(row.kpi_id)}
                  onCancel={onCancel}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function KpiGrid109({ grid, onGridChange, focusedKpiId }: KpiGrid109Props) {
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  const found   = grid.filter((r) => r.status === "FOUND" || r.status === "MANUAL_FOUND").length;
  const missing = grid.length - found;
  const pct     = grid.length > 0 ? Math.round((found / grid.length) * 100) : 0;

  // Open focus-requested row when Copilot triggers it
  const prevFocusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedKpiId || focusedKpiId === prevFocusedRef.current) return;
    prevFocusedRef.current = focusedKpiId;
    const row = grid.find((r) => r.kpi_id === focusedKpiId);
    if (row?.status === "MISSING") setEditingId(focusedKpiId);
  }, [focusedKpiId, grid]);

  // Group by accordion category — "additional" catches everything unmapped
  const grouped = useMemo(() => {
    const map = new Map<CatGroup, KpiGridRow[]>([
      ["core", []], ["growth", []], ["talent", []], ["efficiency", []], ["additional", []],
    ]);
    for (const row of grid) {
      const g = getGroup(row.category);
      map.get(g)!.push(row);
    }
    return map;
  }, [grid]);

  const handleStartEdit  = useCallback((kpiId: string) => setEditingId(kpiId), []);
  const handleInputChange = useCallback((kpiId: string, v: string) => {
    setInputValues((prev) => ({ ...prev, [kpiId]: v }));
  }, []);

  const handleCommit = useCallback((kpiId: string) => {
    const rawVal = inputValues[kpiId]?.trim();
    if (!rawVal) return;
    const num = parseFloat(rawVal.replace(/,/g, "."));
    if (isNaN(num)) return;
    const updated = grid.map((r) =>
      r.kpi_id === kpiId ? { ...r, status: "MANUAL_FOUND" as const, value: num } : r,
    );
    onGridChange(updated);
    setEditingId(null);
  }, [inputValues, grid, onGridChange]);

  const handleCancel = useCallback(() => setEditingId(null), []);

  const barColor = missing === 0 ? "#4ade80" : pct >= 60 ? "#60a5fa" : pct >= 30 ? "#fbbf24" : "#f87171";
  const glowAlpha = Math.round((pct / 100) * 0.8 * 255).toString(16).padStart(2, "0");
  const barGlow   = `0 0 10px ${barColor}${glowAlpha}`;

  return (
    <div className="w-full space-y-3" data-kpi-grid>
      {/* ── Progress banner ── */}
      <div
        className="rounded-2xl px-5 py-4"
        style={{
          background: missing === 0
            ? "rgba(74,222,128,0.06)"
            : "rgba(15,23,42,0.7)",
          border: missing === 0
            ? "1px solid rgba(74,222,128,0.22)"
            : "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-end justify-between mb-3">
          <div>
            <p
              className="text-[9px] font-semibold uppercase tracking-[0.24em] mb-0.5"
              style={{ color: "#475569" }}
            >
              ADN Financiero
            </p>
            <p className="text-[14px] font-light" style={{ color: "#e2e8f0" }}>
              <span className="font-semibold">{found}</span>
              <span style={{ color: "#64748b" }}> / {grid.length} KPIs mapeados</span>
              {missing > 0 && (
                <span className="ml-2 text-[11px]" style={{ color: "#f59e0b" }}>
                  · {missing} faltante{missing !== 1 ? "s" : ""}
                </span>
              )}
            </p>
          </div>
          <div
            className="text-[32px] font-light tabular-nums leading-none"
            style={{
              fontFamily:          "var(--font-mono, 'JetBrains Mono', monospace)",
              color:               barColor,
              textShadow:          pct > 40 ? `0 0 20px ${barColor}88` : "none",
              fontVariantNumeric:  "tabular-nums",
            }}
          >
            {pct}%
          </div>
        </div>

        {/* Neon bar */}
        <div
          className="h-[3px] w-full rounded-full overflow-hidden"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          <motion.div
            className="h-full rounded-full"
            style={{
              background: `linear-gradient(90deg, ${barColor}aa, ${barColor})`,
              boxShadow:  barGlow,
            }}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>
      </div>

      {/* ── Accordions ── */}
      <motion.div className="space-y-2" layout transition={{ duration: 0.3, ease: "easeInOut" }}>
        {GROUP_DEFS.map((def) => {
          const rows = grouped.get(def.key) ?? [];
          if (rows.length === 0) return null;
          return (
            <AccordionGroup
              key={def.key}
              def={def}
              rows={rows}
              editingId={editingId}
              inputValues={inputValues}
              onStartEdit={handleStartEdit}
              onInputChange={handleInputChange}
              onCommit={handleCommit}
              onCancel={handleCancel}
            />
          );
        })}
      </motion.div>
    </div>
  );
}
