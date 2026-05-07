"use client";

/**
 * /founder/staging — Vista de revisión de datos en staging.
 *
 * Muestra los KPIs que el founder acaba de subir y que están en
 * fact_kpi_staging con status='PENDING', esperando validación del analista.
 * El founder puede ver qué métricas quedaron registradas antes de que
 * el analista las mueva a fact_kpi_values.
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle, Clock, FileText, RefreshCw } from "lucide-react";
import { validateSession } from "@/services/api-client";
import { fetchStagingData } from "@/services/founder";
import type { FounderStaging, StagingBatch } from "@/lib/schemas";

function BatchCard({ batch }: { batch: StagingBatch }) {
  const [expanded, setExpanded] = useState(false);

  // Agrupar filas por period_id para display más claro
  const byPeriod = batch.rows.reduce<Record<string, typeof batch.rows>>((acc, r) => {
    const p = r.period_id || "—";
    if (!acc[p]) acc[p] = [];
    acc[p].push(r);
    return acc;
  }, {});

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-3xl p-5 flex flex-col gap-3"
      style={{
        background: "var(--cometa-card-bg, #171717)",
        border:     "1px solid var(--cometa-card-border, rgba(255,255,255,0.08))",
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Clock size={11} className="text-amber-400" />
            <span className="text-[9px] uppercase tracking-[0.18em] text-amber-400">
              Pendiente de validación
            </span>
          </div>
          <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg, #ededed)" }}>
            {batch.staging_id}
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}>
            {batch.rows.length} KPI{batch.rows.length !== 1 ? "s" : ""} ·{" "}
            {new Date(batch.submitted_at).toLocaleString("es-MX", {
              day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
            })}
          </p>
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] rounded-xl px-3 py-1.5 transition-colors"
          style={{
            background: "color-mix(in srgb, var(--cometa-fg, #ededed) 8%, transparent)",
            color:      "var(--cometa-fg-muted, #a3a3a3)",
            border:     "1px solid var(--cometa-card-border, rgba(255,255,255,0.08))",
          }}
        >
          {expanded ? "Ocultar" : "Ver KPIs"}
        </button>
      </div>

      {/* Source file */}
      {batch.source_file && (
        <div className="flex items-center gap-1.5">
          <FileText size={10} style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }} />
          <span className="text-[10px] font-mono truncate" style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}>
            {batch.source_file.replace("upload://", "")}
          </span>
        </div>
      )}

      {/* Expanded KPI table — grouped by period */}
      {expanded && (
        <div className="flex flex-col gap-3 mt-1">
          {Object.entries(byPeriod).map(([period, rows]) => (
            <div key={period}>
              <p className="text-[9px] uppercase tracking-[0.14em] mb-1.5"
                style={{ color: "var(--cometa-fg-muted, #a3a3a3)", opacity: 0.7 }}>
                Período {period}
              </p>
              <div className="flex flex-col gap-0.5">
                {rows.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-1 px-2 rounded-lg"
                    style={{ background: "color-mix(in srgb, #fff 3%, transparent)" }}
                  >
                    <span className="text-[11px] font-mono" style={{ color: "var(--cometa-fg, #ededed)" }}>
                      {r.metric_id}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums"
                      style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}>
                      {r.value !== null && r.value !== undefined
                        ? r.value.toLocaleString("es-MX", { maximumFractionDigits: 2 })
                        : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

export default function FounderStagingPage() {
  const router                     = useRouter();
  const [hydrated, setHydrated]    = useState(false);
  const [data,     setData]        = useState<FounderStaging | null>(null);
  const [loading,  setLoading]     = useState(true);
  const [error,    setError]       = useState<string | null>(null);

  useEffect(() => {
    validateSession().then((u) => {
      if (!u) {
        router.push("/login");
        return;
      }
      setHydrated(true);
      loadData();
    });
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStagingData();
      setData(result);
    } catch {
      setError("No se pudieron cargar los datos. Verifica tu conexión e intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  if (!hydrated) return null;

  const totalBatches = data?.batches.length ?? 0;
  const totalKpis    = data?.total_rows   ?? 0;

  return (
    <div className="min-h-screen" style={{ background: "var(--cometa-bg, #0a0a0a)" }}>

      {/* Header */}
      <header
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b px-6"
        style={{
          borderColor:    "var(--cometa-card-border, rgba(255,255,255,0.08))",
          background:     "color-mix(in srgb, var(--cometa-bg, #0a0a0a) 88%, transparent)",
          backdropFilter: "blur(20px)",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/founder/onboarding")}
            className="flex items-center gap-1.5 text-[12px] transition-colors"
            style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}
          >
            <ArrowLeft size={14} />
            Volver
          </button>
          <span style={{ color: "var(--cometa-card-border, rgba(255,255,255,0.08))" }}>|</span>
          <span className="text-[12px]" style={{ color: "var(--cometa-fg, #ededed)" }}>
            Revisión de datos
          </span>
        </div>

        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] transition-colors"
          style={{
            background: "color-mix(in srgb, var(--cometa-fg, #ededed) 6%, transparent)",
            color:      "var(--cometa-fg-muted, #a3a3a3)",
            border:     "1px solid var(--cometa-card-border, rgba(255,255,255,0.08))",
          }}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Actualizar
        </button>
      </header>

      {/* Body */}
      <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-6">

        {/* Title + summary */}
        <div>
          <h1 className="text-2xl font-extralight mb-1" style={{ color: "var(--cometa-fg, #ededed)" }}>
            Datos en revisión
          </h1>
          <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}>
            Estos KPIs ya están en BigQuery (fact_kpi_staging) y esperan validación
            del analista de Cometa antes de aparecer en el dashboard.
          </p>
        </div>

        {/* Stats bar */}
        {data && (
          <div
            className="grid grid-cols-2 gap-3 rounded-2xl p-4"
            style={{
              background: "color-mix(in srgb, #4ade80 6%, transparent)",
              border:     "1px solid color-mix(in srgb, #4ade80 20%, transparent)",
            }}
          >
            <div>
              <p className="text-[9px] uppercase tracking-[0.18em] mb-0.5 text-emerald-400">
                Cargas pendientes
              </p>
              <p className="text-2xl font-light text-emerald-400">{totalBatches}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-[0.18em] mb-0.5 text-emerald-400">
                KPIs en staging
              </p>
              <p className="text-2xl font-light text-emerald-400">{totalKpis}</p>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-12"
            style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}>
            <RefreshCw size={14} className="animate-spin" />
            <span className="text-[12px]">Cargando datos de staging…</span>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div
            className="rounded-2xl p-4 text-[12px]"
            style={{
              background: "color-mix(in srgb, #ef4444 8%, transparent)",
              border:     "1px solid color-mix(in srgb, #ef4444 25%, transparent)",
              color:      "#ef4444",
            }}
          >
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && totalBatches === 0 && (
          <div className="flex flex-col items-center gap-3 py-12">
            <CheckCircle size={32} className="text-emerald-400 opacity-40" />
            <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted, #a3a3a3)" }}>
              No hay datos pendientes de revisión.
            </p>
            <p className="text-[11px]" style={{ color: "var(--cometa-fg-muted, #a3a3a3)", opacity: 0.6 }}>
              Una vez que subas un archivo, aparecerá aquí antes de ser validado.
            </p>
          </div>
        )}

        {/* Batch list */}
        {!loading && data && data.batches.map((batch) => (
          <BatchCard key={batch.staging_id} batch={batch} />
        ))}

        {/* CTA: upload more */}
        <button
          onClick={() => router.push("/founder/onboarding")}
          className="w-full rounded-2xl py-3 text-[12px] font-medium transition-colors"
          style={{
            background: "color-mix(in srgb, var(--cometa-fg, #ededed) 6%, transparent)",
            color:      "var(--cometa-fg-muted, #a3a3a3)",
            border:     "1px solid var(--cometa-card-border, rgba(255,255,255,0.08))",
          }}
        >
          Subir otro documento
        </button>
      </div>
    </div>
  );
}
