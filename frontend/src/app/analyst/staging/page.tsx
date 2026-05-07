"use client";

/**
 * Mesa de Control — /analyst/staging
 *
 * Herramienta de auditoría profesional: el analista revisa cada batch de KPIs
 * en staging ANTES de que los datos lleguen a la tabla H (fuente de verdad).
 *
 * Layout (dos paneles):
 *   ┌── Cola (izq) ───────────┬── Auditoría (dcha) ─────────────────────────┐
 *   │  batch por batch        │  Archivo fuente  │  KPIs extraídos           │
 *   │  empresa / archivo /    │  nombre + botón  │  tabla metric/periodo/val │
 *   │  badge integridad       │  "Ver Original"  │                           │
 *   │                         ├──────────────────┴───────────────────────────┤
 *   │                         │  Aprobar ▸ tabla H   |   Rechazar             │
 *   └─────────────────────────┴──────────────────────────────────────────────┘
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  ChevronRight,
  FileSpreadsheet,
  ShieldAlert,
  ShieldCheck,
  FileX,
} from "lucide-react";
import {
  getStagingQueue,
  validateStaging,
  getStagingRawUrl,
} from "@/services/analyst";
import type { AnalystStagingBatch } from "@/lib/schemas";

// ── Helpers ─────────────────────────────────────────────────────────────────

function PhysicsBadge({ ok, notes }: { ok: boolean; notes?: string | null }) {
  if (ok) return null;
  return (
    <span
      title={notes ?? "Alerta de física de negocio"}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        background: "color-mix(in srgb, #f59e0b 10%, transparent)",
        color: "#f59e0b",
        border: "1px solid color-mix(in srgb, #f59e0b 20%, transparent)",
      }}
    >
      <AlertTriangle size={9} />
      Revisar
    </span>
  );
}

function MismatchBadge({ mismatch }: { mismatch: boolean }) {
  if (!mismatch) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
        style={{
          background: "color-mix(in srgb, #34d399 10%, transparent)",
          color: "#34d399",
          border: "1px solid color-mix(in srgb, #34d399 20%, transparent)",
        }}
      >
        <ShieldCheck size={9} /> ID Verificado
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        background: "color-mix(in srgb, #ef4444 10%, transparent)",
        color: "#f87171",
        border: "1px solid color-mix(in srgb, #ef4444 30%, transparent)",
      }}
    >
      <ShieldAlert size={9} /> ID No Coincide
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function StagingPage() {
  const [batches,         setBatches]         = useState<AnalystStagingBatch[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState<string | null>(null);
  const [selected,        setSelected]        = useState<AnalystStagingBatch | null>(null);
  const [actionLoading,   setActionLoading]   = useState(false);
  const [actionResult,    setActionResult]    = useState<{ ok: boolean; msg: string } | null>(null);
  const [fileLoading,     setFileLoading]     = useState(false);
  const [rejectNote,      setRejectNote]      = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getStagingQueue();
      setBatches(res.batches);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar la cola de staging.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  async function handleValidate(action: "VALIDATED" | "REJECTED") {
    if (!selected) return;
    if (action === "REJECTED" && !rejectNote.trim()) {
      setShowRejectInput(true);
      return;
    }
    setActionLoading(true);
    setActionResult(null);
    try {
      const res = await validateStaging({
        staging_id:     selected.staging_id,
        action,
        rejection_note: action === "REJECTED" ? rejectNote : undefined,
      });
      const promoted = res.rows_promoted;
      setActionResult({
        ok:  true,
        msg: action === "VALIDATED"
          ? `Aprobado. ${promoted} KPI${promoted !== 1 ? "s" : ""} promovidos a la tabla H.`
          : "Batch rechazado. Los datos no llegarán al dashboard.",
      });
      setShowRejectInput(false);
      setRejectNote("");
      setSelected(null);
      await loadQueue();
    } catch (err) {
      setActionResult({
        ok:  false,
        msg: err instanceof Error ? err.message : "Error al procesar la acción.",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleOpenFile() {
    if (!selected) return;
    setFileLoading(true);
    try {
      const { signed_url } = await getStagingRawUrl({ stagingId: selected.staging_id });
      window.open(signed_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo obtener la URL del archivo.");
    } finally {
      setFileLoading(false);
    }
  }

  const uniquePeriods = (batch: AnalystStagingBatch) =>
    [...new Set(batch.rows.map((r) => r.period_id))].sort().join(", ");

  const formatDate = (val: string | null | undefined) => {
    if (!val) return null;
    const n = Number(val);
    const d = isNaN(n) ? new Date(val) : new Date(n * 1000);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString("es-MX", { dateStyle: "medium" });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col gap-5 p-6 overflow-y-auto">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--cometa-fg)" }}>
            Mesa de Control
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--cometa-fg-muted)" }}>
            Audita cada carga antes de que los datos lleguen al dashboard.
          </p>
        </div>
        <button
          onClick={loadQueue}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-opacity hover:opacity-70 disabled:opacity-40 shrink-0"
          style={{ border: "1px solid var(--cometa-card-border)", color: "var(--cometa-fg-muted)" }}
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Actualizar
        </button>
      </div>

      {/* ── Action result banner ── */}
      <AnimatePresence>
        {actionResult && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-md px-4 py-3 text-sm flex items-center gap-2"
            style={{
              background: actionResult.ok
                ? "color-mix(in srgb, #34d399 10%, transparent)"
                : "color-mix(in srgb, #ef4444 10%, transparent)",
              border: `1px solid ${actionResult.ok
                ? "color-mix(in srgb, #34d399 25%, transparent)"
                : "color-mix(in srgb, #ef4444 25%, transparent)"}`,
              color: actionResult.ok ? "#34d399" : "#f87171",
            }}
          >
            {actionResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {actionResult.msg}
            <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100">✕</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Error ── */}
      {error && (
        <div
          className="rounded-md px-4 py-3 text-sm"
          style={{
            background: "color-mix(in srgb, #ef4444 8%, transparent)",
            color: "#f87171",
            border: "1px solid color-mix(in srgb, #ef4444 20%, transparent)",
          }}
        >
          {error}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && !batches.length && (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cometa-fg-muted)" }}>
          <Loader2 size={14} className="animate-spin" /> Cargando cola de staging…
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !error && batches.length === 0 && (
        <div
          className="rounded-xl p-10 text-center"
          style={{ background: "var(--cometa-card)", border: "1px solid var(--cometa-card-border)" }}
        >
          <CheckCircle2
            size={32}
            className="mx-auto mb-3"
            style={{ color: "#34d399", opacity: 0.6 }}
          />
          <p className="text-sm font-medium" style={{ color: "var(--cometa-fg)" }}>
            Cola vacía
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--cometa-fg-muted)" }}>
            No hay batches pendientes de revisión.
          </p>
        </div>
      )}

      {/* ── Two-column layout ── */}
      {batches.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

          {/* ──────── Queue list ──────── */}
          <div
            className="lg:col-span-2 rounded-xl overflow-hidden flex flex-col"
            style={{ background: "var(--cometa-card)", border: "1px solid var(--cometa-card-border)" }}
          >
            <div
              className="px-4 py-2.5 border-b text-[10px] uppercase tracking-widest"
              style={{ borderColor: "var(--cometa-card-border)", color: "var(--cometa-fg-muted)" }}
            >
              {batches.length} batch{batches.length !== 1 ? "es" : ""} pendiente{batches.length !== 1 ? "s" : ""}
            </div>

            <div className="flex-1 divide-y overflow-y-auto" style={{ divideColor: "var(--cometa-card-border)" }}>
              {batches.map((batch) => {
                const isSelected = selected?.staging_id === batch.staging_id;
                const displayName = batch.company_name || batch.company_id;
                return (
                  <button
                    key={batch.staging_id}
                    onClick={() => {
                      setSelected(batch);
                      setActionResult(null);
                      setShowRejectInput(false);
                      setRejectNote("");
                    }}
                    className="w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors"
                    style={{
                      background:   isSelected ? "color-mix(in srgb, var(--cometa-accent) 8%, transparent)" : "transparent",
                      borderLeft:   isSelected ? "2px solid var(--cometa-accent)" : "2px solid transparent",
                    }}
                  >
                    {batch.company_mismatch
                      ? <FileX size={14} style={{ flexShrink: 0, marginTop: 2, color: "#f87171" }} />
                      : <FileSpreadsheet size={14} style={{ flexShrink: 0, marginTop: 2, color: "var(--cometa-fg-muted)" }} />
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate" style={{ color: "var(--cometa-fg)" }}>
                          {displayName}
                        </p>
                        {batch.company_mismatch && (
                          <span
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0"
                            style={{
                              background: "color-mix(in srgb, #ef4444 10%, transparent)",
                              color: "#f87171",
                              border: "1px solid color-mix(in srgb, #ef4444 30%, transparent)",
                            }}
                          >
                            <ShieldAlert size={9} /> ID No Coincide
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] truncate mt-0.5" style={{ color: "var(--cometa-fg-muted)" }}>
                        {batch.filename || "archivo desconocido"}
                      </p>
                      <p className="text-[11px] mt-0.5" style={{ color: "var(--cometa-fg-muted)" }}>
                        {uniquePeriods(batch) || "período desconocido"} · {batch.kpi_count} KPIs
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0 mt-0.5">
                      <PhysicsBadge ok={batch.physics_ok} notes={batch.physics_notes} />
                      <ChevronRight size={12} style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ──────── Audit panel ──────── */}
          <div className="lg:col-span-3">
            <AnimatePresence mode="wait">
              {selected ? (
                <motion.div
                  key={selected.staging_id}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.18 }}
                  className="rounded-xl flex flex-col"
                  style={{ background: "var(--cometa-card)", border: "1px solid var(--cometa-card-border)" }}
                >
                  {/* ── Integrity alert (mismatch) ── */}
                  {selected.company_mismatch && (
                    <div
                      className="mx-5 mt-5 rounded-md px-4 py-3 text-[12px] flex items-start gap-2.5"
                      style={{
                        background: "color-mix(in srgb, #ef4444 8%, transparent)",
                        color: "#f87171",
                        border: "1px solid color-mix(in srgb, #ef4444 25%, transparent)",
                      }}
                    >
                      <ShieldAlert size={15} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold">Alerta de integridad</p>
                        <p className="mt-0.5 opacity-80">
                          La carpeta del archivo en GCS no coincide con el <strong>company_id</strong> registrado en
                          staging (<code style={{ fontSize: 11 }}>{selected.company_id}</code>).
                          Verifica el archivo antes de aprobar.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ── Physics warning ── */}
                  {!selected.physics_ok && selected.physics_notes && (
                    <div
                      className="mx-5 mt-4 rounded-md px-3 py-2.5 text-[11px] flex items-start gap-2"
                      style={{
                        background: "color-mix(in srgb, #f59e0b 8%, transparent)",
                        color: "#f59e0b",
                        border: "1px solid color-mix(in srgb, #f59e0b 20%, transparent)",
                      }}
                    >
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>{selected.physics_notes}</span>
                    </div>
                  )}

                  {/* ── Side-by-side: File info | KPI table ── */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x m-5"
                    style={{ divideColor: "var(--cometa-card-border)" }}>

                    {/* Left — File info */}
                    <div className="pb-4 md:pb-0 md:pr-5 flex flex-col gap-3">
                      <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--cometa-fg-muted)" }}>
                        Archivo fuente
                      </div>

                      {/* Filename */}
                      <div
                        className="rounded-lg px-3 py-2.5 flex items-center gap-2.5"
                        style={{
                          background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
                          border: "1px solid var(--cometa-card-border)",
                        }}
                      >
                        <FileSpreadsheet size={16} style={{ color: "var(--cometa-fg-muted)", flexShrink: 0 }} />
                        <div className="flex-1 min-w-0">
                          <p
                            className="text-[12px] font-medium truncate"
                            style={{ color: "var(--cometa-fg)" }}
                            title={selected.filename || selected.source_file || "desconocido"}
                          >
                            {selected.filename || "Nombre no disponible"}
                          </p>
                          {selected.source_file && (
                            <p
                              className="text-[10px] font-mono mt-0.5 truncate"
                              style={{ color: "var(--cometa-fg-muted)" }}
                              title={selected.source_file}
                            >
                              {selected.source_file}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Ver Original button */}
                      <button
                        onClick={handleOpenFile}
                        disabled={fileLoading || !selected.source_file}
                        className="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                        style={{ border: "1px solid var(--cometa-card-border)", color: "var(--cometa-fg)" }}
                      >
                        {fileLoading
                          ? <Loader2 size={12} className="animate-spin" />
                          : <ExternalLink size={12} />}
                        {fileLoading ? "Generando enlace…" : "Ver Original"}
                      </button>

                      {!selected.source_file && (
                        <p className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                          No hay ruta de archivo disponible para este batch.
                        </p>
                      )}

                      {/* Company metadata */}
                      <div
                        className="mt-1 rounded-lg px-3 py-2.5 space-y-1.5 text-[11px]"
                        style={{
                          background: "color-mix(in srgb, var(--cometa-fg) 3%, transparent)",
                          border: "1px solid var(--cometa-card-border)",
                        }}
                      >
                        <div className="flex justify-between gap-2">
                          <span style={{ color: "var(--cometa-fg-muted)" }}>Empresa</span>
                          <span style={{ color: "var(--cometa-fg)" }}>
                            {selected.company_name || "—"} <span className="font-mono text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>({selected.company_id})</span>
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span style={{ color: "var(--cometa-fg-muted)" }}>Enviado por</span>
                          <span style={{ color: "var(--cometa-fg)" }} className="truncate text-right">{selected.submitted_by || "—"}</span>
                        </div>
                        {selected.submitted_at && (
                          <div className="flex justify-between gap-2">
                            <span style={{ color: "var(--cometa-fg-muted)" }}>Fecha</span>
                            <span style={{ color: "var(--cometa-fg)" }}>{formatDate(selected.submitted_at) ?? "—"}</span>
                          </div>
                        )}
                        <div className="flex justify-between gap-2 pt-0.5">
                          <span style={{ color: "var(--cometa-fg-muted)" }}>Integridad</span>
                          <MismatchBadge mismatch={selected.company_mismatch} />
                        </div>
                      </div>
                    </div>

                    {/* Right — KPI table */}
                    <div className="pt-4 md:pt-0 md:pl-5 flex flex-col gap-3">
                      <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--cometa-fg-muted)" }}>
                        {selected.kpi_count} KPIs extraídos por el cerebro
                      </div>
                      <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
                        <table className="w-full text-[12px]">
                          <thead style={{ position: "sticky", top: 0, background: "var(--cometa-card)" }}>
                            <tr style={{ color: "var(--cometa-fg-muted)" }}>
                              <th className="text-left pb-2 font-normal">Métrica</th>
                              <th className="text-left pb-2 font-normal">Período</th>
                              <th className="text-right pb-2 font-normal">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selected.rows.map((row, i) => (
                              <tr
                                key={i}
                                className="border-t"
                                style={{ borderColor: "var(--cometa-card-border)" }}
                              >
                                <td
                                  className="py-1.5 font-mono text-[11px]"
                                  style={{ color: "var(--cometa-fg)" }}
                                >
                                  {row.metric_id}
                                </td>
                                <td className="py-1.5" style={{ color: "var(--cometa-fg-muted)" }}>
                                  {row.period_id}
                                </td>
                                <td
                                  className="py-1.5 text-right tabular-nums"
                                  style={{ color: "var(--cometa-fg)" }}
                                >
                                  {row.value != null ? row.value.toLocaleString("es-MX") : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* ── Action footer ── */}
                  <div
                    className="px-5 pb-5 pt-4 border-t space-y-3 mt-1"
                    style={{ borderColor: "var(--cometa-card-border)" }}
                  >
                    {showRejectInput && (
                      <textarea
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder="Motivo del rechazo (requerido)…"
                        rows={2}
                        className="w-full rounded-md px-3 py-2 text-sm resize-none outline-none"
                        style={{
                          background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
                          border:     "1px solid var(--cometa-card-border)",
                          color:      "var(--cometa-fg)",
                        }}
                      />
                    )}
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleValidate("VALIDATED")}
                        disabled={actionLoading}
                        className="flex-1 flex items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                        style={{
                          background: selected.company_mismatch
                            ? "color-mix(in srgb, var(--cometa-accent) 60%, #ef4444 40%)"
                            : "var(--cometa-accent)",
                          color: "var(--cometa-accent-fg)",
                        }}
                      >
                        {actionLoading
                          ? <Loader2 size={14} className="animate-spin" />
                          : <CheckCircle2 size={14} />}
                        {selected.company_mismatch ? "Aprobar de todos modos" : "Aprobar → tabla H"}
                      </button>
                      <button
                        onClick={() => showRejectInput ? handleValidate("REJECTED") : setShowRejectInput(true)}
                        disabled={actionLoading}
                        className="flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm transition-opacity hover:opacity-80 disabled:opacity-40"
                        style={{
                          border: "1px solid color-mix(in srgb, #ef4444 30%, transparent)",
                          color:  "#f87171",
                        }}
                      >
                        <XCircle size={14} />
                        {showRejectInput ? "Confirmar rechazo" : "Rechazar"}
                      </button>
                    </div>
                    {selected.company_mismatch && !showRejectInput && (
                      <p className="text-[11px] text-center" style={{ color: "#f87171", opacity: 0.7 }}>
                        La alerta de integridad está activa. Revisa el archivo antes de aprobar.
                      </p>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="empty-detail"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="rounded-xl flex flex-col items-center justify-center p-12 text-center"
                  style={{ background: "var(--cometa-card)", border: "1px solid var(--cometa-card-border)", minHeight: 320 }}
                >
                  <FileSpreadsheet
                    size={32}
                    className="mb-3"
                    style={{ color: "var(--cometa-fg-muted)", opacity: 0.25 }}
                  />
                  <p className="text-sm font-medium" style={{ color: "var(--cometa-fg-muted)" }}>
                    Selecciona un batch para auditarlo
                  </p>
                  <p className="text-xs mt-1" style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}>
                    Verás el archivo original y los KPIs extraídos lado a lado.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}
