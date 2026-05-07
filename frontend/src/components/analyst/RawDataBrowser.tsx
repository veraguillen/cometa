"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText, AlertTriangle, CheckCircle2, XCircle,
  Eye, RefreshCw, Database, Loader2, ScanLine,
  BadgeCheck, Building2, Calendar, ShieldCheck, ChevronRight,
} from "lucide-react";
import { apiClient } from "@/services/api-client";
import { bucketListResponseSchema, type BucketFile } from "@/lib/schemas";
import type { CerebroResult } from "@/lib/schemas";
import { confirmGold, getStagingRawUrl } from "@/services/analyst";

// ── Layer tabs ────────────────────────────────────────────────────────────────

type LayerId = "stage" | "raw" | "vault" | "gold" | "historicofund" | "pending";

const LAYERS: { id: LayerId; label: string; hint: string; bucketTag: string }[] = [
  { id: "pending",       label: "Excel/CSV",   hint: "Archivos Excel/CSV pendientes de aprobación del analista → BQ",  bucketTag: "stage-bucket · pending_mapper/" },
  { id: "raw",           label: "Origen",      hint: "Archivos originales subidos por founders (nunca se borran)",      bucketTag: "raw-bucket (cometa-vc-raw-prod)" },
  { id: "stage",         label: "Extracción",  hint: "JSONs de Gemini, resultados de IA pendientes de revisión",        bucketTag: "stage-bucket · stage/" },
  { id: "vault",         label: "Vault",       hint: "JSONs de resultados procesados (vault/) listos para el analista", bucketTag: "stage-bucket · vault/" },
  { id: "gold",          label: "Certificado", hint: "KPIs aprobados y escritos en BigQuery",                           bucketTag: "gold-bucket (cometa-vc-gold-prod)" },
  { id: "historicofund", label: "Histórico",   hint: "CSV maestro del fondo (CIII)",                                   bucketTag: "hist-bucket (historicofund)" },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function LayerPill({ active, layer, onClick }: {
  active: boolean; layer: typeof LAYERS[0]; onClick: () => void;
}) {
  const colors: Record<LayerId, string> = {
    pending:       "#f97316",
    raw:           "#60a5fa",   // azul — archivos originales
    stage:         "#fbbf24",
    vault:         "#e2a64f",   // ámbar oscuro — vault results
    gold:          "#4ade80",
    historicofund: "#818cf8",
  };
  const accent = colors[layer.id];
  return (
    <button
      onClick={onClick}
      title={layer.hint}
      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-all duration-150"
      style={{
        background: active ? `${accent}18` : "rgba(255,255,255,0.03)",
        color:      active ? accent        : "#475569",
        border:     `1px solid ${active ? `${accent}55` : "rgba(255,255,255,0.06)"}`,
        fontWeight: active ? 500 : 400,
      }}
    >
      {layer.label}
    </button>
  );
}

/** Small pill that shows which bucket/prefix the file comes from. */
function BucketSourceTag({ layerId }: { layerId: LayerId }) {
  const layer = LAYERS.find((l) => l.id === layerId);
  if (!layer) return null;
  const colors: Record<LayerId, string> = {
    pending:       "#f97316",
    raw:           "#60a5fa",
    stage:         "#fbbf24",
    vault:         "#e2a64f",
    gold:          "#4ade80",
    historicofund: "#818cf8",
  };
  const color = colors[layerId];
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-mono font-medium"
      style={{ color, background: `${color}14`, border: `1px solid ${color}33` }}
      title={layer.bucketTag}
    >
      {layer.bucketTag.split(" ")[0]}
    </span>
  );
}

function CompanyBadge({ file }: { file: BucketFile }) {
  if (file.company_found) {
    return (
      <span
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider font-medium"
        style={{ color: "#4ade80", background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.22)" }}
        title={`Nombre oficial: ${file.official_name}`}
      >
        <BadgeCheck size={9} />
        {file.official_name || file.company_slug}
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider font-medium"
      style={{ color: "#fbbf24", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.22)" }}
      title="Empresa no encontrada en historicofund"
    >
      <Building2 size={9} />
      {file.company_slug || "desconocida"}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

// ── FileDetailPanel ───────────────────────────────────────────────────────────

function FileDetailPanel({
  file,
  loading,
  onReview,
}: {
  file: BucketFile;
  loading: boolean;
  onReview: () => void;
}) {
  const isStage = file.layer === "stage";
  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium break-all" style={{ color: "#e2e8f0" }}>
          {file.name.split("/").pop()}
        </h3>
        <p className="text-[10px] font-mono break-all" style={{ color: "#334155" }}>
          gs://{file.uri.replace("gs://", "")}
        </p>
      </div>

      {/* Metadata grid */}
      <div
        className="grid gap-px rounded-xl overflow-hidden text-[11px]"
        style={{ border: "1px solid #0f172a", gridTemplateColumns: "1fr 1fr" }}
      >
        {[
          { label: "Empresa",     value: <CompanyBadge file={file} /> },
          { label: "Capa",        value: file.layer },
          { label: "Tamaño",      value: formatBytes(file.size_bytes) },
          { label: "Actualizado", value: formatDate(file.updated_at) },
          { label: "Load ID",     value: file.load_id || "—" },
          { label: "Slug",        value: file.company_slug || "—" },
        ].map(({ label, value }) => (
          <div key={label} className="px-4 py-3" style={{ background: "rgba(255,255,255,0.015)" }}>
            <p className="text-[9px] uppercase tracking-widest mb-1" style={{ color: "#334155" }}>{label}</p>
            {typeof value === "string" ? (
              <p className="font-mono truncate" style={{ color: "#94a3b8" }}>{value}</p>
            ) : (
              value
            )}
          </div>
        ))}
      </div>

      {/* Company match alert */}
      {!file.company_found && (
        <div
          className="flex items-start gap-2 rounded-lg px-4 py-3"
          style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.25)" }}
        >
          <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: "#fbbf24" }} />
          <p className="text-[11px] leading-snug" style={{ color: "#fbbf24" }}>
            Empresa &ldquo;{file.company_slug}&rdquo; no encontrada en el CSV de historicofund.
            Verifica el nombre antes de aprobar.
          </p>
        </div>
      )}

      {/* Action */}
      {isStage && (
        <button
          onClick={onReview}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
          style={{ color: "#fff", background: "#00237F", border: "1px solid #00237F" }}
        >
          {loading ? (
            <><Loader2 size={13} className="animate-spin" />Abriendo…</>
          ) : file.name.toLowerCase().endsWith(".json") ? (
            <><Eye size={13} />Revisar con IA — Abrir Cerebro</>
          ) : (
            <><Eye size={13} />Ver archivo original</>
          )}
        </button>
      )}

      {file.layer === "gold" && (
        <div
          className="flex items-center gap-2 rounded-lg px-4 py-3"
          style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.2)" }}
        >
          <CheckCircle2 size={12} style={{ color: "#4ade80" }} />
          <span className="text-[11px]" style={{ color: "#4ade80" }}>
            KPIs certificados y escritos en BigQuery (cometa_portfolio)
          </span>
        </div>
      )}
    </div>
  );
}

// ── ConfirmGoldPanel — formulario para archivos pending (Excel/CSV) ────────────

/**
 * Parses a pending_mapper blob name like:
 *   "pending_mapper/{company_slug}/{load_id32}_{safe_filename}"
 * Returns { loadId, filename } extracted from the blob path.
 */
function parsePendingBlob(blobName: string): { loadId: string; filename: string } {
  // blobName = "pending_mapper/{slug}/{load_id}_{filename}"
  const tail = blobName.replace(/^pending_mapper\/[^/]+\//, "");
  const loadId   = tail.slice(0, 32);
  const filename = tail.slice(33); // skip the underscore after UUID
  return { loadId, filename };
}

function ConfirmGoldPanel({ file }: { file: BucketFile }) {
  const { loadId, filename } = parsePendingBlob(file.name);

  const [companyName, setCompanyName] = useState(file.company_slug.toUpperCase());
  const [periodStr,   setPeriodStr]   = useState("");
  const [sector,      setSector]      = useState("ALL");
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [success,     setSuccess]     = useState<{ rows: number; gold_uri: string } | null>(null);

  const handleConfirm = async () => {
    if (!periodStr.match(/^20\d{2}-(0[1-9]|1[0-2])$/)) {
      setError("Formato de período inválido. Usa YYYY-MM, ej. 2025-03");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await confirmGold({
        load_id:      loadId,
        filename,
        company_slug: file.company_slug,
        company_name: companyName,
        period_str:   periodStr,
        sector,
      });
      setSuccess({ rows: res.rows_inserted + res.rows_updated, gold_uri: res.gold_uri });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al confirmar");
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="p-6 space-y-4">
        <div
          className="flex items-start gap-3 rounded-xl px-4 py-4"
          style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.2)" }}
        >
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" style={{ color: "#4ade80" }} />
          <div className="space-y-1">
            <p className="text-[13px] font-medium" style={{ color: "#4ade80" }}>
              Confirmado — {success.rows} KPIs escritos en BigQuery
            </p>
            <p className="text-[10px] font-mono break-all" style={{ color: "#334155" }}>
              {success.gold_uri}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium break-all" style={{ color: "#e2e8f0" }}>
          {filename}
        </h3>
        <p className="text-[10px] font-mono" style={{ color: "#334155" }}>
          load_id: {loadId}
        </p>
      </div>

      {/* Metadata */}
      <div
        className="grid gap-px rounded-xl overflow-hidden text-[11px]"
        style={{ border: "1px solid #0f172a", gridTemplateColumns: "1fr 1fr" }}
      >
        {[
          { label: "Empresa",     value: <CompanyBadge file={file} /> },
          { label: "Tamaño",      value: formatBytes(file.size_bytes) },
          { label: "Subido",      value: formatDate(file.updated_at) },
        ].map(({ label, value }) => (
          <div key={label} className="px-4 py-3" style={{ background: "rgba(255,255,255,0.015)" }}>
            <p className="text-[9px] uppercase tracking-widest mb-1" style={{ color: "#334155" }}>{label}</p>
            {typeof value === "string" ? (
              <p className="font-mono truncate" style={{ color: "#94a3b8" }}>{value}</p>
            ) : value}
          </div>
        ))}
      </div>

      {/* Confirm form */}
      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest font-medium" style={{ color: "#475569" }}>
          Detalles para certificar
        </p>

        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px]" style={{ color: "#475569" }}>Nombre empresa</span>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Ej. SIMETRIK"
              className="mt-1 w-full rounded-lg px-3 py-2 text-[12px] font-mono focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#e2e8f0",
              }}
            />
          </label>

          <label className="block">
            <span className="text-[10px]" style={{ color: "#475569" }}>Período (YYYY-MM)</span>
            <input
              type="text"
              value={periodStr}
              onChange={(e) => setPeriodStr(e.target.value)}
              placeholder="2025-03"
              className="mt-1 w-full rounded-lg px-3 py-2 text-[12px] font-mono focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: `1px solid ${error && !periodStr ? "rgba(248,113,113,0.4)" : "rgba(255,255,255,0.08)"}`,
                color: "#e2e8f0",
              }}
            />
          </label>

          <label className="block">
            <span className="text-[10px]" style={{ color: "#475569" }}>Sector</span>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="mt-1 w-full rounded-lg px-3 py-2 text-[12px] focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#e2e8f0",
              }}
            >
              <option value="ALL">ALL (General)</option>
              <option value="SAAS_SUBSCRIPTION">SaaS / Suscripción</option>
              <option value="FINTECH">Fintech</option>
              <option value="MARKETPLACE">Marketplace</option>
              <option value="INSURTECH">InsurTech</option>
            </select>
          </label>
        </div>

        {error && (
          <div
            className="flex items-start gap-2 rounded-lg px-3 py-2.5"
            style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.25)" }}
          >
            <XCircle size={11} className="shrink-0 mt-0.5" style={{ color: "#f87171" }} />
            <p className="text-[11px]" style={{ color: "#f87171" }}>{error}</p>
          </div>
        )}

        <button
          onClick={handleConfirm}
          disabled={submitting || !periodStr}
          className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ color: "#fff", background: "#f97316", border: "1px solid #f97316" }}
        >
          {submitting ? (
            <><Loader2 size={13} className="animate-spin" />Certificando…</>
          ) : (
            <><ShieldCheck size={13} />Confirmar Gold → BigQuery</>
          )}
        </button>
      </div>
    </div>
  );
}

// ── StageReviewData (passed to onApprove) ─────────────────────────────────────

export interface StageReviewData {
  loadId:        string;
  slug:          string;
  periodo:       string;
  sourceFileUri: string;
  analystId:     string;
  currency:      string;
  cerebroResult: CerebroResult;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface RawDataBrowserProps {
  analystId?: string;
  onApprove?: (data: StageReviewData) => void;
}

export default function RawDataBrowser({ analystId = "ANA-000000", onApprove }: RawDataBrowserProps) {
  const [activeLayer,   setActiveLayer]   = useState<LayerId>("stage");
  const [files,         setFiles]         = useState<BucketFile[]>([]);
  const [loadingList,   setLoadingList]   = useState(false);
  const [listError,     setListError]     = useState<string | null>(null);
  const [listWarning,   setListWarning]   = useState<string | null>(null);
  const [selectedFile,  setSelectedFile]  = useState<BucketFile | null>(null);
  const [loadingReview, setLoadingReview] = useState(false);
  const [reviewError,   setReviewError]   = useState<string | null>(null);
  // Inline Cerebro result — populated automatically when a JSON stage file is selected.
  // The user sees the KPI table in the right panel without leaving this view.
  // Clicking "Abrir Revisión Completa" promotes to the full KpiReviewPanel via onApprove.
  const [inlineReview,  setInlineReview]  = useState<StageReviewData | null>(null);

  const fetchFiles = useCallback(async (layer: LayerId) => {
    setLoadingList(true);
    setListError(null);
    setSelectedFile(null);
    try {
      const { data } = await apiClient.get<unknown>("/api/analyst/buckets", {
        params: { layer, limit: 100 },
      });
      const parsed = bucketListResponseSchema.parse(data);
      setFiles(parsed.files);
      setListWarning(parsed.warning ?? null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al cargar la lista de archivos";
      setListError(msg);
      setListWarning(null);
      setFiles([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles(activeLayer);
  }, [activeLayer, fetchFiles]);

  // Runs Cerebro for the given file and stores the result inline.
  // Called automatically on JSON click AND manually via the button for non-auto cases.
  async function runCerebroForFile(file: BucketFile) {
    if (loadingReview) return;
    setLoadingReview(true);
    setReviewError(null);
    setInlineReview(null);
    try {
      const { data } = await apiClient.get<unknown>("/api/analyst/stage-review", {
        params: { gcs_uri: file.uri },
      });
      const cerebro = data as CerebroResult;
      setInlineReview({
        loadId:        (cerebro as Record<string, unknown>).load_id as string || file.load_id,
        slug:          (cerebro as Record<string, unknown>).slug    as string || file.company_slug,
        periodo:       (cerebro as Record<string, unknown>).periodo  as string || "",
        sourceFileUri: file.uri,
        analystId,
        currency:      "USD",
        cerebroResult: cerebro,
      });
    } catch (err: unknown) {
      setReviewError(err instanceof Error ? err.message : "Error al cargar datos del stage");
    } finally {
      setLoadingReview(false);
    }
  }

  // Button handler — for non-JSON files opens the file directly via signed URL.
  async function handleReview() {
    if (!selectedFile || loadingReview) return;
    const isJson = selectedFile.name.toLowerCase().endsWith(".json");
    if (!isJson) {
      setLoadingReview(true);
      setReviewError(null);
      try {
        const { signed_url } = await getStagingRawUrl({ gcsUri: selectedFile.uri });
        window.open(signed_url, "_blank", "noopener,noreferrer");
      } catch (err: unknown) {
        setReviewError(err instanceof Error ? err.message : "No se pudo obtener la URL del archivo");
      } finally {
        setLoadingReview(false);
      }
      return;
    }
    await runCerebroForFile(selectedFile);
  }

  const pendingCount = files.length;

  return (
    <div className="flex flex-col h-full">

      {/* ── Top bar ── */}
      <div
        className="shrink-0 flex items-center justify-between gap-4 px-5 py-3 border-b flex-wrap"
        style={{ borderColor: "#0f172a" }}
      >
        {/* Layer tabs */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {LAYERS.map((layer) => (
            <LayerPill
              key={layer.id}
              layer={layer}
              active={activeLayer === layer.id}
              onClick={() => setActiveLayer(layer.id)}
            />
          ))}
        </div>

        {/* Refresh + stats */}
        <div className="flex items-center gap-2 shrink-0">
          {(activeLayer === "stage" || activeLayer === "pending") && pendingCount > 0 && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full"
              style={{ color: "#fbbf24", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.25)" }}
            >
              <Calendar size={9} />
              {pendingCount} pendiente{pendingCount !== 1 ? "s" : ""}
            </span>
          )}
          <button
            onClick={() => fetchFiles(activeLayer)}
            disabled={loadingList}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ color: "#475569", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <RefreshCw size={11} className={loadingList ? "animate-spin" : ""} />
            Actualizar
          </button>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-col lg:flex-row flex-1 overflow-hidden">

        {/* File list */}
        <div
          className="shrink-0 flex flex-col overflow-y-auto scrollbar-thin border-b lg:border-b-0 lg:border-r"
          style={{ width: "100%", maxWidth: "300px", borderColor: "#0f172a" }}
        >
          {/* GCS access warning (non-fatal) */}
          {listWarning && (
            <div
              className="mx-3 mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5"
              style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.25)" }}
            >
              <AlertTriangle size={11} className="shrink-0 mt-0.5" style={{ color: "#fbbf24" }} />
              <p className="text-[10px] leading-snug" style={{ color: "#fbbf24" }}>{listWarning}</p>
            </div>
          )}

          {loadingList ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 size={20} className="animate-spin" style={{ color: "#334155" }} />
              <p className="text-[12px]" style={{ color: "#334155" }}>Cargando archivos…</p>
            </div>
          ) : listError ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 px-6 text-center">
              <XCircle size={20} style={{ color: "#f87171" }} />
              <p className="text-[12px]" style={{ color: "#f87171" }}>{listError}</p>
              <button
                onClick={() => fetchFiles(activeLayer)}
                className="text-[11px] underline"
                style={{ color: "#475569" }}
              >
                Reintentar
              </button>
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Database size={20} style={{ color: "#1e293b" }} />
              <p className="text-[12px]" style={{ color: "#334155" }}>
                Sin archivos en la capa {activeLayer}
              </p>
            </div>
          ) : (
            files.map((file) => {
              const isSelected = selectedFile?.uri === file.uri;
              const fname      = file.name.split("/").pop() ?? file.name;
              return (
                <button
                  key={file.uri}
                  onClick={() => {
                    setSelectedFile(file);
                    setReviewError(null);
                    setInlineReview(null);
                    // Auto-load Cerebro only for JSON stage/vault files.
                    // Raw layer = original files (PDF/XLSX) — never run Cerebro on them.
                    const isJson = file.name.toLowerCase().endsWith(".json");
                    if (isJson && (file.layer === "stage" || file.layer === "vault")) {
                      runCerebroForFile(file);
                    }
                  }}
                  className="text-left px-4 py-3 border-b transition-all duration-100"
                  style={{
                    borderColor: "#0a0f1a",
                    background:  isSelected ? "rgba(0,35,127,0.12)" : "rgba(255,255,255,0.01)",
                    borderLeft:  `3px solid ${isSelected ? "#00237F" : "transparent"}`,
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <FileText
                      size={13}
                      className="shrink-0 mt-0.5"
                      style={{ color: file.company_found ? "#4ade80" : "#fbbf24" }}
                    />
                    <div className="flex-1 min-w-0">
                      <p
                        className="truncate text-[12px]"
                        style={{ color: isSelected ? "#ffffff" : "#94a3b8", fontWeight: isSelected ? 500 : 400 }}
                      >
                        {fname}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <BucketSourceTag layerId={file.layer as LayerId} />
                        <span className="text-[10px]" style={{ color: "#334155" }}>
                          {file.official_name || file.company_slug || "sin empresa"}
                        </span>
                        {file.updated_at && (
                          <>
                            <span style={{ color: "#1e293b" }}>·</span>
                            <span className="font-mono text-[10px]" style={{ color: "#334155" }}>
                              {formatDate(file.updated_at)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <AnimatePresence mode="wait">
            {!selectedFile ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex h-full flex-col items-center justify-center gap-4"
                style={{ minHeight: "300px" }}
              >
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-2xl"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.08)" }}
                >
                  <ScanLine size={28} style={{ color: "#334155" }} />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-[14px] font-medium" style={{ color: "#475569" }}>
                    Selecciona un archivo para ver detalles
                  </p>
                  <p className="text-[11px]" style={{ color: "#1e293b" }}>
                    {activeLayer === "pending"
                      ? "Archivos Excel/CSV listos para confirmar. Completa los detalles y envía a Gold."
                      : activeLayer === "raw"
                      ? "Archivos originales subidos por founders (PDF, XLSX). Permanentes para auditoría."
                      : (activeLayer === "stage" || activeLayer === "vault")
                      ? "Los archivos JSON pueden abrirse en el Cerebro para revisión automática"
                      : "Explora los artefactos del pipeline Medallion"}
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key={selectedFile.uri}
                initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {selectedFile.layer === "pending" ? (
                  <ConfirmGoldPanel file={selectedFile} />
                ) : (
                  <>
                    {/* Loading spinner while Cerebro runs automatically */}
                    {loadingReview && (
                      <div className="flex items-center justify-center gap-3 py-16">
                        <Loader2 size={18} className="animate-spin" style={{ color: "#334155" }} />
                        <span className="text-[12px]" style={{ color: "#334155" }}>Analizando con Cerebro…</span>
                      </div>
                    )}

                    {/* Inline KPI review panel — shown when Cerebro result is ready */}
                    {!loadingReview && inlineReview && inlineReview.sourceFileUri === selectedFile.uri && (
                      <div className="p-5 space-y-4">
                        {/* Header */}
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[12px] font-medium" style={{ color: "#e2e8f0" }}>
                              {selectedFile.name.split("/").pop()}
                            </p>
                            <p className="text-[10px] mt-0.5" style={{ color: "#475569" }}>
                              {inlineReview.slug} · {inlineReview.periodo || "período no detectado"}
                            </p>
                          </div>
                          {onApprove && (
                            <button
                              onClick={() => onApprove(inlineReview)}
                              className="shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-opacity hover:opacity-80"
                              style={{ background: "#00237F", color: "#fff", border: "1px solid #00237F" }}
                            >
                              <Eye size={11} />
                              Revisión Completa
                            </button>
                          )}
                        </div>

                        {/* Physics violation alert */}
                        {inlineReview.cerebroResult.has_physics_violations && (
                          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5"
                            style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.25)" }}>
                            <AlertTriangle size={11} className="shrink-0 mt-0.5" style={{ color: "#f87171" }} />
                            <p className="text-[11px]" style={{ color: "#f87171" }}>
                              {inlineReview.cerebroResult.violations.join(" · ")}
                            </p>
                          </div>
                        )}

                        {/* KPI mini-table */}
                        <div className="rounded-xl overflow-hidden"
                          style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                          <div className="px-3 py-2 text-[9px] uppercase tracking-widest"
                            style={{ background: "rgba(255,255,255,0.02)", color: "#334155", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                            {inlineReview.cerebroResult.enriched_rows.length} KPIs extraídos
                          </div>
                          <div className="max-h-64 overflow-y-auto scrollbar-thin">
                            <table className="w-full text-[11px]">
                              <tbody>
                                {inlineReview.cerebroResult.enriched_rows.map((row, i) => (
                                  <tr key={i} className="border-b" style={{ borderColor: "rgba(255,255,255,0.03)" }}>
                                    <td className="px-3 py-1.5 font-mono" style={{ color: "#94a3b8" }}>
                                      {row.kpi_label ?? row.kpi_key}
                                    </td>
                                    <td className="px-3 py-1.5 text-right tabular-nums"
                                      style={{ color: row.physics_violation ? "#f87171" : "#e2e8f0" }}>
                                      {row.numeric_value != null
                                        ? `${row.numeric_value.toLocaleString("es-MX")}${row.unit ? ` ${row.unit}` : ""}`
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* FileDetailPanel — for non-JSON files or when inline result not yet loaded */}
                    {!loadingReview && !inlineReview && (
                      <FileDetailPanel
                        file={selectedFile}
                        loading={loadingReview}
                        onReview={handleReview}
                      />
                    )}

                    {reviewError && (
                      <div
                        className="mx-6 mb-4 flex items-start gap-2 rounded-lg px-4 py-3"
                        style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.25)" }}
                      >
                        <XCircle size={12} className="shrink-0 mt-0.5" style={{ color: "#f87171" }} />
                        <p className="text-[11px]" style={{ color: "#f87171" }}>{reviewError}</p>
                      </div>
                    )}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </div>
    </div>
  );
}
