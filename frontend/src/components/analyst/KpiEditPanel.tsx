"use client";

/**
 * KpiEditPanel — Panel inline de edición manual de KPIs para analistas.
 *
 * Se abre bajo una fila de Reportes cuando el analista pulsa "Editar".
 * Muestra los KPIs actuales del submission como inputs editables.
 * Al guardar, POST /api/analyst/audit-edit → devuelve audit_hash SHA-256.
 *
 * Flujo:
 *   1. Pre-rellena campos con valores actuales del result.data
 *   2. Analista edita los que necesite
 *   3. "Guardar cambios" → solo envía los campos modificados (dirty)
 *   4. Muestra el Hash de Auditoría del resultado
 */

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy, Shield, AlertTriangle, Loader2 } from "lucide-react";
import { apiPost } from "@/services/api-client";
import { analystEditResponseSchema, type AnalysisResult, type AnalystEditResponse } from "@/lib/schemas";

// ── KPI label map (snake_case → display) ─────────────────────────────────────
const KPI_LABELS: Record<string, string> = {
  mrr:                "MRR (Monthly Recurring Revenue)",
  arr:                "ARR (Annual Recurring Revenue)",
  total_revenue:      "Ingresos Totales",
  revenue_growth:     "Crecimiento de Ingresos (%)",
  gross_margin:       "Margen Bruto (%)",
  ebitda:             "EBITDA",
  ebitda_margin:      "Margen EBITDA (%)",
  net_income:         "Resultado Neto",
  cash_in_bank:       "Efectivo en Caja",
  burn_rate:          "Burn Rate Mensual",
  cac:                "CAC (Costo Adquisición Cliente)",
  ltv:                "LTV (Lifetime Value)",
  churn_rate:         "Tasa de Churn (%)",
  operating_expenses: "Gastos Operativos",
  npl_rate:           "Tasa de Morosidad (NPL %)",
  loan_book:          "Cartera de Crédito",
  gmv:                "GMV (Gross Merchandise Value)",
  take_rate:          "Take Rate (%)",
  claims_ratio:       "Ratio de Siniestralidad (%)",
  premium_volume:     "Volumen de Primas",
};

function kpiLabel(key: string): string {
  return KPI_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// camelCase → snake_case helper
function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

/** Extrae KPIs editables desde el objeto data del result. */
function extractEditableKpis(result: AnalysisResult): Record<string, string> {
  const out: Record<string, string> = {};
  const fm = (result.data as Record<string, unknown>)?.financial_metrics_2025;
  const source = (fm && typeof fm === "object") ? fm as Record<string, unknown> : result.data as Record<string, unknown>;

  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith("_") || k === "submission" || typeof v === "object") continue;
    if (v === null || v === undefined || v === "") continue;
    const snake = toSnake(k);
    if (!(snake in KPI_LABELS)) continue; // solo los KPIs conocidos
    out[snake] = String(v);
  }
  return out;
}

// ── Audit Hash display ────────────────────────────────────────────────────────
function AuditHashCard({ hash, updatedKpis, processedAt }: {
  hash: string;
  updatedKpis: string[];
  processedAt: string;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(hash).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-4 rounded-2xl p-4 space-y-3"
      style={{
        background: "color-mix(in srgb, #22c55e 6%, transparent)",
        border:     "1px solid color-mix(in srgb, #22c55e 18%, transparent)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Shield size={13} style={{ color: "#22c55e" }} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "#22c55e" }}>
          Hash de Auditoría generado
        </p>
      </div>

      {/* Hash row */}
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <p className="flex-1 font-mono text-[10px] break-all leading-relaxed"
           style={{ color: "rgba(255,255,255,0.7)" }}>
          {hash}
        </p>
        <button
          onClick={handleCopy}
          className="shrink-0 rounded p-1.5 transition-all hover:opacity-80"
          style={{
            background: copied ? "rgba(34,197,94,0.14)" : "rgba(255,255,255,0.06)",
            color: copied ? "#22c55e" : "rgba(255,255,255,0.5)",
          }}
          title="Copiar hash"
        >
          <AnimatePresence mode="wait">
            {copied
              ? <motion.span key="c" initial={{ scale: 0 }} animate={{ scale: 1 }}><Check size={12} /></motion.span>
              : <motion.span key="d" initial={{ scale: 0 }} animate={{ scale: 1 }}><Copy size={12} /></motion.span>
            }
          </AnimatePresence>
        </button>
      </div>

      {/* Meta */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px]" style={{ color: "rgba(255,255,255,0.38)" }}>
        <span>{updatedKpis.length} KPI{updatedKpis.length !== 1 ? "s" : ""} actualizado{updatedKpis.length !== 1 ? "s" : ""}</span>
        <span>{processedAt} UTC</span>
      </div>
    </motion.div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface KpiEditPanelProps {
  result:      AnalysisResult;
  onClose:     () => void;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function KpiEditPanel({ result, onClose }: KpiEditPanelProps) {
  const initialValues = useMemo(() => extractEditableKpis(result), [result]);

  const [values,    setValues]    = useState<Record<string, string>>(initialValues);
  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState("");
  const [editResult, setEditResult] = useState<AnalystEditResponse | null>(null);

  // Only the KPIs that changed from initial
  const dirtyUpdates = useMemo(() => {
    const dirty: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if ((v ?? "").trim() !== (initialValues[k] ?? "").trim() && (v ?? "").trim() !== "") {
        dirty[k] = v.trim();
      }
    }
    return dirty;
  }, [values, initialValues]);

  const hasDirty = Object.keys(dirtyUpdates).length > 0;

  async function handleSave() {
    if (!hasDirty || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await apiPost(
        "/api/analyst/audit-edit",
        { submission_id: result.metadata.file_hash, updates: dirtyUpdates },
        analystEditResponseSchema,
      );
      setEditResult(res);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Error al guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  const submissionDisplay = result.metadata.file_hash.slice(0, 12) + "…";

  // All KPIs to show: existing + any in KPI_LABELS not yet present (empty)
  const allKpiKeys = useMemo(() => {
    const known = new Set(Object.keys(KPI_LABELS));
    const fromResult = new Set(Object.keys(initialValues));
    // Show only keys that have a value OR are known KPIs — prioritize result keys
    return [...fromResult, ...Array.from(known).filter((k) => !fromResult.has(k))].slice(0, 20);
  }, [initialValues]);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden"
    >
      <div
        className="mx-0 mt-0 rounded-b-xl px-5 py-5 space-y-5"
        style={{
          background: "color-mix(in srgb, var(--cometa-card-bg) 80%, transparent)",
          border:     "1px solid var(--cometa-card-border)",
          borderTop:  "none",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium" style={{ color: "var(--cometa-fg)" }}>
              Edición manual de KPIs
            </p>
            <p className="text-[10px] mt-0.5 font-mono" style={{ color: "var(--cometa-fg-muted)" }}>
              {submissionDisplay}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[10px] uppercase tracking-widest transition-opacity hover:opacity-70"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            Cerrar
          </button>
        </div>

        {/* KPI inputs — 2 columns on md+ */}
        {!editResult && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {allKpiKeys.map((key) => {
              const current  = initialValues[key] ?? "";
              const isDirty  = (values[key] ?? "").trim() !== current.trim() && (values[key] ?? "").trim() !== "";
              return (
                <div key={key}>
                  <label
                    htmlFor={`edit-${key}`}
                    className="mb-1 block text-[9px] uppercase tracking-[0.14em]"
                    style={{ color: isDirty ? "var(--cometa-accent)" : "var(--cometa-fg-muted)" }}
                  >
                    {kpiLabel(key)}
                    {isDirty && <span className="ml-1 normal-case tracking-normal opacity-70">· editado</span>}
                  </label>
                  <input
                    id={`edit-${key}`}
                    type="text"
                    value={values[key] ?? ""}
                    placeholder={current || "—"}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-[12px] font-light outline-none transition-all"
                    style={{
                      background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
                      border: isDirty
                        ? "1px solid color-mix(in srgb, var(--cometa-accent) 50%, transparent)"
                        : "1px solid var(--cometa-card-border)",
                      color: "var(--cometa-fg)",
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Audit result */}
        {editResult && (
          <AuditHashCard
            hash={editResult.audit_hash}
            updatedKpis={editResult.updated_kpis}
            processedAt={editResult.processed_at}
          />
        )}

        {/* Failed KPIs warning */}
        {editResult && editResult.failed_kpis.length > 0 && (
          <div
            className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[11px]"
            style={{
              background: "color-mix(in srgb, #f59e0b 8%, transparent)",
              border:     "1px solid color-mix(in srgb, #f59e0b 18%, transparent)",
              color:      "#fbbf24",
            }}
          >
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              {editResult.failed_kpis.length} KPI(s) no encontrado(s) en BigQuery:{" "}
              {editResult.failed_kpis.map((f) => f.kpi_key).join(", ")}
            </span>
          </div>
        )}

        {/* Save error */}
        {saveError && (
          <p className="text-[11px]" style={{ color: "#f87171" }}>
            {saveError}
          </p>
        )}

        {/* Actions */}
        {!editResult && (
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={!hasDirty || saving}
              className="flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: "var(--cometa-accent)",
                color:      "var(--cometa-accent-fg)",
              }}
            >
              {saving
                ? <><Loader2 size={12} className="animate-spin shrink-0" /> Guardando…</>
                : <><Shield size={12} className="shrink-0" /> Guardar y generar hash</>
              }
            </button>
            <span className="text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
              {hasDirty
                ? `${Object.keys(dirtyUpdates).length} campo${Object.keys(dirtyUpdates).length !== 1 ? "s" : ""} modificado${Object.keys(dirtyUpdates).length !== 1 ? "s" : ""}`
                : "Sin cambios"}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
