"use client";

/**
 * UploadFlow — Founder document upload with sector validation.
 *
 * State machine:
 *   idle → dragging → uploading → missing (checklist incomplete)
 *                              ↘ success (checklist complete OR missing fields filled)
 *                              ↘ error
 *
 * Multi-source support (up to 5 files):
 *   - uploadedFiles tracks { name, hash } of every successfully processed document.
 *   - mergedChecklist consolidates checklist_status across all uploads using an
 *     additive merge: KPIs already in present_kpis are NEVER removed by a later upload.
 *   - "Subir otro documento" only appears when uploadedFiles.length < 5 and the
 *     current state is success or error.
 *   - MissingDataPanel receives mergedChecklist rather than the single-upload checklist.
 */

import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, AlertCircle, FileText, CheckCircle, Loader2, X } from "lucide-react";
import { uploadDocument, processDocument, notifyUploadComplete, finalizeExpediente, fetchKpisByVertical, fetchFounderConfig, fetchStagingData } from "@/services/founder";
import ValidationModal from "@/components/founder/ValidationModal";
import MissingDataPanel from "@/components/founder/MissingDataPanel";
import KpiGrid109 from "@/components/founder/KpiGrid109";
import CometaCopilotPanel from "@/components/founder/GeminiCopilotPanel";
import { submissionBlockedSchema } from "@/lib/schemas";
import type { UploadResponse, ChecklistStatus, KpiMetadataItem, FounderConfig, SubmissionBlocked, KpiGridRow, KpiReviewRow, ProcessDocumentApiResponse, CerebroResult, FounderStaging } from "@/lib/schemas";
import { resolveCompanyFromEmail, mergeWithBackendConfig, type CompanyInfo } from "@/lib/company-resolver";

type UploadState = "idle" | "dragging" | "uploading" | "reviewing" | "missing" | "rescue" | "success" | "error";
type Vertical    = "SAAS" | "FINTECH" | "MARKETPLACE" | "GENERAL" | "INSURTECH";

const VERTICAL_META: Record<Vertical, { label: string; icon: string }> = {
  SAAS:        { label: "SaaS",           icon: "⚡" },
  FINTECH:     { label: "Fintech",        icon: "💳" },
  MARKETPLACE: { label: "Marketplace",    icon: "🛒" },
  INSURTECH:   { label: "Insurtech",      icon: "🛡️" },
  GENERAL:     { label: "General",        icon: "📊" },
};

// ── Vertical Selector — step 0 antes de subir el archivo ────────────────────
function VerticalSelector({
  selected,
  onSelect,
  kpis,
  kpisLoading,
}: {
  selected:     Vertical | null;
  onSelect:     (v: Vertical) => void;
  kpis:         KpiMetadataItem[];
  kpisLoading:  boolean;
}) {
  return (
    <div className="w-full">
      <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.2em]"
         style={{ color: "var(--cometa-fg-muted)" }}>
        ¿Cuál es el modelo de negocio?
      </p>
      <div className="grid grid-cols-2 gap-2 mb-5">
        {(Object.keys(VERTICAL_META) as Vertical[]).map((v) => {
          const isActive = selected === v;
          return (
            <button
              key={v}
              onClick={() => onSelect(v)}
              className="flex items-center gap-2 rounded-2xl px-4 py-3 text-left text-[12px] font-light transition-all"
              style={{
                background: isActive
                  ? "color-mix(in srgb, var(--cometa-accent) 14%, transparent)"
                  : "var(--cometa-card-bg)",
                border: isActive
                  ? "1px solid color-mix(in srgb, var(--cometa-accent) 45%, transparent)"
                  : "1px solid var(--cometa-card-border)",
                color: isActive ? "var(--cometa-accent)" : "var(--cometa-fg-muted)",
              }}
            >
              <span>{VERTICAL_META[v].icon}</span>
              <span>{VERTICAL_META[v].label}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <motion.div
          key={selected}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl px-4 py-3 mb-4"
          style={{
            background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
            border:     "1px solid var(--cometa-card-border)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-[9px] uppercase tracking-[0.16em]"
               style={{ color: "var(--cometa-fg-muted)" }}>
              KPIs que el sistema buscará
            </p>
            {kpisLoading && (
              <Loader2 size={10} className="animate-spin" style={{ color: "var(--cometa-fg-muted)" }} />
            )}
          </div>
          {kpisLoading ? (
            <p className="text-[10px] opacity-50" style={{ color: "var(--cometa-fg-muted)" }}>
              Cargando catálogo…
            </p>
          ) : kpis.length === 0 ? (
            <p className="text-[10px] opacity-50" style={{ color: "var(--cometa-fg-muted)" }}>
              Selecciona un vertical para ver las métricas
            </p>
          ) : (
            <div className="space-y-1.5">
              {kpis.map((kpi) => (
                <div key={kpi.kpi_key} className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                    {kpi.is_required ? "✓" : "○"} {kpi.display_name}
                  </span>
                  <span className="font-mono text-[10px] opacity-50"
                        style={{ color: "var(--cometa-fg-muted)" }}>
                    {kpi.example_value ?? kpi.unit ?? ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

interface UploadFlowProps {
  founderEmail:   string;
  /** company_slug del JWT — para rutas GCS. */
  companySlug?:   string;
  /** company_name del JWT — prioridad sobre el resolver client-side. */
  companyNameJwt?: string;
  /**
   * company_id canónico del JWT (ej. "C010").
   * Fuente de verdad máxima para el envío a BQ — supera a autoConfig y slug.
   * Se obtiene de UserInfo.company_id que viene de /api/me → users.json.
   */
  companyIdBq?:   string;
  onSuccess?:     (result: UploadResponse) => void;
}

/**
 * Merge two ChecklistStatus objects without dropping any KPI that is already present.
 * The merged checklist's present_kpis is the union of both; missing_critical_kpis is
 * the set of KPIs in `incoming.missing_critical_kpis` that are NOT already present.
 * confidence_scores are merged by taking the higher score when both exist.
 */
function mergeChecklists(
  base: ChecklistStatus,
  incoming: ChecklistStatus,
): ChecklistStatus {
  const presentSet = new Set([...base.present_kpis, ...incoming.present_kpis]);

  const missingSet = new Set(
    incoming.missing_critical_kpis.filter((k) => !presentSet.has(k)),
  );
  // Also keep existing missing KPIs that haven't been resolved
  for (const k of base.missing_critical_kpis) {
    if (!presentSet.has(k)) missingSet.add(k);
  }

  // Merge confidence scores: higher wins
  const mergedScores: Record<string, number> = { ...(base.confidence_scores ?? {}) };
  for (const [k, v] of Object.entries(incoming.confidence_scores ?? {})) {
    mergedScores[k] = Math.max(mergedScores[k] ?? 0, v);
  }

  return {
    bucket:                incoming.bucket,
    is_complete:           missingSet.size === 0,
    present_kpis:          Array.from(presentSet),
    missing_critical_kpis: Array.from(missingSet),
    display_message:       incoming.display_message,
    confidence_scores:     Object.keys(mergedScores).length > 0 ? mergedScores : undefined,
  };
}

const MAX_FILES = 5;

// ── ContractReviewPanel ───────────────────────────────────────────────────────
// ── X-Ray Report — panel de revisión de diagnóstico financiero ────────────────
//
// Reemplaza la tabla horizontal plana con:
//   · Banner de identidad (empresa, año, sector, botón Excel original)
//   · Filtro rápido de granularidad (Mensual / Trimestral / Anual)
//   · Grilla de tarjetas de KPI con badge de estado y alerta
//   · Vista dividida: grilla a la izquierda + visor de archivo a la derecha
//
// Se muestra en uploadState === "reviewing", antes de pasar a "success".

type Granularity = "M" | "Q" | "A";

function fmtKpiValue(v: number | null | undefined, unit: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (unit === "%") return `${v.toFixed(1)}%`;
  if (unit === "$") {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
    return `$${v.toLocaleString()}`;
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Mini spark-bar: renders a tiny 24×16 SVG bar chart from a single value
// (visual accent only — we have one period, so we draw a single bar + baseline)
function SparkBar({ value, violation }: { value: number | null | undefined; violation?: boolean }) {
  const h = value !== null && value !== undefined ? Math.min(100, Math.max(10, Math.abs(value) / 10)) : 20;
  const color = violation ? "#ef4444" : "rgba(255,255,255,0.25)";
  return (
    <svg width="28" height="16" viewBox="0 0 28 16" fill="none" style={{ display: "block" }}>
      <rect x="0"  y={16 - h * 0.16} width="4" height={h * 0.16} rx="1" fill={color} opacity="0.4" />
      <rect x="6"  y={16 - h * 0.10} width="4" height={h * 0.10} rx="1" fill={color} opacity="0.55" />
      <rect x="12" y={16 - h * 0.13} width="4" height={h * 0.13} rx="1" fill={color} opacity="0.7" />
      <rect x="18" y={16 - h * 0.09} width="4" height={h * 0.09} rx="1" fill={color} opacity="0.85" />
      <rect x="24" y={16 - h * 0.16} width="4" height={h * 0.16} rx="1" fill={color} />
    </svg>
  );
}

function KpiCard({ row }: { row: KpiReviewRow }) {
  const hasVio = row.physics_violation;
  const label  = (row.kpi_label ?? row.kpi_key ?? "").replace(/_/g, " ");
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className="rounded-2xl p-3 flex flex-col gap-2 relative overflow-hidden"
      style={{
        background: hasVio
          ? "color-mix(in srgb, #ef4444 7%, #171717)"
          : "#171717",
        border: hasVio
          ? "1px solid color-mix(in srgb, #ef4444 30%, transparent)"
          : "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Status pip */}
      <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full"
        style={{ background: hasVio ? "#ef4444" : "rgba(255,255,255,0.2)" }} />

      {/* Label */}
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] leading-tight pr-3"
        style={{ color: hasVio ? "#fca5a5" : "rgba(163,163,163,0.8)" }}>
        {label}
      </p>

      {/* Value */}
      <p className="text-[18px] font-light leading-none" style={{
        color:     hasVio ? "#fca5a5" : "#ededed",
        fontVariantNumeric: "tabular-nums",
      }}>
        {fmtKpiValue(row.ai_value, row.unit)}
      </p>

      {/* Bottom row: sparkbar + alert badge */}
      <div className="flex items-end justify-between gap-1 mt-auto">
        <SparkBar value={row.ai_value} violation={hasVio} />
        {hasVio ? (
          <span className="text-[8px] font-semibold uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-md"
            style={{ background: "color-mix(in srgb, #ef4444 20%, transparent)", color: "#fca5a5" }}>
            VIO
          </span>
        ) : (
          <span className="text-[8px] tracking-wide" style={{ color: "rgba(255,255,255,0.2)" }}>OK</span>
        )}
      </div>

      {/* Violation message */}
      {hasVio && row.cerebro_alert && (
        <p className="text-[9px] leading-snug" style={{ color: "#fca5a5", opacity: 0.85 }}>
          {row.cerebro_alert}
        </p>
      )}
    </motion.div>
  );
}

function ContractReviewPanel({
  result,
  fileName,
  onConfirm,
  onCancel,
}: {
  result:    ProcessDocumentApiResponse;
  fileName:  string;
  onConfirm: () => void;
  onCancel:  () => void;
}) {
  const [granularity, setGranularity] = useState<Granularity>("M");
  const [splitView,   setSplitView]   = useState(false);

  const cerebro     = result.cerebro as CerebroResult;
  const enriched    = cerebro.enriched_rows ?? [];
  const derived     = cerebro.derived_rows  ?? [];
  // Violations-first sort: VIO rows always appear at the top
  const allRows     = [...enriched, ...derived].sort(
    (a, b) => (b.physics_violation ? 1 : 0) - (a.physics_violation ? 1 : 0)
  );
  const violations  = cerebro.violations       ?? [];
  const missing     = cerebro.missing_required ?? [];
  const isBlocked   = cerebro.approval_blocked ?? false;
  const audit       = result.audit ?? {};
  const previewUrl  = audit.preview_url  ?? "";
  const companyName = audit.company_name || result.company_id;
  const detectedYear = audit.year        || "";
  const viewerUrl   = previewUrl
    ? `https://docs.google.com/gview?url=${encodeURIComponent(previewUrl)}&embedded=true`
    : "";
  const GRAN_LABELS: Record<Granularity, string> = { M: "Mensual", Q: "Trimestral", A: "Anual" };

  // ── Sticky header (identity banner + actions) ──────────────────────────────
  const StickyHeader = (
    <div
      className="sticky top-0 z-20 rounded-2xl mb-3"
      style={{
        background:    "color-mix(in srgb, #0a0a0a 90%, transparent)",
        backdropFilter: "blur(16px)",
        border:         "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Identity row */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
        <div className="flex items-center gap-3 min-w-0">
          {/* Status pip */}
          <div className="w-2 h-2 rounded-full shrink-0"
            style={{ background: isBlocked ? "#ef4444" : "#4ade80" }} />
          {/* Company */}
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[16px] font-extralight truncate" style={{ color: "#ededed" }}>
                {companyName}
              </span>
              {detectedYear && (
                <span className="text-[11px]" style={{ color: "rgba(163,163,163,0.6)" }}>
                  {detectedYear}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[9px]" style={{ color: isBlocked ? "#ef4444" : "#4ade80" }}>
                {isBlocked ? "Requiere revisión" : "Extracción OK"}
              </span>
              <span style={{ color: "rgba(255,255,255,0.1)" }}>·</span>
              <span className="text-[9px] font-mono" style={{ color: "rgba(163,163,163,0.5)" }}>
                {result.metrics_count} KPIs
              </span>
              {violations.length > 0 && (
                <>
                  <span style={{ color: "rgba(255,255,255,0.1)" }}>·</span>
                  <span className="text-[9px]" style={{ color: "#ef4444" }}>
                    {violations.length} alerta{violations.length !== 1 ? "s" : ""}
                  </span>
                </>
              )}
              <span style={{ color: "rgba(255,255,255,0.1)" }}>·</span>
              <span className="text-[9px] font-mono truncate max-w-[140px]"
                style={{ color: "rgba(163,163,163,0.4)" }}>
                {fileName}
              </span>
            </div>
          </div>
        </div>

        {/* Action cluster */}
        <div className="flex items-center gap-1.5 shrink-0">
          {previewUrl && (
            <a href={previewUrl} target="_blank" rel="noopener noreferrer"
              className="rounded-xl px-2.5 py-1.5 text-[10px] transition-colors whitespace-nowrap"
              style={{
                background: "rgba(255,255,255,0.05)",
                color:      "rgba(163,163,163,0.7)",
                border:     "1px solid rgba(255,255,255,0.08)",
              }}
            >
              📂 Excel
            </a>
          )}
          {viewerUrl && (
            <button onClick={() => setSplitView((v) => !v)}
              className="rounded-xl px-2.5 py-1.5 text-[10px] transition-colors whitespace-nowrap"
              style={{
                background: splitView ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
                color:      splitView ? "#ededed" : "rgba(163,163,163,0.6)",
                border:     "1px solid rgba(255,255,255,0.08)",
              }}
            >
              {splitView ? "✕ Cerrar" : "Comparar"}
            </button>
          )}
          <button onClick={onCancel}
            className="rounded-xl px-2.5 py-1.5 text-[10px] transition-colors"
            style={{
              background: "transparent",
              color:      "rgba(163,163,163,0.45)",
            }}
          >
            Cancelar
          </button>
          {/* Primary CTA — always visible */}
          <button onClick={onConfirm}
            className="rounded-xl px-4 py-1.5 text-[11px] font-medium transition-all"
            style={{ background: "#ededed", color: "#0a0a0a" }}
          >
            Confirmar diagnóstico
          </button>
        </div>
      </div>

      {/* Granularity filter sub-row */}
      <div className="flex items-center gap-1 px-4 pb-2.5 border-t"
        style={{ borderColor: "rgba(255,255,255,0.05)" }}>
        <span className="text-[8px] uppercase tracking-[0.16em] mr-1"
          style={{ color: "rgba(163,163,163,0.3)" }}>Vista</span>
        {(["M", "Q", "A"] as Granularity[]).map((g) => (
          <button key={g} onClick={() => setGranularity(g)}
            className="rounded-lg px-2.5 py-0.5 text-[9px] font-medium transition-colors"
            style={{
              background: granularity === g ? "rgba(255,255,255,0.1)" : "transparent",
              color:      granularity === g ? "#ededed" : "rgba(163,163,163,0.4)",
              border:     granularity === g ? "1px solid rgba(255,255,255,0.14)" : "1px solid transparent",
            }}
          >
            {GRAN_LABELS[g]}
          </button>
        ))}
        <span className="ml-auto text-[8px] font-mono" style={{ color: "rgba(163,163,163,0.3)" }}>
          {result.period_id}
        </span>
      </div>
    </div>
  );

  // ── Left-column scrollable content: cards + detail table ──────────────────
  const MainContent = (
    <div className="flex flex-col gap-4">

      {/* Alert strips — only when content exists */}
      {(violations.length > 0 || missing.length > 0) && (
        <div className="flex flex-col gap-2">
          {violations.length > 0 && (
            <div className="rounded-2xl px-3 py-2.5 flex flex-wrap gap-x-4 gap-y-1"
              style={{
                background: "color-mix(in srgb, #ef4444 7%, transparent)",
                border:     "1px solid color-mix(in srgb, #ef4444 22%, transparent)",
              }}
            >
              <p className="w-full text-[8px] font-semibold uppercase tracking-[0.18em] mb-0.5"
                style={{ color: "#ef4444" }}>
                Alertas de física financiera
              </p>
              {violations.map((v, i) => (
                <p key={i} className="text-[10px]" style={{ color: "#fca5a5" }}>• {v}</p>
              ))}
            </div>
          )}
          {missing.length > 0 && (
            <div className="rounded-2xl px-3 py-2"
              style={{
                background: "color-mix(in srgb, #f59e0b 6%, transparent)",
                border:     "1px solid color-mix(in srgb, #f59e0b 20%, transparent)",
              }}
            >
              <p className="text-[8px] font-semibold uppercase tracking-[0.18em] mb-1"
                style={{ color: "#f59e0b" }}>KPIs requeridos ausentes</p>
              <p className="text-[10px]" style={{ color: "#fcd34d" }}>{missing.join(" · ")}</p>
            </div>
          )}
        </div>
      )}

      {/* Cross-checks derived */}
      {(cerebro.cross_checks?.net_burn_computed || cerebro.cross_checks?.runway_computed) && (
        <div className="rounded-2xl px-4 py-3 flex gap-8"
          style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          {cerebro.cross_checks?.net_burn_computed && (
            <div>
              <p className="text-[8px] uppercase tracking-[0.14em] mb-1"
                style={{ color: "rgba(163,163,163,0.5)" }}>Burn mensual</p>
              <p className="text-[20px] font-light" style={{ color: "#ededed" }}>
                {fmtKpiValue(cerebro.cross_checks.net_burn_monthly, "$")}
              </p>
            </div>
          )}
          {cerebro.cross_checks?.runway_computed && (
            <div>
              <p className="text-[8px] uppercase tracking-[0.14em] mb-1"
                style={{ color: "rgba(163,163,163,0.5)" }}>Runway</p>
              <p className="text-[20px] font-light" style={{ color: "#ededed" }}>
                {cerebro.cross_checks.runway_months?.toFixed(1)}{" "}
                <span className="text-[11px]" style={{ color: "rgba(163,163,163,0.5)" }}>meses</span>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── X-Ray Card Grid ── */}
      {allRows.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {allRows.map((row, i) => <KpiCard key={i} row={row} />)}
        </div>
      ) : (
        <div className="rounded-2xl py-10 text-center text-[11px]"
          style={{ color: "rgba(163,163,163,0.35)", background: "#171717", border: "1px solid rgba(255,255,255,0.06)" }}>
          No se extrajeron KPIs numéricos en este período.
        </div>
      )}

      {/* ── Detail Table ── */}
      {allRows.length > 0 && (
        <div className="flex flex-col gap-0 rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
          {/* Table header */}
          <div className="grid px-3 py-2 text-[8px] font-semibold uppercase tracking-[0.16em]"
            style={{
              gridTemplateColumns: "1fr 90px 60px 48px",
              background: "rgba(255,255,255,0.03)",
              color: "rgba(163,163,163,0.5)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <span>Métrica</span>
            <span className="text-right">Valor</span>
            <span className="text-right">Fuente</span>
            <span className="text-right">Estado</span>
          </div>
          {/* Rows */}
          {allRows.map((row, i) => {
            const hasVio = row.physics_violation;
            return (
              <div key={i}
                className="grid px-3 py-2 text-[11px]"
                style={{
                  gridTemplateColumns: "1fr 90px 60px 48px",
                  borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.05)",
                  background: hasVio
                    ? "color-mix(in srgb, #ef4444 4%, transparent)"
                    : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                }}
              >
                <span className="truncate pr-2" style={{ color: hasVio ? "#fca5a5" : "#ededed" }}>
                  {(row.kpi_label ?? row.kpi_key ?? "").replace(/_/g, " ")}
                </span>
                <span className="text-right font-mono tabular-nums"
                  style={{ color: hasVio ? "#fca5a5" : "rgba(237,237,237,0.8)" }}>
                  {fmtKpiValue(row.ai_value, row.unit)}
                </span>
                <span className="text-right text-[9px]"
                  style={{ color: "rgba(163,163,163,0.4)" }}>
                  {row.source ?? "—"}
                </span>
                <span className="text-right text-[9px] font-semibold"
                  style={{ color: hasVio ? "#ef4444" : "rgba(74,222,128,0.5)" }}>
                  {hasVio ? "VIO" : "OK"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full flex flex-col"
    >
      {StickyHeader}

      {/* ── Split layout or single column ──────────────────────────────────── */}
      {splitView && viewerUrl ? (
        <div className="flex gap-3 items-start">
          {/* Left — scrollable KPIs */}
          <div className="w-1/2 flex flex-col gap-0" style={{ minWidth: 0 }}>
            {MainContent}
          </div>

          {/* Right — Excel viewer, sticky relative to scroll */}
          <motion.div
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            className="w-1/2 rounded-2xl overflow-hidden"
            style={{
              position: "sticky",
              top: 72,   /* clears the sticky header (~56px + gap) */
              border:   "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div className="flex items-center justify-between px-3 py-2"
              style={{ background: "#171717", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <span className="text-[9px] uppercase tracking-[0.16em]"
                style={{ color: "rgba(163,163,163,0.45)" }}>
                Archivo original
              </span>
              <a href={previewUrl} target="_blank" rel="noopener noreferrer"
                className="text-[9px]" style={{ color: "rgba(163,163,163,0.35)" }}>
                ↗ nueva pestaña
              </a>
            </div>
            <iframe
              src={viewerUrl}
              title="Excel original"
              className="w-full"
              style={{ height: "calc(100vh - 160px)", border: "none", background: "#fff" }}
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          </motion.div>
        </div>
      ) : (
        MainContent
      )}
    </motion.div>
  );
}

/** Returns true if the string is a legacy synthetic ID (COMP_XXX) that BQ won't recognize. */
function isSyntheticCompanyId(id: string): boolean {
  return id.toUpperCase().startsWith("COMP_");
}

export default function UploadFlow({ founderEmail, companySlug, companyNameJwt, companyIdBq, onSuccess }: UploadFlowProps) {
  const router                               = useRouter();
  const fileInputRef                         = useRef<HTMLInputElement>(null);
  const [uploadState,     setUploadState]     = useState<UploadState>("idle");
  const [statusMsg,       setStatusMsg]       = useState("");
  const [fileHash,        setFileHash]        = useState<string | null>(null);
  const [fileName,        setFileName]        = useState<string | null>(null);
  const [checklistStatus, setChecklistStatus] = useState<ChecklistStatus | null>(null);
  const [uploadResult,    setUploadResult]    = useState<UploadResponse | null>(null);
  const [validationError, setValidationError] = useState<unknown>(null);
  const [blockedError,    setBlockedError]    = useState<SubmissionBlocked | null>(null);

  // Multi-file state
  const [uploadedFiles,   setUploadedFiles]   = useState<{ name: string; hash: string }[]>([]);
  const [mergedChecklist, setMergedChecklist] = useState<ChecklistStatus | null>(null);

  // Auto-detected config from /api/founder/config
  const [autoConfig,       setAutoConfig]       = useState<FounderConfig | null>(null);
  const [configLoading,    setConfigLoading]    = useState(true);

  // Company info — JWT values take priority, fallback to client-side resolver
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(() => {
    const local = resolveCompanyFromEmail(founderEmail);
    return {
      slug:        companySlug   || local.slug,
      displayName: companyNameJwt || local.displayName,
      isTest:      local.isTest,
    };
  });

  // Vertical selector (step 0) + dynamic KPI catalogue from dim_kpi_metadata
  const [selectedVertical, setSelectedVertical] = useState<Vertical | null>(null);
  const [verticalKpis,     setVerticalKpis]     = useState<KpiMetadataItem[]>([]);
  const [kpisLoading,      setKpisLoading]      = useState(false);

  // Fetch auto-config on mount — silently falls back to manual selector on failure
  useEffect(() => {
    fetchFounderConfig().then((cfg) => {
      setAutoConfig(cfg);
      if (cfg) {
        // Enrich company info with authoritative backend display name
        setCompanyInfo((prev) => mergeWithBackendConfig(prev, cfg.company_display_name));
        if (cfg.vertical && (Object.keys(VERTICAL_META) as Vertical[]).includes(cfg.vertical as Vertical)) {
          setSelectedVertical(cfg.vertical as Vertical);
        }
      }
      setConfigLoading(false);
    });
  }, []);

  // Fetch KPIs from the API whenever the vertical changes
  useEffect(() => {
    if (!selectedVertical) return;
    setKpisLoading(true);
    fetchKpisByVertical(selectedVertical)
      .then(setVerticalKpis)
      .finally(() => setKpisLoading(false));
  }, [selectedVertical]);

  // 109-KPI grid state
  const [kpiGrid,             setKpiGrid]             = useState<KpiGridRow[]>([]);
  const [showIncompleteModal, setShowIncompleteModal] = useState(false);

  // Finalize state
  const [finalizing, setFinalizing] = useState(false);
  const [lastManualKpis, setLastManualKpis] = useState<Record<string, string>>({});

  // Copilot: KPI focused by Gemini panel → KpiGrid109 opens inline input
  const [focusedKpiId, setFocusedKpiId] = useState<string | null>(null);

  // ── Nuevo flujo unificado ──────────────────────────────────────────────────
  // periodId: ingresado por el founder en formato YYYY-MM, convertido a
  // P2026Q1M01 antes de enviar al backend.
  const [periodId,        setPeriodId]        = useState<string>("");
  // Respuesta del endpoint /api/founder/process-document
  const [processDocResult, setProcessDocResult] = useState<ProcessDocumentApiResponse | null>(null);
  // Staging data loaded after a successful upload — shown in the success panel
  const [stagingData,      setStagingData]      = useState<FounderStaging | null>(null);

  // Derived: how many KPIs are still missing in the 109 grid
  const gridMissing = useMemo(
    () => kpiGrid.filter((r) => r.status !== "FOUND" && r.status !== "MANUAL_FOUND").length,
    [kpiGrid],
  );

  // Convierte YYYY-MM al formato canónico P2026Q1M01 que espera el backend
  function toPeriodId(yyyyMM: string): string {
    const [year, month] = yyyyMM.split("-");
    if (!year || !month) return yyyyMM;
    const q = Math.ceil(parseInt(month, 10) / 3);
    return `P${year}Q${q}M${month.padStart(2, "0")}`;
  }

  const handleFile = useCallback(async (file: File) => {
    if (uploadState === "uploading") return;

    // ── Nuevo flujo unificado: usar process-document cuando hay company_id ──
    // Prioridad de fuentes para company_id:
    //  1. companyIdBq — del JWT (/api/me → users.json): único ID garantizado real en BQ.
    //  2. autoConfig.company_id — del backend (/api/founder/config), solo si NO es COMP_XXX
    //     (los COMP_XXX son IDs sintéticos legacy que no existen en BigQuery).
    //  3. companyInfo.slug — fallback client-side (slug del dominio del email).
    const companyId =
      (companyIdBq && companyIdBq.trim())
        ? companyIdBq.trim()
        : (autoConfig?.company_id && !isSyntheticCompanyId(autoConfig.company_id))
          ? autoConfig.company_id
          : companyInfo.slug;

    const isExcel = /\.(xlsx|xls)$/i.test(file.name);

    // Excel: el backend detecta empresa y período del archivo automáticamente.
    // No se requiere companyId ni periodId — siempre va a process-document.
    // PDF: necesita periodId (Gemini no puede inferirlo del contenido solo).
    if (isExcel || (companyId && periodId)) {
      setFileName(file.name);
      setUploadState("uploading");
      setStatusMsg("Gemini está analizando el documento…");
      setValidationError(null);
      setBlockedError(null);

      try {
        // periodId is empty for Excel auto-detection uploads; pass "" and
        // the backend will extract the year from the file headers.
        const resolvedPeriodId = periodId ? toPeriodId(periodId) : "";
        const result = await processDocument(file, resolvedPeriodId, companyId);
        setProcessDocResult(result);

        // Multi-período (cerebro vacío): los datos ya están en staging. No hay
        // nada que revisar célula por célula → saltar directamente a success y
        // mostrar confirmación inmediata. Para PDF/single-period con cerebro real,
        // mantener el flujo de revisión manual.
        const hasCerebroData =
          (result.cerebro as CerebroResult)?.enriched_rows?.length > 0 ||
          (result.cerebro as CerebroResult)?.violations?.length > 0;

        if (!hasCerebroData) {
          setUploadState("success");
          setStatusMsg(
            `¡Archivo procesado con éxito! ${result.metrics_count} KPI${result.metrics_count !== 1 ? "s" : ""} en revisión.`
          );
          // Cargar datos de staging en background para mostrar en el panel de éxito
          fetchStagingData().then(setStagingData);
        } else {
          setUploadState("reviewing");
        }
      } catch (err: unknown) {
        // Detectar ZodError antes de intentar leer .response.status
        const isZodError = err instanceof Error && err.name === "ZodError";
        if (isZodError) {
          console.error("[UploadFlow] ZodError — el backend respondió 200 pero el schema falló:", err);
          // Aun así marcar como éxito: el 200 OK llegó, los datos están en BQ
          setUploadState("success");
          setStatusMsg("Archivo procesado con éxito. (Revisa consola para detalles del schema.)");
          return;
        }

        const axiosErr = err as { response?: { status: number; data: unknown } };
        const status   = axiosErr?.response?.status;
        console.error("[UploadFlow] Error en process-document:", { status, err });

        if (status === 422) {
          setStatusMsg(
            "El documento no pudo ser procesado o faltan métricas clave. " +
            "Asegúrate de que el archivo contenga datos financieros legibles y vuelve a intentarlo.",
          );
          setUploadState("error");
        } else if (status === 404) {
          setStatusMsg("Empresa no registrada en el sistema. Contacta a Cometa.");
          setUploadState("error");
        } else if (status === 413) {
          setStatusMsg("El archivo supera el tamaño máximo permitido.");
          setUploadState("error");
        } else {
          setStatusMsg("Error al procesar el documento. Verifica el formato e intenta de nuevo.");
          setUploadState("error");
        }
      }
      return;
    }

    // ── Flujo legacy: sin period_id (compatibilidad con /upload) ──────────
    setFileName(file.name);
    setUploadState("uploading");
    setStatusMsg("Analizando documento…");
    setValidationError(null);
    setBlockedError(null);
    setChecklistStatus(null);

    try {
      const result = await uploadDocument(file, founderEmail, companyId || "");
      const hash   = result.file_hash ?? null;
      setFileHash(hash);
      setUploadResult(result);

      // Update uploaded files list
      if (hash) {
        setUploadedFiles((prev) => [
          ...prev,
          { name: file.name, hash },
        ]);
      }

      // Populate 109-KPI grid from audit field
      const gridRows = result.audit?.kpi_grid;
      if (gridRows && gridRows.length > 0) {
        setKpiGrid(gridRows);
      }

      // Check sector checklist
      const cs = result.checklist_status;
      if (cs) {
        // Additive merge with previous uploads
        setMergedChecklist((prev) => prev ? mergeChecklists(prev, cs) : cs);

        if (!cs.is_complete && cs.missing_critical_kpis.length > 0) {
          setChecklistStatus(cs);
          setUploadState("missing");
          return;
        }
      }

      setStatusMsg(
        result.duplicate
          ? "Documento ya registrado — auditoría recuperada."
          : result.message ?? "Reporte procesado correctamente.",
      );
      setUploadState("success");
      onSuccess?.(result);
      void notifyUploadComplete(founderEmail, hash ?? "", result.company_domain);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 422) {
        setValidationError((err as { data?: unknown }).data);
        setUploadState("idle");
      } else if (status === 400) {
        // Mandatory fields missing or sanity violations — document was stored,
        // but the backend demands the founder fill in the rescue form.
        const raw     = (err as { data?: unknown }).data;
        const parsed  = submissionBlockedSchema.safeParse(raw);
        if (parsed.success) {
          const blocked = parsed.data;
          // Register file_hash so finalizeExpediente can reference it later
          if (blocked.file_hash) {
            setFileHash(blocked.file_hash);
            setUploadedFiles((prev) => [
              ...prev,
              { name: file.name, hash: blocked.file_hash! },
            ]);
          }
          // Merge the checklist so MissingDataPanel has the full picture
          if (blocked.checklist_status) {
            setMergedChecklist((prev) =>
              prev ? mergeChecklists(prev, blocked.checklist_status!) : blocked.checklist_status!,
            );
            setChecklistStatus(blocked.checklist_status);
          }
          setBlockedError(blocked);
        }
        setUploadState("rescue");
      } else {
        setStatusMsg("Error al procesar el documento. Intenta de nuevo.");
        setUploadState("error");
      }
    }
  }, [uploadState, founderEmail, periodId, autoConfig, companyInfo, onSuccess]);

  // Asegura que el archivo esté en uploadedFiles para que handleFinalize tenga el hash.
  // Necesario cuando file_hash llega en 400/blocked pero no en la ruta normal.
  function _ensureFileTracked() {
    if (fileHash && fileName) {
      setUploadedFiles((prev) =>
        prev.some((f) => f.hash === fileHash) ? prev : [...prev, { name: fileName, hash: fileHash }],
      );
    }
  }

  function handleRescueComplete(values: Record<string, string>) {
    setLastManualKpis((prev) => ({ ...prev, ...values }));
    setMergedChecklist((prev) =>
      prev ? { ...prev, is_complete: true, missing_critical_kpis: [] } : null,
    );
    setBlockedError(null);
    _ensureFileTracked();
    setStatusMsg("Datos completados. Reporte listo para finalizar.");
    setUploadState("success");
    if (uploadResult) onSuccess?.(uploadResult);
    void notifyUploadComplete(founderEmail, fileHash ?? "", uploadResult?.company_domain);
  }

  function handleMissingComplete(values: Record<string, string>) {
    setLastManualKpis((prev) => ({ ...prev, ...values }));
    setMergedChecklist((prev) => prev ? { ...prev, is_complete: true, missing_critical_kpis: [] } : null);
    _ensureFileTracked();
    setStatusMsg(
      uploadResult?.message ?? "Datos complementados. Reporte registrado correctamente.",
    );
    setUploadState("success");
    if (uploadResult) onSuccess?.(uploadResult);
    void notifyUploadComplete(founderEmail, fileHash ?? "", uploadResult?.company_domain);
  }

  function handleFinalizeClick() {
    if (finalizing || uploadedFiles.length === 0) return;
    // Block if 109-KPI grid is present and incomplete
    if (kpiGrid.length > 0 && gridMissing > 0) {
      setShowIncompleteModal(true);
      return;
    }
    void handleFinalize();
  }

  async function handleFinalize() {
    setFinalizing(true);
    try {
      // Prioridad: slug del JWT (inyectado en login) > autoConfig > upload result > dominio del email
      const companyDomain =
        companySlug ||
        companyInfo.slug ||
        autoConfig?.company_id ||
        uploadResult?.company_domain ||
        (founderEmail.includes("@") ? founderEmail.split("@")[1] : "");

      // Build manual_kpis from both lastManualKpis and MANUAL_FOUND grid rows
      const gridManual: Record<string, string> = {};
      for (const row of kpiGrid) {
        if (row.status === "MANUAL_FOUND" && row.value !== null) {
          gridManual[row.kpi_id] = String(row.value);
        }
      }
      const allManual = { ...lastManualKpis, ...gridManual };

      const response = await finalizeExpediente({
        file_hashes:    uploadedFiles.map((f) => f.hash),
        company_domain: companyDomain,
        file_names:     uploadedFiles.map((f) => f.name),
        manual_kpis:    Object.keys(allManual).length > 0 ? allManual : undefined,
      });
      // Pasar vault_seal a la página de éxito para el Recibo Digital
      const seal   = response.vault_seal ?? "";
      const params = seal ? `?seal=${encodeURIComponent(seal)}` : "";
      router.push(`/success${params}`);
    } catch {
      setFinalizing(false);
    }
  }

  const dropZoneClass = useMemo(() => {
    const state: Record<UploadState, string> = {
      idle:      "border-white/15 hover:border-[var(--cometa-accent)]/50",
      dragging:  "border-[var(--cometa-accent)] scale-[1.02]",
      uploading: "border-white/10",
      reviewing: "border-blue-400/30",
      missing:   "border-amber-400/30",
      rescue:    "border-red-400/30",
      success:   "border-emerald-400/40",
      error:     "border-red-400/40",
    };
    return `relative flex h-64 w-full flex-col items-center justify-center gap-3
      rounded-3xl border-2 border-dashed transition-all duration-200 cursor-pointer
      ${state[uploadState]}`;
  }, [uploadState]);

  function resetForNextFile() {
    setUploadState("idle");
    setStatusMsg("");
    setFileHash(null);
    setFileName(null);
    setChecklistStatus(null);
    setUploadResult(null);
    setProcessDocResult(null);
  }

  const canUploadMore = uploadedFiles.length < MAX_FILES;
  // Collapse the full drop zone once we have KPI grid data — show compact strip instead
  const showDropZone     = uploadState !== "missing" && uploadState !== "rescue" && !(uploadState === "success" && kpiGrid.length > 0);
  const showCompactStrip = uploadState === "success" && kpiGrid.length > 0;
  const showUploadAnother =
    canUploadMore && (uploadState === "success" || uploadState === "error");

  // Show "Finalizar" when at least one upload succeeded and state is success.
  // The button renders even when the 109-grid is incomplete — clicking it
  // then shows the incomplete modal instead of submitting.
  // fileHash !== null cubre el caso en que uploadedFiles aún no se pobló
  // (ej. file_hash llegó solo en el 400 blocked y _ensureFileTracked aún no corrió).
  const showFinalize =
    (uploadedFiles.length > 0 || fileHash !== null) &&
    uploadState === "success" &&
    (mergedChecklist === null || mergedChecklist.is_complete === true);

  // True when the 109-grid gate blocks the finalize action
  const finalizeBlocked = kpiGrid.length > 0 && gridMissing > 0;
  const isUploadingNow  = uploadState === "uploading";

  // Force completion: at MAX_FILES, checklist still incomplete, not already in missing state
  const showForceComplete =
    !canUploadMore &&
    mergedChecklist !== null &&
    mergedChecklist.is_complete === false &&
    uploadState !== "missing" &&
    uploadState !== "uploading";

  // Drop zone siempre habilitado — el backend detecta empresa y período del archivo
  const verticalReady = true;

  return (
    <>
      {/* ── Content container ── */}
      <div className="w-full max-w-lg mx-auto px-4 sm:px-6">
      <div className="flex flex-col items-center gap-5">
      {/* ── Main column ── */}
      <div className="flex flex-col gap-5 w-full min-w-0">

        {/* ── Banner de identificación automática ── */}
        {uploadState === "idle" && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full rounded-2xl px-4 py-3 flex items-start gap-3"
            style={{
              background: "color-mix(in srgb, #4ade80 6%, transparent)",
              border:     "1px solid color-mix(in srgb, #4ade80 22%, transparent)",
            }}
          >
            <span className="mt-0.5 text-emerald-400 shrink-0" style={{ fontSize: 13 }}>✦</span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">
                Identificación automática activada
              </p>
              <p className="text-[11px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                Los datos de empresa y periodo se extraerán directamente del archivo Excel.
                Solo arrastra el archivo y haz clic en procesar.
              </p>
            </div>
          </motion.div>
        )}

        {/* ── Step 0b: Período (opcional para Excel) ── */}
        {uploadState === "idle" && (
          <div className="w-full">
            <p
              className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.2em]"
              style={{ color: "var(--cometa-fg-muted)" }}
            >
              Período del reporte <span style={{ opacity: 0.5, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(opcional para Excel)</span>
            </p>
            <input
              type="month"
              value={periodId}
              onChange={(e) => setPeriodId(e.target.value)}
              className="w-full rounded-2xl px-4 py-2.5 text-[12px] outline-none transition-all"
              style={{
                background:  "var(--cometa-card-bg)",
                border:      periodId
                  ? "1px solid color-mix(in srgb, var(--cometa-accent) 45%, transparent)"
                  : "1px solid var(--cometa-card-border)",
                color:       "var(--cometa-fg-main)",
                colorScheme: "dark",
              }}
            />
            {!periodId && (
              <p className="mt-1 text-[10px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}>
                Para Excel el año se detecta automáticamente de las cabeceras del archivo.
              </p>
            )}
          </div>
        )}

        {/* ── Reviewing state: Contract + Cerebro review panel ── */}
        {uploadState === "reviewing" && processDocResult && (
          <ContractReviewPanel
            result={processDocResult}
            fileName={fileName ?? ""}
            onConfirm={() => {
              setUploadState("success");
              setStatusMsg(`¡Archivo procesado con éxito! ${processDocResult.metrics_count} KPI${processDocResult.metrics_count !== 1 ? "s" : ""} en revisión.`);
              fetchStagingData().then(setStagingData);
            }}
            onCancel={() => {
              setProcessDocResult(null);
              setUploadState("idle");
            }}
          />
        )}

        {/* ── Step 0: Auto-config pill or Vertical selector ── */}
        {uploadedFiles.length === 0 && uploadState === "idle" && (
          configLoading ? (
            <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
              <Loader2 size={12} className="animate-spin shrink-0" />
              Detectando perfil…
            </div>
          ) : autoConfig?.is_known ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full rounded-2xl px-4 py-3 flex items-center justify-between"
              style={{
                background: "color-mix(in srgb, var(--cometa-accent) 10%, transparent)",
                border:     "1px solid color-mix(in srgb, var(--cometa-accent) 28%, transparent)",
              }}
            >
              <div>
                <p className="text-[9px] uppercase tracking-[0.18em] mb-0.5" style={{ color: "var(--cometa-accent)" }}>
                  Empresa detectada
                </p>
                <p className="text-[12px] font-light" style={{ color: "var(--cometa-fg)" }}>
                  {companyInfo.displayName} · {VERTICAL_META[autoConfig.vertical as Vertical]?.label ?? autoConfig.vertical}
                </p>
              </div>
              <span className="text-lg">{VERTICAL_META[autoConfig.vertical as Vertical]?.icon ?? "📊"}</span>
            </motion.div>
          ) : (
            <VerticalSelector
              selected={selectedVertical}
              onSelect={setSelectedVertical}
              kpis={verticalKpis}
              kpisLoading={kpisLoading}
            />
          )
        )}

        {/* ── Processed files list ── */}
        {uploadedFiles.length > 0 && (
          <div className="w-full space-y-1.5">
            {uploadedFiles.map((f, i) => (
              <div
                key={f.hash}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-[11px]"
                style={{
                  background: "rgba(74,222,128,0.06)",
                  border:     "1px solid rgba(74,222,128,0.18)",
                }}
              >
                <CheckCircle size={11} className="shrink-0 text-emerald-400" />
                <span className="flex-1 truncate" style={{ color: "var(--cometa-fg-muted)" }}>
                  {f.name}
                </span>
                <span className="font-mono text-[9px] opacity-50">
                  {i + 1}/{MAX_FILES}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Drop zone (hidden while filling missing data) ── */}
        <AnimatePresence>
          {showDropZone && (
            <motion.div
              initial={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }}
              className="w-full"
            >
              <div
                className={dropZoneClass}
                style={{
                  background: "var(--cometa-card-bg)",
                  opacity: !verticalReady && uploadedFiles.length === 0 ? 0.45 : 1,
                  pointerEvents: !verticalReady && uploadedFiles.length === 0 ? "none" : undefined,
                }}
                onDragEnter={(e) => { e.preventDefault(); if (uploadState === "idle" && verticalReady) setUploadState("dragging"); }}
                onDragOver={(e)  => { e.preventDefault(); }}
                onDragLeave={(e) => { e.preventDefault(); if (uploadState === "dragging") setUploadState("idle"); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  if (!verticalReady && uploadedFiles.length === 0) return;
                  const file = e.dataTransfer.files[0];
                  if (file) await handleFile(file);
                }}
                onClick={() => {
                  if (!verticalReady && uploadedFiles.length === 0) return;
                  if (uploadState !== "uploading") fileInputRef.current?.click();
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="*/*"
                  disabled={uploadState === "uploading"}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      await handleFile(file);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }
                  }}
                  className="absolute inset-0 opacity-0 pointer-events-none"
                />

                <AnimatePresence mode="wait">
                  {/* Uploading */}
                  {uploadState === "uploading" && (
                    <motion.div key="up"
                      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none"
                    >
                      <motion.div
                        className="h-10 w-10 rounded-full border-2 border-t-transparent"
                        style={{ borderColor: "var(--cometa-accent)", borderTopColor: "transparent" }}
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      />
                      <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                        {statusMsg}
                      </p>
                    </motion.div>
                  )}

                  {/* Success */}
                  {uploadState === "success" && (
                    <motion.div key="ok"
                      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none text-center"
                    >
                      {/* Checkmark animado */}
                      <motion.div
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      >
                        <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden>
                          <motion.circle
                            cx="26" cy="26" r="22"
                            stroke="#4ade80" strokeWidth="2"
                            fill="rgba(74,222,128,0.08)"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                          />
                          <motion.path
                            d="M15 26 L22 33 L37 19"
                            stroke="#4ade80" strokeWidth="3"
                            strokeLinecap="round" strokeLinejoin="round"
                            fill="none"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.4, delay: 0.35, ease: "easeOut" }}
                          />
                        </svg>
                      </motion.div>
                      <div className="w-full text-center">
                        <p className="text-sm font-semibold" style={{ color: "#4ade80" }}>
                          ¡Archivo procesado con éxito!
                        </p>
                        <p className="mt-1 text-[12px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                          {statusMsg}
                        </p>

                        {/* Staging preview — batches PENDING */}
                        {stagingData && stagingData.total_rows > 0 && (
                          <div className="mt-3 rounded-2xl p-3 text-left"
                            style={{ background: "rgba(74,222,128,0.04)", border: "1px solid rgba(74,222,128,0.15)" }}
                          >
                            <p className="text-[9px] uppercase tracking-[0.18em] mb-2" style={{ color: "#4ade80" }}>
                              En revisión · {stagingData.total_rows} filas en staging
                            </p>
                            {stagingData.batches.slice(0, 3).map((batch) => (
                              <div key={batch.staging_id} className="mb-1.5">
                                <p className="text-[10px] font-mono" style={{ color: "var(--cometa-fg-muted)" }}>
                                  {batch.staging_id} · {batch.rows.length} KPIs
                                </p>
                                <p className="text-[9px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}>
                                  {batch.rows.slice(0, 4).map((r) => r.metric_id).join(", ")}
                                  {batch.rows.length > 4 ? ` +${batch.rows.length - 4} más` : ""}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* CTA: redirect to staging review */}
                        <button
                          onClick={() => router.push("/founder/staging")}
                          className="mt-3 w-full rounded-2xl py-2 text-[11px] font-medium transition-colors"
                          style={{
                            background: "rgba(74,222,128,0.12)",
                            color:      "#4ade80",
                            border:     "1px solid rgba(74,222,128,0.25)",
                          }}
                        >
                          Ver datos en revisión →
                        </button>
                      </div>
                      {fileHash && (
                        <p className="font-mono text-[9px]" style={{ color: "var(--cometa-fg-muted)" }}>
                          {fileHash.slice(0, 16)}…
                        </p>
                      )}
                    </motion.div>
                  )}

                  {/* Error */}
                  {uploadState === "error" && (
                    <motion.div key="err"
                      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none"
                    >
                      <AlertCircle size={32} className="text-red-400" />
                      <p className="text-[12px]" style={{ color: "var(--cometa-fg-muted)" }}>
                        {statusMsg}
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
                        Haz clic para intentar de nuevo
                      </p>
                    </motion.div>
                  )}

                  {/* Idle / Dragging */}
                  {(uploadState === "idle" || uploadState === "dragging") && (
                    <motion.div key="idle"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none"
                    >
                      <div
                        className="rounded-2xl p-4"
                        style={{ border: "1px solid var(--cometa-card-border)", background: "var(--cometa-card-bg)" }}
                      >
                        {uploadState === "dragging"
                          ? <FileText size={28} style={{ color: "var(--cometa-accent)" }} />
                          : <Upload size={28} style={{ color: "var(--cometa-fg-muted)" }} />
                        }
                      </div>
                      <div className="text-center">
                        <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                          {!verticalReady && uploadedFiles.length === 0
                            ? "Selecciona el modelo de negocio primero"
                            : uploadState === "dragging" ? "Suelta el archivo"
                            : "Arrastra tu reporte financiero"}
                        </p>
                        <p className="mt-1 text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}>
                          PDF, Excel, CSV · máx. 50 MB
                        </p>
                        {uploadedFiles.length > 0 && (
                          <p className="mt-1 text-[10px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.5 }}>
                            {uploadedFiles.length}/{MAX_FILES} documentos cargados
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* File name hint */}
        {fileName && uploadState !== "idle" && uploadState !== "missing" && (
          <p className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
            {fileName}
          </p>
        )}

        {/* ── Compact success strip (replaces full drop zone when kpiGrid is present) ── */}
        {showCompactStrip && (
          <div
            className="w-full flex items-center justify-between rounded-2xl px-4 py-3"
            style={{
              background:  "rgba(74,222,128,0.05)",
              border:      "1px solid rgba(74,222,128,0.18)",
            }}
          >
            <div className="flex items-center gap-2.5">
              <CheckCircle size={14} className="text-emerald-400 shrink-0" />
              <div>
                <p className="text-[11px] font-medium" style={{ color: "#4ade80" }}>
                  {uploadedFiles.length} documento{uploadedFiles.length !== 1 ? "s" : ""} procesado{uploadedFiles.length !== 1 ? "s" : ""}
                </p>
                {fileName && (
                  <p className="text-[10px] truncate max-w-[240px]" style={{ color: "#64748b" }}>
                    {fileName}
                  </p>
                )}
              </div>
            </div>
            {showUploadAnother && (
              <button
                onClick={resetForNextFile}
                className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-medium transition-all hover:opacity-80"
                style={{
                  background:  "rgba(255,255,255,0.05)",
                  border:      "1px solid rgba(255,255,255,0.10)",
                  color:       "#94a3b8",
                }}
              >
                <Upload size={11} />
                Subir otro
                <span className="opacity-60">({uploadedFiles.length}/{MAX_FILES})</span>
              </button>
            )}
          </div>
        )}

        {/* ── 109-KPI grid ── */}
        <AnimatePresence>
          {uploadState === "success" && kpiGrid.length > 0 && (
            <motion.div
              key="kpi-grid"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="w-full"
            >
              <KpiGrid109
                grid={kpiGrid}
                focusedKpiId={focusedKpiId}
                onGridChange={(updated) => {
                  setKpiGrid(updated);
                  setFocusedKpiId(null);
                  const manual: Record<string, string> = {};
                  for (const row of updated) {
                    if (row.status === "MANUAL_FOUND" && row.value !== null) {
                      manual[row.kpi_id] = String(row.value);
                    }
                  }
                  setLastManualKpis((prev) => ({ ...prev, ...manual }));
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Missing data panel (uses merged checklist) ── */}
        <AnimatePresence>
          {uploadState === "missing" && (mergedChecklist ?? checklistStatus) && (
            <motion.div
              key="missing"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="w-full"
            >
              <div className="mb-4 text-center">
                <p className="text-[11px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                  {fileName}
                </p>
              </div>
              <MissingDataPanel
                checklist={mergedChecklist ?? checklistStatus!}
                fileHash={fileHash ?? undefined}
                onComplete={handleMissingComplete}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Rescue panel (400 gate: mandatory fields + sanity violations) ── */}
        <AnimatePresence>
          {uploadState === "rescue" && blockedError && (
            <motion.div
              key="rescue"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="w-full"
            >
              {/* Header badge */}
              <div
                className="mb-4 flex items-center gap-2 rounded-2xl px-4 py-2.5"
                style={{
                  background: "color-mix(in srgb, #ef4444 8%, transparent)",
                  border:     "1px solid color-mix(in srgb, #ef4444 20%, transparent)",
                }}
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em]"
                      style={{ color: "#f87171" }}>
                  Datos requeridos — {fileName}
                </span>
              </div>

              <MissingDataPanel
                checklist={
                  blockedError.checklist_status ?? {
                    bucket:                "OTH",
                    is_complete:           false,
                    present_kpis:          [],
                    missing_critical_kpis: blockedError.missing_mandatory_fields.map((f) => f.kpi_key),
                    display_message:       "Completa los campos obligatorios para continuar.",
                  }
                }
                fileHash={fileHash ?? undefined}
                sanityViolations={blockedError.sanity_violations}
                onComplete={handleRescueComplete}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* "Subir otro documento" large button only shows in drop zone state (no kpiGrid) */}
        {showUploadAnother && !showCompactStrip && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={resetForNextFile}
            className="w-full rounded-2xl px-5 py-3 text-[13px] font-medium tracking-wide transition-all hover:opacity-90 flex items-center justify-center gap-2"
            style={{
              background: "color-mix(in srgb, var(--cometa-accent) 12%, transparent)",
              border:     "1px solid color-mix(in srgb, var(--cometa-accent) 40%, transparent)",
              color:      "var(--cometa-accent)",
            }}
          >
            <Upload size={14} className="shrink-0" />
            Subir otro documento
            <span
              className="ml-1 rounded-full px-2 py-0.5 text-[10px]"
              style={{
                background: "color-mix(in srgb, var(--cometa-accent) 18%, transparent)",
              }}
            >
              {uploadedFiles.length}/{MAX_FILES}
            </span>
          </motion.button>
        )}

        {/* Limit reached message — only when checklist is complete */}
        {!canUploadMore && (mergedChecklist === null || mergedChecklist.is_complete) && (
          <p className="text-[10px] uppercase tracking-widest opacity-50"
             style={{ color: "var(--cometa-fg-muted)" }}>
            Límite de {MAX_FILES} documentos alcanzado
          </p>
        )}

        {/* Force-complete: at MAX_FILES but checklist still has missing fields */}
        {showForceComplete && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={() => setUploadState("missing")}
            className="w-full rounded-2xl px-5 py-3 text-[13px] font-light tracking-wide
                       transition-opacity hover:opacity-80"
            style={{
              background: "color-mix(in srgb, #f59e0b 12%, transparent)",
              border:     "1px solid color-mix(in srgb, #f59e0b 25%, transparent)",
              color:      "#fbbf24",
            }}
          >
            Completar datos faltantes ({mergedChecklist.missing_critical_kpis.length} campos)
          </motion.button>
        )}

        {/* Finalizar Expediente CTA */}
        {showFinalize && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            onClick={handleFinalizeClick}
            disabled={finalizing}
            className="w-full rounded-2xl px-5 py-3.5 text-[13px] font-light tracking-wide
                       transition-all disabled:opacity-50 hover:opacity-85 flex items-center justify-center gap-2"
            style={{
              background: finalizeBlocked
                ? "color-mix(in srgb, var(--cometa-accent) 35%, transparent)"
                : "var(--cometa-accent)",
              color:   "var(--cometa-accent-fg)",
              opacity: finalizeBlocked ? 0.6 : 1,
            }}
          >
            {finalizing ? (
              <><Loader2 size={14} className="animate-spin shrink-0" />Enviando…</>
            ) : finalizeBlocked ? (
              <>{gridMissing} KPI{gridMissing !== 1 ? "s" : ""} pendiente{gridMissing !== 1 ? "s" : ""} — Completar grilla</>
            ) : (
              "Finalizar Expediente"
            )}
          </motion.button>
        )}
      </div>{/* end main column */}

      </div>{/* end flex container */}
      </div>{/* end max-w container */}

      {/* ── Floating Copilot Widget — positions itself fixed bottom-right ── */}
      <CometaCopilotPanel
        kpiGrid={kpiGrid}
        fileName={fileName}
        founderEmail={founderEmail}
        companyName={companyInfo.displayName}
        isUploading={isUploadingNow}
        confidenceScores={uploadResult?.kpi_confidence_scores}
        onFocusKpi={(id) => setFocusedKpiId(id)}
      />

      {/* 422 Validation modal (blocks progress) */}
      {validationError !== null && (
        <ValidationModal
          error={validationError}
          onClose={() => setValidationError(null)}
        />
      )}

      {/* Incomplete 109-KPI grid modal */}
      <AnimatePresence>
        {showIncompleteModal && (
          <motion.div
            key="incomplete-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
            onClick={() => setShowIncompleteModal(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 16 }}
              transition={{ type: "spring", stiffness: 300, damping: 26 }}
              className="relative w-full max-w-sm rounded-3xl p-6 space-y-4"
              style={{
                background: "var(--cometa-card-bg)",
                border:     "1px solid color-mix(in srgb, #ef4444 28%, transparent)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowIncompleteModal(false)}
                className="absolute right-4 top-4 rounded-lg p-1 opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                <X size={14} />
              </button>

              <div
                className="flex h-10 w-10 items-center justify-center rounded-2xl"
                style={{ background: "color-mix(in srgb, #ef4444 14%, transparent)" }}
              >
                <span className="text-lg">🚫</span>
              </div>

              <div>
                <p className="text-[13px] font-semibold mb-1" style={{ color: "#f87171" }}>
                  Acción Prohibida
                </p>
                <p className="text-[12px] font-light leading-relaxed" style={{ color: "var(--cometa-fg-muted)" }}>
                  Debes completar los 109 KPIs o cargar un archivo anexo para
                  cubrir los huecos detectados.
                </p>
              </div>

              <div
                className="flex items-center justify-between rounded-xl px-4 py-2.5"
                style={{
                  background: "color-mix(in srgb, #ef4444 8%, transparent)",
                  border:     "1px solid color-mix(in srgb, #ef4444 20%, transparent)",
                }}
              >
                <span className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                  KPIs bloqueados
                </span>
                <span className="font-mono text-[13px] font-semibold" style={{ color: "#f87171" }}>
                  {gridMissing} / {kpiGrid.length}
                </span>
              </div>

              <button
                onClick={() => setShowIncompleteModal(false)}
                className="w-full rounded-2xl py-2.5 text-[13px] font-medium tracking-wide transition-all hover:opacity-85"
                style={{
                  background: "color-mix(in srgb, #ef4444 12%, transparent)",
                  border:     "1px solid color-mix(in srgb, #ef4444 30%, transparent)",
                  color:      "#f87171",
                }}
              >
                Completar grilla ↑
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
