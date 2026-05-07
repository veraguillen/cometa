"use client";

/**
 * MissingDataPanel — shown after upload when:
 *   (a) checklist_status.is_complete === false  (missing KPIs), or
 *   (b) the backend returns 400 with sanity violations.
 *
 * Two sections:
 *   1. Missing fields   — amber border, required text input.
 *   2. Sanity violations — red border, extracted value shown, required
 *      justification textarea.
 *
 * "Completar y Enviar" is disabled until every missing field is filled
 * AND every sanity violation has a written justification.
 *
 * onComplete receives a flat Record<string, string> where:
 *   - Normal values are keyed by kpi_key.
 *   - Justifications are keyed by `${kpi_key}_note`.
 */

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, AlertCircle } from "lucide-react";
import type { ChecklistStatus, SanityViolation } from "@/lib/schemas";

const KPI_LABELS: Record<string, string> = {
  mrr:                "MRR (Monthly Recurring Revenue)",
  arr:                "ARR (Annual Recurring Revenue)",
  churn_rate:         "Tasa de Churn (%)",
  revenue_growth:     "Crecimiento de Ingresos (%)",
  gross_margin:       "Margen Bruto (%)",
  gross_profit_margin:"Gross Profit Margin (%)",
  ebitda:             "EBITDA",
  ebitda_margin:      "Margen EBITDA (%)",
  net_income:         "Resultado Neto",
  cash_in_bank:       "Efectivo en Caja",
  cash_in_bank_end_of_year: "Efectivo en Caja (fin de año)",
  burn_rate:          "Burn Rate Mensual",
  cac:                "CAC (Costo Adquisición Cliente)",
  ltv:                "LTV (Lifetime Value)",
  revenue:            "Ingresos Totales",
  total_revenue:      "Ingresos Totales",
  operating_expenses: "Gastos Operativos",
  npl_ratio:          "Tasa de Morosidad (NPL %)",
  portfolio_size:     "Cartera de Crédito",
  gmv:                "GMV (Gross Merchandise Value)",
  take_rate:          "Take Rate (%)",
  loss_ratio:         "Ratio de Siniestralidad (%)",
  premium_volume:     "Volumen de Primas",
};

function kpiLabel(key: string): string {
  return (
    KPI_LABELS[key] ??
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function formatValue(value: number, unit: string): string {
  if (unit === "%") return `${value.toLocaleString("es-MX", { maximumFractionDigits: 2 })}%`;
  return `$${value.toLocaleString("es-MX", { maximumFractionDigits: 2 })}`;
}

interface MissingDataPanelProps {
  checklist:        ChecklistStatus;
  fileHash?:        string;
  sanityViolations?: SanityViolation[];
  onComplete:       (values: Record<string, string>) => void;
}

export default function MissingDataPanel({
  checklist,
  sanityViolations = [],
  onComplete,
}: MissingDataPanelProps) {
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(checklist.missing_critical_kpis.map((k) => [k, ""])),
  );
  const [justifications, setJustifications] = useState<Record<string, string>>(
    () => Object.fromEntries(sanityViolations.map((v) => [v.kpi_key, ""])),
  );

  const allFieldsFilled = useMemo(
    () => checklist.missing_critical_kpis.every((k) => values[k]?.trim() !== ""),
    [values, checklist.missing_critical_kpis],
  );

  const allJustificationsFilled = useMemo(
    () => sanityViolations.every((v) => justifications[v.kpi_key]?.trim() !== ""),
    [justifications, sanityViolations],
  );

  const allReady = allFieldsFilled && allJustificationsFilled;

  const bucketLabel: Record<string, string> = {
    SAAS:  "SaaS",
    LEND:  "Lending / Fintech",
    ECOM:  "E-commerce",
    INSUR: "Insurtech",
    OTH:   "General",
  };

  function handleSubmit() {
    if (!allReady) return;
    // Merge: KPI values + justification notes (keyed with _note suffix)
    const payload: Record<string, string> = { ...values };
    for (const [key, note] of Object.entries(justifications)) {
      if (note.trim()) payload[`${key}_note`] = note.trim();
    }
    onComplete(payload);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-md space-y-5"
    >
      {/* ── Header pill ── */}
      <div
        className="flex items-start gap-3 rounded-2xl px-4 py-3"
        style={{
          background: "color-mix(in srgb, #f59e0b 8%, transparent)",
          border:     "1px solid color-mix(in srgb, #f59e0b 18%, transparent)",
        }}
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium" style={{ color: "#f59e0b" }}>
            Sector: {bucketLabel[checklist.bucket] ?? checklist.bucket}
          </p>
          <p className="mt-0.5 text-[11px] font-light leading-relaxed"
             style={{ color: "var(--cometa-fg-muted)" }}>
            {checklist.display_message}
          </p>
        </div>
      </div>

      {/* ── Present KPIs recap ── */}
      {checklist.present_kpis.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {checklist.present_kpis.map((k) => (
            <span
              key={k}
              className="rounded-full px-2.5 py-0.5 text-[9px] uppercase tracking-wider"
              style={{
                background: "rgba(74,222,128,0.09)",
                color:      "#4ade80",
              }}
            >
              ✓ {k.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      {/* ── Section 1: Missing mandatory fields ── */}
      {checklist.missing_critical_kpis.length > 0 && (
        <div>
          <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.2em]"
             style={{ color: "var(--cometa-fg-muted)" }}>
            Campos requeridos faltantes
          </p>
          <div className="space-y-3">
            {checklist.missing_critical_kpis.map((key) => {
              const filled    = values[key]?.trim() !== "";
              const rawScore  = checklist.confidence_scores?.[key];
              const isLowConf = rawScore === undefined || rawScore < 90;

              return (
                <div key={key}>
                  <label
                    htmlFor={`kpi-${key}`}
                    className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em]"
                    style={isLowConf ? { color: "#fbbf24" } : { color: "var(--cometa-fg-muted)" }}
                  >
                    {kpiLabel(key)}
                    {isLowConf && rawScore !== undefined && (
                      <span className="ml-1 text-[9px] normal-case tracking-normal opacity-70">
                        ({rawScore}% confianza)
                      </span>
                    )}
                  </label>
                  <input
                    id={`kpi-${key}`}
                    type="text"
                    value={values[key]}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder="Introduce el valor…"
                    className="w-full rounded-xl px-4 py-2.5 text-[13px] font-light outline-none transition-all"
                    style={{
                      background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                      border: filled
                        ? "1px solid color-mix(in srgb, var(--cometa-accent) 45%, transparent)"
                        : isLowConf
                          ? "1px solid #fbbf24"
                          : "1px solid var(--cometa-card-border)",
                      color: "var(--cometa-fg)",
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Section 2: Sanity violations — require justification ── */}
      {sanityViolations.length > 0 && (
        <div>
          {/* Divider */}
          <div
            className="mb-4 h-px w-full"
            style={{ background: "color-mix(in srgb, #ef4444 20%, transparent)" }}
          />
          <div
            className="mb-4 flex items-start gap-3 rounded-2xl px-4 py-3"
            style={{
              background: "color-mix(in srgb, #ef4444 6%, transparent)",
              border:     "1px solid color-mix(in srgb, #ef4444 18%, transparent)",
            }}
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
            <div>
              <p className="text-[11px] font-medium" style={{ color: "#f87171" }}>
                Valores fuera de rango detectados
              </p>
              <p className="mt-0.5 text-[11px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                Estos valores requieren una justificación escrita para continuar.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {sanityViolations.map((v) => {
              const filled = justifications[v.kpi_key]?.trim() !== "";
              return (
                <div key={v.kpi_key}>
                  {/* KPI name + extracted value */}
                  <div className="mb-1 flex items-center justify-between">
                    <label
                      htmlFor={`justification-${v.kpi_key}`}
                      className="text-[10px] font-medium uppercase tracking-[0.12em]"
                      style={{ color: "#f87171" }}
                    >
                      {v.label}
                    </label>
                    <span
                      className="rounded-md px-2 py-0.5 font-mono text-[10px]"
                      style={{
                        background: "color-mix(in srgb, #ef4444 12%, transparent)",
                        color:      "#f87171",
                      }}
                    >
                      {formatValue(v.value, v.label.includes("%") || v.label.toLowerCase().includes("rate") || v.label.toLowerCase().includes("margin") || v.label.toLowerCase().includes("ratio") ? "%" : "$")}
                    </span>
                  </div>
                  {/* Rule that was violated */}
                  <p className="mb-2 text-[10px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.7 }}>
                    Regla: {v.rule_description}
                  </p>
                  {/* Justification textarea */}
                  <textarea
                    id={`justification-${v.kpi_key}`}
                    value={justifications[v.kpi_key]}
                    onChange={(e) =>
                      setJustifications((prev) => ({
                        ...prev,
                        [v.kpi_key]: e.target.value,
                      }))
                    }
                    placeholder="Explica por qué este valor es correcto a pesar de estar fuera del rango esperado…"
                    rows={3}
                    className="w-full resize-none rounded-xl px-4 py-2.5 text-[12px] font-light outline-none transition-all"
                    style={{
                      background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                      border: filled
                        ? "1px solid color-mix(in srgb, #ef4444 50%, transparent)"
                        : "1px solid #ef4444",
                      color: "var(--cometa-fg)",
                    }}
                  />
                  {!filled && (
                    <p className="mt-1 text-[10px]" style={{ color: "#f87171" }}>
                      Justificación obligatoria
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Submit ── */}
      <button
        disabled={!allReady}
        onClick={handleSubmit}
        className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-[13px] font-medium tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-30"
        style={{
          background: allReady
            ? "var(--cometa-accent)"
            : "color-mix(in srgb, var(--cometa-accent) 15%, transparent)",
          color: allReady ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
        }}
      >
        Completar y Enviar
        <ArrowRight size={14} />
      </button>
    </motion.div>
  );
}
