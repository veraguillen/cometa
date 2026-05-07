"use client";

/**
 * KpiReviewPanel — Vista de Analista para revisión y certificación de KPIs.
 *
 * Layout:
 *   ┌─ PDF Viewer (izquierda, 40%) ─────┬─ KPI Review Table (derecha, 60%) ─┐
 *   │  iframe → signed URL del raw PDF  │  Fila por KPI:                    │
 *   │  Fallback: botón "Abrir en nueva  │    AI value | confidence badge     │
 *   │  pestaña" si iframe bloqueado     │    analyst input | alert           │
 *   └───────────────────────────────────┴───────────────────────────────────┘
 *   [Footer: Aprobar y Certificar] — bloqueado si hay VIO sin resolver
 *
 * Reglas de confianza:
 *   confidence >= 0.80 — verde, campo editable normal
 *   confidence <  0.80 — amber pulsante, requiere confirmacion manual
 *   physics_violation  — rojo, bloquea el boton Aprobar
 *
 * Flujo:
 *   1. Props reciben cerebroResult (enriched_rows + derived_rows)
 *   2. Analista edita valores → analystValues state
 *   3. KPIs de confianza baja requieren "Confirmar" checkbox
 *   4. Analista puede agregar KPIs manuales faltantes
 *   5. Click "Aprobar" → llama finalizeAnalysis() → onFinalized(result)
 */

import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle, CheckCircle2, XCircle,
  FileText, Plus, Loader2, ShieldCheck,
  ChevronDown, ChevronUp, ExternalLink, LayoutDashboard,
} from "lucide-react";
import axios from "axios";
import { finalizeAnalysis, getStagingRawUrl } from "@/services/analyst";
import type { CerebroResult, KpiReviewRow, FinalizeAnalysisResponse } from "@/lib/schemas";

// ── Umbral de confianza — debe coincidir con CONFIDENCE_THRESHOLD en data_contract.py ──
const CONFIDENCE_THRESHOLD = 0.80;

// ── Tipos ────────────────────────────────────────────────────────────────────

interface KpiReviewPanelProps {
  loadId:        string;
  slug:          string;
  periodo:       string;          // "2025-03"
  sourceFileUri: string;          // gs://cometa-vc-raw-prod/...
  analystId:     string;          // ANA-XXXXXX
  currency:      string;
  cerebroResult: CerebroResult;
  onFinalized:   (result: FinalizeAnalysisResponse) => void;
  onCancel:      () => void;
}

interface AnalystEdit {
  value: string;       // string editable — se parsea a float al enviar
  note:  string;
  confirmed: boolean;  // para campos de confianza baja
}

// ── Helpers visuales ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return null;
  const pct  = Math.round(score * 100);
  const low  = score < CONFIDENCE_THRESHOLD;
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono",
        low
          ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
          : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
      ].join(" ")}
    >
      {pct}%
    </span>
  );
}

function PhysicsBadge({ alert }: { alert: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-red-500/10 border border-red-500/30 px-2 py-1.5 mt-1">
      <XCircle className="h-3.5 w-3.5 text-red-400 mt-0.5 shrink-0" />
      <p className="text-xs text-red-300 leading-snug">{alert}</p>
    </div>
  );
}

function formatValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value == null) return "—";
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (unit === "months") return `${value.toFixed(1)} meses`;
  if (unit?.includes("$")) {
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (Math.abs(value) >= 1_000)     return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return String(value);
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function KpiReviewPanel({
  loadId,
  slug,
  periodo,
  sourceFileUri,
  analystId,
  currency,
  cerebroResult,
  onFinalized,
  onCancel,
}: KpiReviewPanelProps) {
  // Internal state — allows in-app reload without re-mounting the panel
  const [activeCerebro, setActiveCerebro] = useState<CerebroResult>(cerebroResult);

  const allRows: KpiReviewRow[] = useMemo(
    () => [...activeCerebro.enriched_rows, ...activeCerebro.derived_rows],
    [activeCerebro],
  );

  // Estado de ediciones del analista: kpi_key -> { value, note, confirmed }
  const [edits, setEdits] = useState<Record<string, AnalystEdit>>(() => {
    const init: Record<string, AnalystEdit> = {};
    for (const row of allRows) {
      init[row.kpi_key] = {
        value:     row.ai_value != null ? String(row.ai_value) : "",
        note:      "",
        confirmed: (row.confidence ?? 1) >= CONFIDENCE_THRESHOLD,
      };
    }
    return init;
  });

  // KPIs manuales que el analista agrega manualmente
  const [manualKpis, setManualKpis] = useState<Array<{
    kpi_key: string; kpi_label: string; value: string; unit: string;
  }>>([]);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDraft, setManualDraft]       = useState({ kpi_key: "", kpi_label: "", value: "", unit: "$" });

  const [submitting, setSubmitting]         = useState(false);
  const [submitError, setSubmitError]       = useState<string | null>(null);
  const [finalizedResult, setFinalizedResult] = useState<FinalizeAnalysisResponse | null>(null);
  const [fileLoading, setFileLoading]       = useState(false);
  const [forceApprove, setForceApprove]     = useState(false);
  const [companyNotFound, setCompanyNotFound] = useState<{ slug: string; name: string } | null>(null);

  // ── Abrir / recargar archivo fuente ──────────────────────────────────────
  // Lógica inteligente:
  //   · .json        → re-ejecuta Cerebro in-app y actualiza la tabla sin nueva pestaña
  //   · .pdf/.xlsx   → obtiene Signed URL y abre en nueva pestaña
  async function handleOpenSourceFile() {
    if (!sourceFileUri || fileLoading) return;
    setFileLoading(true);
    try {
      const ext = sourceFileUri.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "json") {
        const { data } = await (await import("@/services/api-client")).apiClient.get<unknown>(
          "/api/analyst/stage-review",
          { params: { gcs_uri: sourceFileUri } },
        );
        setActiveCerebro(data as CerebroResult);
      } else {
        const { signed_url } = await getStagingRawUrl({ gcsUri: sourceFileUri });
        window.open(signed_url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo obtener el archivo.");
    } finally {
      setFileLoading(false);
    }
  }

  // ── Validacion del boton Aprobar ──────────────────────────────────────────
  const blockingViolations = useMemo(
    () => allRows.filter((r) => r.physics_violation),
    [allRows],
  );

  const unconfirmedLowConf = useMemo(
    () => allRows.filter(
      (r) =>
        (r.confidence ?? 1) < CONFIDENCE_THRESHOLD &&
        !edits[r.kpi_key]?.confirmed,
    ),
    [allRows, edits],
  );

  const approveBlocked =
    blockingViolations.length > 0 || unconfirmedLowConf.length > 0;

  // ── Handlers ─────────────────────────────────────────────────────────────
  const updateEdit = useCallback(
    (key: string, patch: Partial<AnalystEdit>) =>
      setEdits((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } })),
    [],
  );

  const handleApprove = useCallback(async () => {
    if (approveBlocked) return;
    setSubmitting(true);
    setSubmitError(null);

    const normalizeConfidence = (c: number | string | null | undefined): number | null => {
      if (c == null) return null;
      if (typeof c === "number") return c;
      return ({ LOW: 0.3, MEDIUM: 0.6, HIGH: 0.9 } as Record<string, number>)[c] ?? 0.5;
    };

    const kpiRows: KpiReviewRow[] = allRows.map((row) => {
      const edit = edits[row.kpi_key];
      const analystValue =
        edit?.value !== "" && edit?.value != null
          ? parseFloat(edit.value)
          : null;
      return {
        ...row,
        confidence:    normalizeConfidence(row.confidence),
        analyst_value: Number.isNaN(analystValue) ? null : analystValue,
        analyst_note:  edit?.note || null,
        source:        analystValue != null ? "analyst_approved" : row.source,
      };
    });

    // Agregar KPIs manuales
    for (const m of manualKpis) {
      const v = parseFloat(m.value);
      if (!Number.isNaN(v)) {
        kpiRows.push({
          kpi_key:           m.kpi_key,
          kpi_label:         m.kpi_label,
          ai_value:          null,
          ai_raw:            null,
          unit:              m.unit,
          confidence:        null,
          is_valid:          true,
          physics_violation: false,
          cerebro_alert:     null,
          analyst_value:     v,
          analyst_note:      "Ingresado manualmente por analista",
          source:            "manual",
        });
      }
    }

    try {
      const result = await finalizeAnalysis({
        loadId, slug, periodo: periodo.slice(0, 7), sourceFileUri, analystId, currency, kpiRows,
        forceApprove,
      });
      setFinalizedResult(result);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 422) {
        const detail = err.response.data?.detail;
        if (detail?.error === "company_not_found") {
          setCompanyNotFound({
            slug: detail.slug ?? slug,
            name: detail.company_name ?? slug,
          });
          setSubmitError(detail.message ?? "Empresa no encontrada en el registro histórico.");
        } else {
          setSubmitError(
            Array.isArray(detail) ? detail[0]?.msg ?? "Error de validación" : String(detail)
          );
        }
      } else {
        setSubmitError(err instanceof Error ? err.message : "Error al certificar");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    approveBlocked, allRows, edits, manualKpis, forceApprove,
    loadId, slug, periodo, sourceFileUri, analystId, currency, onFinalized,
  ]);

  // ── Resumen de estado ─────────────────────────────────────────────────────
  const { cc } = { cc: activeCerebro.cross_checks };

  // ── Render ────────────────────────────────────────────────────────────────

  // Pantalla de éxito — mostrada después de certificar
  if (finalizedResult) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0A0A0A] text-[#EDEDED] p-8">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md text-center"
        >
          <div className="flex items-center justify-center mb-5">
            <div className="rounded-full bg-emerald-500/10 border border-emerald-500/20 p-4">
              <ShieldCheck className="h-10 w-10 text-emerald-400" />
            </div>
          </div>

          <h2 className="text-lg font-semibold text-[#EDEDED] mb-1">
            Analisis certificado
          </h2>
          <p className="text-sm text-[#A3A3A3] mb-6">
            {slug.toUpperCase()} · {periodo} · {finalizedResult.bq_rows_upserted} KPIs escritos en BigQuery
          </p>

          <div className="bg-[#171717] border border-white/8 rounded-lg px-4 py-3 text-left mb-6 space-y-1.5 text-xs">
            <div className="flex items-start gap-2 text-[#A3A3A3]">
              <span className="shrink-0 font-medium text-white/40 w-20">Gold URI</span>
              <span className="font-mono break-all text-[#EDEDED]/70">
                {finalizedResult.gold_uri || "—"}
              </span>
            </div>
            <div className="flex items-start gap-2 text-[#A3A3A3]">
              <span className="shrink-0 font-medium text-white/40 w-20">PDF</span>
              <span className="font-mono break-all text-[#EDEDED]/70">
                {finalizedResult.pdf_gold_uri || "—"}
              </span>
            </div>
            {finalizedResult.warnings.length > 0 && (
              <div className="pt-1.5 border-t border-white/8">
                {finalizedResult.warnings.map((w, i) => (
                  <p key={i} className="text-amber-400/80 text-[11px]">⚠ {w}</p>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {finalizedResult.dashboard_url && (
              <a
                href={finalizedResult.dashboard_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 bg-white text-black rounded px-4 py-2.5 text-sm font-semibold hover:bg-white/90 transition-colors"
              >
                <LayoutDashboard className="h-4 w-4" />
                Ver Datos en Looker Studio
              </a>
            )}
            <button
              onClick={() => onFinalized(finalizedResult)}
              className="flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-[#EDEDED] rounded px-4 py-2.5 text-sm transition-colors"
            >
              Cerrar
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A] text-[#EDEDED]">

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/8 shrink-0">
        <div>
          <h2 className="text-sm font-semibold tracking-wide">
            Vista de Analista — Revisión de KPIs
          </h2>
          <p className="text-xs text-[#A3A3A3] mt-0.5">
            {slug.toUpperCase()} · {periodo} · {currency} · load: {loadId.slice(0, 8)}
          </p>
        </div>

        {/* Indicadores de estado */}
        <div className="flex items-center gap-3">
          {blockingViolations.length > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
              <XCircle className="h-3.5 w-3.5" />
              {blockingViolations.length} violación{blockingViolations.length > 1 ? "es" : ""}
            </span>
          )}
          {unconfirmedLowConf.length > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              {unconfirmedLowConf.length} sin confirmar
            </span>
          )}
          {activeCerebro.cross_checks.runway_months != null && (
            <span className="flex items-center gap-1.5 text-xs text-[#A3A3A3] bg-white/5 border border-white/8 rounded px-2 py-1">
              Runway {activeCerebro.cross_checks.runway_months.toFixed(1)} m
            </span>
          )}
        </div>
      </div>

      {/* Cuerpo: PDF + Tabla */}
      <div className="flex flex-col lg:flex-row flex-1 overflow-hidden">

        {/* PDF Viewer */}
        <div className="lg:w-2/5 border-b lg:border-b-0 lg:border-r border-white/8 flex flex-col">
          <div className="px-4 py-2.5 border-b border-white/8 flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-[#A3A3A3]" />
            <span className="text-xs text-[#A3A3A3]">Documento original</span>
            <button
              onClick={handleOpenSourceFile}
              disabled={fileLoading || !sourceFileUri}
              className="ml-auto flex items-center gap-1 text-xs text-white/60 hover:text-white transition-colors disabled:opacity-40"
            >
              {fileLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
              Abrir
            </button>
          </div>
          <div className="flex-1 bg-[#171717] flex items-center justify-center p-4">
            <div className="text-center text-[#A3A3A3]">
              <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-xs mb-3">
                {sourceFileUri.split("/").pop()}
              </p>
              <button
                onClick={handleOpenSourceFile}
                disabled={fileLoading || !sourceFileUri}
                className="inline-flex items-center gap-1.5 text-xs bg-white/8 hover:bg-white/12 border border-white/10 rounded px-3 py-1.5 transition-colors disabled:opacity-40"
              >
                {fileLoading
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <ExternalLink className="h-3 w-3" />}
                {sourceFileUri.toLowerCase().endsWith(".json")
                  ? "Ver JSON de stage"
                  : "Abrir archivo en nueva pestaña"}
              </button>
              {cc.net_burn_monthly != null && (
                <div className="mt-4 text-left bg-white/4 border border-white/8 rounded-lg p-3 space-y-1.5">
                  <p className="text-[10px] font-semibold text-[#A3A3A3] uppercase tracking-wider">Cross-checks Cerebro</p>
                  {cc.net_burn_monthly != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-[#A3A3A3]">Net Burn / mes</span>
                      <span className="font-mono text-white">${cc.net_burn_monthly.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                    </div>
                  )}
                  {cc.runway_months != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-[#A3A3A3]">Runway</span>
                      <span className={["font-mono", cc.runway_months < 6 ? "text-red-400" : cc.runway_months < 12 ? "text-amber-400" : "text-emerald-400"].join(" ")}>
                        {cc.runway_months.toFixed(1)} meses
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tabla de KPIs */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-[#0A0A0A] z-10">
              <tr className="border-b border-white/8">
                <th className="text-left py-2.5 px-4 text-xs font-medium text-[#A3A3A3] w-1/4">KPI</th>
                <th className="text-right py-2.5 px-4 text-xs font-medium text-[#A3A3A3] w-1/5">Valor IA</th>
                <th className="text-center py-2.5 px-2 text-xs font-medium text-[#A3A3A3] w-16">Conf.</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-[#A3A3A3]">Valor Analista</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-[#A3A3A3]">Nota</th>
              </tr>
            </thead>
            <tbody>
              {allRows.map((row) => {
                const edit     = edits[row.kpi_key] ?? { value: "", note: "", confirmed: true };
                const isLowConf = (row.confidence ?? 1) < CONFIDENCE_THRESHOLD;
                const isViolation = row.physics_violation;
                const isCalc   = row.source === "cerebro_calculated" || row.source === "calculated";

                return (
                  <motion.tr
                    key={row.kpi_key}
                    layout
                    className={[
                      "border-b border-white/5 transition-colors",
                      isViolation ? "bg-red-500/5" : isLowConf && !edit.confirmed ? "bg-amber-500/5" : "hover:bg-white/3",
                    ].join(" ")}
                  >
                    {/* KPI Label */}
                    <td className="py-2.5 px-4">
                      <div className="flex items-start gap-1.5">
                        <div>
                          <p className="text-xs font-medium text-[#EDEDED]">{row.kpi_label}</p>
                          <p className="text-[10px] text-[#A3A3A3] font-mono">{row.kpi_key}</p>
                          {isCalc && (
                            <span className="text-[10px] text-blue-400/80 bg-blue-500/10 border border-blue-500/15 rounded px-1 mt-0.5 inline-block">
                              calc.
                            </span>
                          )}
                        </div>
                        {isViolation && (
                          <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                        )}
                      </div>
                      {isViolation && row.cerebro_alert && (
                        <PhysicsBadge alert={row.cerebro_alert} />
                      )}
                    </td>

                    {/* Valor IA */}
                    <td className="py-2.5 px-4 text-right">
                      <span className={["text-xs font-mono", row.is_valid ? "text-[#EDEDED]" : "text-[#A3A3A3]"].join(" ")}>
                        {row.ai_value != null ? formatValue(row.ai_value, row.unit) : "—"}
                      </span>
                      {row.unit && row.ai_value != null && (
                        <span className="text-[10px] text-[#A3A3A3] ml-1">{row.unit}</span>
                      )}
                    </td>

                    {/* Confidence Badge */}
                    <td className="py-2.5 px-2 text-center">
                      <ConfidenceBadge score={row.confidence} />
                    </td>

                    {/* Input Analista */}
                    <td className="py-2 px-4">
                      <div className="flex flex-col gap-1">
                        <input
                          type="number"
                          value={edit.value}
                          onChange={(e) => updateEdit(row.kpi_key, { value: e.target.value })}
                          placeholder="editar…"
                          className={[
                            "w-full bg-white/5 border rounded px-2 py-1 text-xs font-mono text-[#EDEDED]",
                            "placeholder:text-[#A3A3A3]/50 focus:outline-none focus:ring-1 transition-all",
                            isViolation
                              ? "border-red-500/40 focus:ring-red-500/40"
                              : isLowConf && !edit.confirmed
                              ? "border-amber-500/50 focus:ring-amber-500/40 animate-pulse-border"
                              : "border-white/10 focus:ring-white/20",
                          ].join(" ")}
                        />
                        {/* Checkbox para confirmar confianza baja */}
                        {isLowConf && (
                          <label className="flex items-center gap-1.5 cursor-pointer group">
                            <input
                              type="checkbox"
                              checked={edit.confirmed}
                              onChange={(e) => updateEdit(row.kpi_key, { confirmed: e.target.checked })}
                              className="h-3 w-3 rounded accent-amber-400"
                            />
                            <span className={["text-[10px] transition-colors", edit.confirmed ? "text-emerald-400" : "text-amber-400"].join(" ")}>
                              {edit.confirmed ? "Confirmado" : "Confirmar valor"}
                            </span>
                          </label>
                        )}
                      </div>
                    </td>

                    {/* Nota del analista */}
                    <td className="py-2 px-4">
                      <input
                        type="text"
                        value={edit.note}
                        onChange={(e) => updateEdit(row.kpi_key, { note: e.target.value })}
                        placeholder={isViolation ? "Justificacion requerida…" : "nota opcional…"}
                        className={[
                          "w-full bg-white/5 border rounded px-2 py-1 text-xs text-[#EDEDED]",
                          "placeholder:text-[#A3A3A3]/50 focus:outline-none focus:ring-1 transition-all",
                          isViolation
                            ? "border-red-500/30 focus:ring-red-500/30"
                            : "border-white/8 focus:ring-white/15",
                        ].join(" ")}
                      />
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>

          {/* KPIs manuales */}
          <div className="p-4 border-t border-white/8">
            <button
              onClick={() => setShowManualForm((v) => !v)}
              className="flex items-center gap-2 text-xs text-[#A3A3A3] hover:text-[#EDEDED] transition-colors"
            >
              {showManualForm ? <ChevronUp className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              Agregar KPI no detectado por IA
              {manualKpis.length > 0 && (
                <span className="bg-white/10 rounded px-1.5 text-[10px]">{manualKpis.length}</span>
              )}
            </button>

            <AnimatePresence>
              {showManualForm && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    <input
                      placeholder="kpi_key (snake_case)"
                      value={manualDraft.kpi_key}
                      onChange={(e) => setManualDraft((d) => ({ ...d, kpi_key: e.target.value }))}
                      className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-[#EDEDED] placeholder:text-[#A3A3A3]/50 focus:outline-none focus:border-white/20"
                    />
                    <input
                      placeholder="Nombre del KPI"
                      value={manualDraft.kpi_label}
                      onChange={(e) => setManualDraft((d) => ({ ...d, kpi_label: e.target.value }))}
                      className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-[#EDEDED] placeholder:text-[#A3A3A3]/50 focus:outline-none focus:border-white/20"
                    />
                    <input
                      type="number"
                      placeholder="Valor"
                      value={manualDraft.value}
                      onChange={(e) => setManualDraft((d) => ({ ...d, value: e.target.value }))}
                      className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-[#EDEDED] placeholder:text-[#A3A3A3]/50 focus:outline-none focus:border-white/20 font-mono"
                    />
                    <div className="flex gap-1.5">
                      <select
                        value={manualDraft.unit}
                        onChange={(e) => setManualDraft((d) => ({ ...d, unit: e.target.value }))}
                        className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-[#EDEDED] focus:outline-none"
                      >
                        <option value="$">USD ($)</option>
                        <option value="%">Porcentaje (%)</option>
                        <option value="months">Meses</option>
                        <option value="units">Unidades</option>
                      </select>
                      <button
                        onClick={() => {
                          if (!manualDraft.kpi_key || !manualDraft.value) return;
                          setManualKpis((prev) => [...prev, { ...manualDraft }]);
                          setManualDraft({ kpi_key: "", kpi_label: "", value: "", unit: "$" });
                        }}
                        className="bg-white/10 hover:bg-white/15 border border-white/10 rounded px-2 py-1.5 text-xs text-[#EDEDED] transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {/* Lista de KPIs manuales agregados */}
                  {manualKpis.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {manualKpis.map((m, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs bg-white/4 border border-white/8 rounded px-2 py-1">
                          <span className="font-mono text-blue-400">{m.kpi_key}</span>
                          <span className="text-[#A3A3A3]">{m.kpi_label}</span>
                          <span className="ml-auto font-mono text-[#EDEDED]">{m.value} {m.unit}</span>
                          <button
                            onClick={() => setManualKpis((prev) => prev.filter((_, j) => j !== i))}
                            className="text-[#A3A3A3] hover:text-red-400 transition-colors"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* KPIs requeridos faltantes */}
          {activeCerebro.missing_required.length > 0 && (
            <div className="mx-4 mb-4 bg-amber-500/8 border border-amber-500/20 rounded-lg px-3 py-2.5">
              <p className="text-xs font-medium text-amber-400 mb-1.5">
                KPIs VC requeridos sin datos:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {activeCerebro.missing_required.map((k) => (
                  <span key={k} className="text-[10px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer con botones */}
      <div className="shrink-0 border-t border-white/8 bg-[#0A0A0A]">
        {/* Banner: empresa no encontrada en historicofund */}
        {companyNotFound && !forceApprove && (
          <div className="flex items-start gap-3 px-5 py-3 border-b border-amber-500/20 bg-amber-500/5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-amber-300 font-medium">
                {`"${companyNotFound.name}" no está en el registro histórico del fondo.`}
              </p>
              <p className="text-xs text-[#A3A3A3] mt-0.5">
                Si es una empresa nueva, puedes forzar la aprobación para certificar igualmente.
              </p>
            </div>
            <button
              onClick={() => { setForceApprove(true); setSubmitError(null); setCompanyNotFound(null); }}
              className="shrink-0 text-xs font-semibold text-amber-300 border border-amber-400/40 rounded px-3 py-1.5 hover:bg-amber-500/10 transition-colors"
            >
              Forzar aprobación
            </button>
          </div>
        )}

        {forceApprove && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-amber-500/20 bg-amber-500/5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <p className="text-xs text-amber-300 flex-1">
              Aprobación forzada activada — empresa nueva no en historicofund.
            </p>
            <button
              onClick={() => setForceApprove(false)}
              className="text-xs text-[#A3A3A3] hover:text-[#EDEDED] transition-colors"
            >
              Cancelar
            </button>
          </div>
        )}

        <div className="px-5 py-3 flex items-center justify-between">
          <button
            onClick={onCancel}
            className="text-xs text-[#A3A3A3] hover:text-[#EDEDED] transition-colors"
          >
            Cancelar
          </button>

          <div className="flex items-center gap-3">
            {submitError && !companyNotFound && (
              <p className="text-xs text-red-400 max-w-xs truncate">{submitError}</p>
            )}

            {approveBlocked && (
              <p className="text-xs text-[#A3A3A3]">
                {blockingViolations.length > 0
                  ? "Resuelve las violaciones de física antes de aprobar"
                  : "Confirma los campos con confianza baja"}
              </p>
            )}

            <motion.button
              onClick={handleApprove}
              disabled={approveBlocked || submitting}
              whileTap={{ scale: 0.97 }}
              className={[
                "flex items-center gap-2 rounded px-4 py-2 text-xs font-semibold transition-all",
                approveBlocked || submitting
                  ? "bg-white/5 text-[#A3A3A3] border border-white/8 cursor-not-allowed"
                  : forceApprove
                    ? "bg-amber-500 text-black hover:bg-amber-400 border border-amber-400/50"
                    : "bg-white text-black hover:bg-white/90 border border-white/10",
              ].join(" ")}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Certificando…
                </>
              ) : forceApprove ? (
                <>
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Forzar y Certificar
                </>
              ) : (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Aprobar y Certificar
                </>
              )}
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}
