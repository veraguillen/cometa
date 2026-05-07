"use client";

/**
 * KPICard — individual KPI tile in the BentoGrid.
 *
 *   - Source badge (IA / Manual / Editado) top-right — 9px uppercase pill
 *   - label: 10px uppercase tracking-widest muted (pr-12 avoids badge overlap)
 *   - value: text-xl font-extralight foreground
 *   - Double-click on value → inline input → PUT /api/kpi-update → purple "Editado" badge
 *   - change row: TrendingUp/Down/Minus icon + percentage
 *   - Last Update timestamp bottom-right — 9px muted (weight 400)
 */

import { useState, useRef, useEffect } from "react";
import { TrendingUp, TrendingDown, Minus, Check, X } from "lucide-react";
import { apiPut } from "@/services/api-client";
import { kpiUpdateResponseSchema } from "@/lib/schemas";

export interface KPICardProps {
  label:        string;
  value:        string;
  unit?:        string;
  change?:      number | null;
  source?:      "ia" | "manual";
  lastUpdate?:  string;    // ISO timestamp from metadata.processed_at
  metricId?:    string;    // snake_case KPI key for PUT /api/kpi-update
  submissionId?: string;   // file_hash / submission_id for BigQuery row
  /** Ghost = core KPI with no historical data. Card is shown but visually subdued. */
  ghost?:       boolean;
}

export default function KPICard({
  label,
  value,
  unit,
  change      = null,
  source      = "ia",
  lastUpdate,
  metricId,
  submissionId,
  ghost       = false,
}: KPICardProps) {
  const dir = change == null ? "neutral" : change > 0 ? "up" : change < 0 ? "down" : "neutral";

  const [editing,    setEditing]    = useState(false);
  const [editValue,  setEditValue]  = useState(value);
  const [localValue, setLocalValue] = useState(value);
  const [localSource, setLocalSource] = useState<"ia" | "manual" | "edited">(source);
  const [saving,     setSaving]     = useState(false);
  const [saveError,  setSaveError]  = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  // Ghost cards are read-only placeholders — editing would be meaningless
  const canEdit  = !ghost && !!(metricId && submissionId);

  // Keep localValue in sync when parent value changes (e.g., after refresh)
  useEffect(() => {
    if (!editing) {
      setLocalValue(value);
      setEditValue(value);
    }
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const formattedDate = lastUpdate
    ? (() => {
        try {
          return new Date(lastUpdate).toLocaleDateString("es-ES", {
            day: "numeric", month: "short", year: "numeric",
          });
        } catch { return null; }
      })()
    : null;

  async function handleSave() {
    const trimmed = editValue.trim();
    if (!trimmed || !canEdit) { setEditing(false); return; }

    setSaving(true);
    setSaveError("");
    try {
      await apiPut(
        "/api/kpi-update",
        { submission_id: submissionId, metric_id: metricId, value: trimmed },
        kpiUpdateResponseSchema,
      );
      setLocalValue(trimmed);
      setLocalSource("edited");
      setEditing(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al guardar";
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEditValue(localValue);
    setEditing(false);
    setSaveError("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")  { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") handleCancel();
  }

  // Badge color per source
  const badgeStyle =
    localSource === "edited" ? {
      background: "color-mix(in srgb, #a855f7 12%, transparent)",
      color:      "#c084fc",
      border:     "1px solid color-mix(in srgb, #a855f7 22%, transparent)",
    } : localSource === "manual" ? {
      background: "color-mix(in srgb, var(--cometa-accent) 12%, transparent)",
      color:      "var(--cometa-accent)",
      border:     "1px solid color-mix(in srgb, var(--cometa-accent) 22%, transparent)",
    } : {
      background: "color-mix(in srgb, var(--cometa-accent) 10%, transparent)",
      color:      "var(--cometa-accent)",
      border:     "1px solid color-mix(in srgb, var(--cometa-accent) 18%, transparent)",
    };

  const badgeLabel =
    localSource === "edited" ? "Editado" :
    localSource === "manual" ? "Manual"  : "IA";

  return (
    <div
      className="kpi-card group relative"
      style={ghost ? { opacity: 0.38, pointerEvents: "none" } : undefined}
      title={canEdit && !editing ? "Doble clic en el valor para editar" : undefined}
    >
      {/* ── Source badge — top-right ── */}
      {ghost ? (
        <span
          className="absolute top-3 right-3 text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-full select-none"
          style={{
            background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
            color:      "var(--cometa-fg-muted)",
            border:     "1px solid color-mix(in srgb, var(--cometa-fg) 10%, transparent)",
          }}
        >
          Sin dato
        </span>
      ) : (
        <span
          className="absolute top-3 right-3 text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-full select-none"
          style={badgeStyle}
        >
          {badgeLabel}
        </span>
      )}

      {/* ── Label ── */}
      <div
        className="text-[10px] uppercase tracking-widest mb-2 pr-12"
        style={{ color: "var(--cometa-fg-muted)" }}
      >
        {label}
      </div>

      {/* ── Ghost state: no data placeholder ── */}
      {ghost && (
        <p
          className="text-[11px] font-light mb-1 leading-snug"
          style={{ color: "var(--cometa-fg-muted)", fontStyle: "italic" }}
        >
          Dato no disponible en histórico
        </p>
      )}

      {/* ── Value / Inline editor ── */}
      {!ghost && editing ? (
        <div className="flex items-center gap-1.5 mb-1">
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => { if (!saving) handleSave(); }}
            disabled={saving}
            className="w-full rounded-md px-2 py-1 text-base outline-none"
            style={{
              background:  "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
              border:      "1px solid color-mix(in srgb, #a855f7 40%, transparent)",
              color:       "var(--cometa-fg)",
              fontWeight:  200,
              fontFamily:  "var(--font-sans)",
              fontSize:    "1.1rem",
            }}
          />
          <button
            onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
            disabled={saving}
            className="shrink-0 rounded p-1 transition-opacity hover:opacity-70 disabled:opacity-30"
            style={{ color: "#c084fc" }}
            title="Guardar (Enter)"
          >
            <Check size={13} />
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
            className="shrink-0 rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: "var(--cometa-fg-muted)" }}
            title="Cancelar (Esc)"
          >
            <X size={13} />
          </button>
        </div>
      ) : !ghost ? (
        <div
          className={`text-xl font-extralight mb-1 ${canEdit ? "cursor-text select-none" : ""}`}
          style={{ color: "var(--cometa-fg)" }}
          onDoubleClick={() => canEdit && setEditing(true)}
        >
          {localValue}
          {unit && (
            <span className="text-xs ml-1" style={{ color: "var(--cometa-fg-muted)" }}>
              {unit}
            </span>
          )}
        </div>
      ) : null}

      {/* ── Save error ── */}
      {saveError && (
        <p className="text-[9px] mb-1" style={{ color: "#f87171" }}>
          {saveError}
        </p>
      )}

      {/* ── Trend row — hidden on ghost cards ── */}
      {!ghost && (
        <div
          className={`flex items-center gap-1 text-xs ${
            dir === "up"   ? "text-kpi-positive" :
            dir === "down" ? "text-kpi-negative"  : "text-kpi-neutral"
          }`}
        >
          {dir === "up"   ? <TrendingUp   className="w-3 h-3" /> :
           dir === "down" ? <TrendingDown  className="w-3 h-3" /> :
                            <Minus         className="w-3 h-3" />}
          {change != null && change !== 0 ? `${Math.abs(change).toFixed(1)}%` : "—"}
        </div>
      )}

      {/* ── Last update — bottom-right, 9px, weight 400 ── */}
      {formattedDate && !editing && (
        <p
          className="absolute bottom-2.5 right-3 text-[9px] leading-none"
          style={{ color: "var(--cometa-fg-muted)", opacity: 0.45, fontWeight: 400 }}
        >
          {formattedDate}
        </p>
      )}
    </div>
  );
}

// ── Entry animation variant (used by BentoGrid wrapper) ────────────────────
export const kpiCardVariant = {
  hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
  show:   { opacity: 1, y: 0,  filter: "blur(0px)", transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const } },
};
