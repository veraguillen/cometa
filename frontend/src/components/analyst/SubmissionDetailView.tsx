"use client";

/**
 * SubmissionDetailView — Consola de Validación del Analista (v2).
 *
 * Layout split-screen:
 *   ┌── Panel Izquierdo (38%) ──────────────────┐
 *   │  Tarjeta metadatos + botón descarga        │
 *   │  Previsualización PDF inline               │
 *   └────────────────────────────────────────────┘
 *   ┌── Panel Derecho (62%) ────────────────────┐
 *   │  Tabla con columnas:                      │
 *   │    Métrica | Período | Sugerido por IA    │
 *   │    | Tu corrección | Unidad               │
 *   │                                           │
 *   │  Indicador de calidad de IA (% corregido) │
 *   │  [Guardar correcciones]  [Aprobar]         │
 *   └────────────────────────────────────────────┘
 */

import { useState, useMemo, useCallback } from "react";
import {
  Download, FileText, CheckCircle2, Save,
  Loader2, AlertTriangle, ArrowLeft, ExternalLink,
  BrainCircuit, Pencil, BarChart2,
} from "lucide-react";
import { patchSubmissionKpis } from "@/services/analyst";
import type { SubmissionDetail, SubmissionKpiRow } from "@/lib/schemas";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  submissionId: string;
  detail:       SubmissionDetail;
  onBack:       () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  const map: Record<string, string> = {
    PENDING:   "bg-yellow-900/40 text-yellow-300 border-yellow-700",
    VALIDATED: "bg-green-900/40 text-green-300 border-green-700",
    REJECTED:  "bg-red-900/40 text-red-300 border-red-700",
    CORRECTED: "bg-blue-900/40 text-blue-300 border-blue-700",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded border ${map[status] ?? "bg-neutral-800 text-neutral-300 border-neutral-700"} font-mono uppercase`}>
      {status}
    </span>
  );
}

function formatDate(iso: string) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("es-MX", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(iso));
  } catch { return iso; }
}

/** Formatea un número para mostrar en la tabla. */
function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (Number.isNaN(v)) return "—";
  return Math.abs(v) >= 1_000
    ? v.toLocaleString("es-MX", { maximumFractionDigits: 2 })
    : v.toFixed(4).replace(/\.?0+$/, "");
}

/**
 * Determina el "valor IA" a mostrar para una fila.
 * Prioriza ai_extracted_value (snapshot de Gemini); fallback a value.
 */
function aiValue(row: SubmissionKpiRow): number | null {
  return row.ai_extracted_value ?? row.value ?? null;
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function SubmissionDetailView({ submissionId, detail, onBack }: Props) {
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [saving, setSaving]           = useState(false);
  const [savedStatus, setSavedStatus] = useState<string | null>(null);
  const [error, setError]             = useState<string | null>(null);

  const kpiRows: SubmissionKpiRow[] = detail.kpis ?? [];

  const correctionKey = (row: SubmissionKpiRow) =>
    `${row.metric_id}::${row.period_id}::${row.period_start}`;

  const isDirty = useMemo(() => Object.keys(corrections).length > 0, [corrections]);

  // ── Correction rate metrics ────────────────────────────────────────────────
  // A row is "pre-corrected" if it already has a manual_correction_value from
  // a previous session. A row is "pending correction" if the analyst has
  // entered a new value in this session.
  const alreadyCorrected = useMemo(
    () => kpiRows.filter(r => r.manual_correction_value !== null && r.manual_correction_value !== undefined).length,
    [kpiRows],
  );
  const sessionCorrections = Object.keys(corrections).length;
  const totalCorrected     = alreadyCorrected + sessionCorrections;
  const correctionPct      = kpiRows.length > 0
    ? Math.round((totalCorrected / kpiRows.length) * 100)
    : 0;
  const aiAccuracyPct = 100 - correctionPct;

  // ── Input handlers ─────────────────────────────────────────────────────────

  const handleValueChange = useCallback((row: SubmissionKpiRow, raw: string) => {
    const key    = correctionKey(row);
    const ai     = aiValue(row);
    // If the user typed the same value as AI (or cleared the field), remove correction
    const parsed = parseFloat(raw);
    if (raw === "" || (!Number.isNaN(parsed) && parsed === ai)) {
      setCorrections(prev => { const n = { ...prev }; delete n[key]; return n; });
    } else {
      setCorrections(prev => ({ ...prev, [key]: raw }));
    }
  }, []);

  const buildPayload = useCallback((kpis: SubmissionKpiRow[]) =>
    kpis
      .map(row => {
        const raw = corrections[correctionKey(row)];
        if (!raw) return null;
        const val = parseFloat(raw);
        if (Number.isNaN(val)) return null;
        return { metric_id: row.metric_id, period_id: row.period_id, period_start: row.period_start, value: val };
      })
      .filter(Boolean) as Array<{ metric_id: string; period_id: string; period_start: string; value: number }>,
  [corrections]);

  async function submit(approve: boolean) {
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload(kpiRows);
      const res     = await patchSubmissionKpis(submissionId, payload, approve);
      setSavedStatus(res.status);
      setCorrections({});
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error desconocido al guardar");
    } finally {
      setSaving(false);
    }
  }

  const isPdf = (detail.source_file ?? "").toLowerCase().endsWith(".pdf")
    || (detail.download_url ?? "").toLowerCase().includes(".pdf");

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-white/8 flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
        >
          <ArrowLeft size={15} />
          Volver
        </button>
        <span className="text-white/20">|</span>
        <h2 className="text-sm font-medium text-[var(--text-main)] truncate max-w-xs">
          {detail.display_name || submissionId}
        </h2>
        {statusBadge(savedStatus ?? detail.status)}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Left panel ──────────────────────────────────────────────── */}
        <aside className="w-[38%] min-w-[260px] max-w-[340px] flex flex-col gap-4 p-5 border-r border-white/8 overflow-y-auto">

          {/* Metadata card */}
          <div className="rounded-lg border border-white/8 bg-[var(--bg-card)] p-4 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <FileText size={18} className="text-[var(--text-muted)] mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-main)] break-all leading-snug">
                  {detail.display_name || "Archivo sin nombre"}
                </p>
                <p className="text-[10px] text-[var(--text-muted)] mt-0.5 font-mono break-all leading-relaxed">
                  {detail.source_file || "—"}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div>
                <span className="text-[var(--text-muted)]">Empresa</span>
                <p className="text-[var(--text-main)] font-medium mt-0.5">{detail.company_id}</p>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">KPIs</span>
                <p className="text-[var(--text-main)] font-medium mt-0.5">{detail.kpi_count}</p>
              </div>
              <div className="col-span-2">
                <span className="text-[var(--text-muted)]">Cargado</span>
                <p className="text-[var(--text-main)] font-medium mt-0.5">{formatDate(detail.created_at)}</p>
              </div>
            </div>
          </div>

          {/* Download button */}
          {detail.download_url ? (
            <a
              href={detail.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg
                         bg-white text-black text-sm font-semibold
                         hover:bg-white/90 active:scale-[0.98] transition-all"
            >
              <Download size={14} />
              Descargar Archivo Original
            </a>
          ) : (
            <button disabled className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg
                                        border border-white/10 text-[var(--text-muted)] text-sm cursor-not-allowed">
              <Download size={14} />
              Sin URL de descarga
            </button>
          )}

          {/* ── AI quality indicator ── */}
          {kpiRows.length > 0 && (
            <div className="rounded-lg border border-white/8 bg-[var(--bg-card)] p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <BarChart2 size={13} />
                <span className="font-medium uppercase tracking-wide">Calidad de extracción IA</span>
              </div>

              {/* Progress bar */}
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[11px]">
                  <span className="flex items-center gap-1 text-[var(--text-muted)]">
                    <BrainCircuit size={11} />
                    Aceptados por IA
                  </span>
                  <span className="font-mono text-[var(--text-main)]">{aiAccuracyPct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-white transition-all duration-500"
                    style={{ width: `${aiAccuracyPct}%` }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[11px]">
                  <span className="flex items-center gap-1 text-[var(--text-muted)]">
                    <Pencil size={11} />
                    Corregidos manualmente
                  </span>
                  <span className="font-mono text-yellow-300">{correctionPct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-yellow-500/70 transition-all duration-500"
                    style={{ width: `${correctionPct}%` }}
                  />
                </div>
              </div>

              <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                {totalCorrected} de {kpiRows.length} KPIs requirieron corrección humana en este archivo.
                {correctionPct >= 30 && (
                  <span className="text-yellow-400"> Alta tasa de corrección — considera revisar el prompt de Gemini.</span>
                )}
              </p>
            </div>
          )}

          {/* Inline PDF preview */}
          {isPdf && detail.download_url && (
            <div className="flex-1 rounded-lg overflow-hidden border border-white/8 flex flex-col" style={{ minHeight: 300 }}>
              <iframe
                src={detail.download_url}
                title="Vista previa"
                className="w-full flex-1"
                style={{ minHeight: 300 }}
              />
              <a
                href={detail.download_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)]
                           px-3 py-1.5 border-t border-white/8 transition-colors flex-shrink-0"
              >
                <ExternalLink size={11} />
                Abrir en nueva pestaña
              </a>
            </div>
          )}
        </aside>

        {/* ── Right panel: editable KPI table ─────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Table */}
          <div className="flex-1 overflow-auto">
            {kpiRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-2">
                <AlertTriangle size={22} />
                <p className="text-sm">No hay KPIs registrados para esta submission.</p>
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="sticky top-0 bg-[var(--bg-primary)] border-b border-white/8 z-10">
                    <th className="text-left px-4 py-2.5 text-xs text-[var(--text-muted)] font-medium w-[28%]">
                      Métrica
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs text-[var(--text-muted)] font-medium w-[13%]">
                      Período
                    </th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium w-[20%]">
                      <span className="flex items-center justify-end gap-1 text-[var(--text-muted)]">
                        <BrainCircuit size={11} />
                        Sugerido por IA
                      </span>
                    </th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium w-[24%]">
                      <span className="flex items-center justify-end gap-1 text-[var(--text-muted)]">
                        <Pencil size={11} />
                        Tu corrección
                      </span>
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs text-[var(--text-muted)] font-medium w-[15%]">
                      Unidad
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {kpiRows.map((row) => {
                    const key          = correctionKey(row);
                    const hasCorrInput = key in corrections;
                    // A row was previously corrected if manual_correction_value is set
                    const wasCorrected = row.manual_correction_value !== null
                                      && row.manual_correction_value !== undefined;
                    const ia           = aiValue(row);
                    // Placeholder: show existing manual correction if present
                    const placeholder  = wasCorrected
                      ? String(row.manual_correction_value)
                      : fmt(ia);

                    return (
                      <tr
                        key={key}
                        className={`border-b border-white/5 transition-colors ${
                          hasCorrInput
                            ? "bg-yellow-950/30"
                            : wasCorrected
                              ? "bg-blue-950/20"
                              : "hover:bg-white/[0.025]"
                        }`}
                      >
                        {/* Metric name */}
                        <td className="px-4 py-2.5">
                          <p className="text-[var(--text-main)] font-medium leading-tight">
                            {row.metric_name || row.metric_id}
                          </p>
                          {row.metric_name && row.metric_name !== row.metric_id && (
                            <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
                              {row.metric_id}
                            </p>
                          )}
                        </td>

                        {/* Period */}
                        <td className="px-4 py-2.5">
                          <span className="text-xs font-mono text-[var(--text-muted)]">
                            {row.period_id || "—"}
                          </span>
                        </td>

                        {/* AI value */}
                        <td className="px-4 py-2.5 text-right">
                          <span className={`font-mono text-sm ${
                            wasCorrected || hasCorrInput
                              ? "line-through text-white/30"
                              : "text-[var(--text-main)]"
                          }`}>
                            {fmt(ia)}
                          </span>
                        </td>

                        {/* Correction input */}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {wasCorrected && !hasCorrInput && (
                              <Pencil size={10} className="text-blue-400 flex-shrink-0" />
                            )}
                            <input
                              type="number"
                              step="any"
                              placeholder={placeholder}
                              value={corrections[key] ?? ""}
                              onChange={e => handleValueChange(row, e.target.value)}
                              className={`w-full max-w-[110px] text-right bg-transparent border rounded px-2 py-1
                                          text-sm font-mono text-[var(--text-main)] outline-none transition-colors
                                          placeholder:text-white/20
                                          ${hasCorrInput
                                            ? "border-yellow-500/60 focus:border-yellow-400"
                                            : wasCorrected
                                              ? "border-blue-500/40 focus:border-blue-400"
                                              : "border-white/10 focus:border-white/30"
                                          }`}
                            />
                          </div>
                        </td>

                        {/* Unit */}
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-[var(--text-muted)]">{row.unit || "—"}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="border-t border-white/8 px-5 py-4 flex items-center gap-4 flex-wrap flex-shrink-0">
            {/* Change summary */}
            <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
              {isDirty ? (
                <>
                  <Pencil size={11} className="text-yellow-400" />
                  <span>
                    {sessionCorrections} cambio{sessionCorrections !== 1 ? "s" : ""} sin guardar
                  </span>
                </>
              ) : (
                <span>Sin cambios pendientes</span>
              )}
            </div>

            {/* Error / success feedback */}
            {error && (
              <p className="text-xs text-red-400 flex items-center gap-1.5">
                <AlertTriangle size={11} />
                {error}
              </p>
            )}
            {savedStatus && !isDirty && (
              <p className="text-xs text-green-400 flex items-center gap-1.5">
                <CheckCircle2 size={11} />
                Guardado — {savedStatus}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={() => submit(false)}
                disabled={saving || !isDirty}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm
                           border border-white/15 text-[var(--text-main)]
                           hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed
                           transition-colors"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Guardar correcciones
              </button>

              <button
                onClick={() => submit(true)}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold
                           bg-white text-black hover:bg-white/90
                           disabled:opacity-40 disabled:cursor-not-allowed
                           active:scale-[0.98] transition-all"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                Aprobar y Validar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
