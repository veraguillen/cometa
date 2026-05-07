/**
 * services/founder.ts — API calls for FOUNDER role.
 * Upload uses apiFetch (multipart); other calls use apiGet/apiPost per R-F1.
 */

import { apiFetch, apiPost, apiGet, apiClient } from "@/services/api-client";
import {
  uploadResponseSchema,
  finalizeResponseSchema,
  kpiMetadataResponseSchema,
  founderConfigSchema,
  processDocumentResponseSchema,
  founderStagingSchema,
  type UploadResponse,
  type FinalizeResponse,
  type KpiMetadataItem,
  type FounderStaging,
  type FounderConfig,
  type ProcessDocumentApiResponse,
} from "@/lib/schemas";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Document upload ───────────────────────────────────────────────────────────
/**
 * POST /upload — multipart form upload.
 * Returns parsed UploadResponse or throws on non-OK / schema mismatch.
 * 422 errors surface as AxiosError with data matching validationErrorSchema.
 */
export async function uploadDocument(
  file: File,
  founderEmail: string,
  companyId: string,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await apiFetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: {
      "founder-email": founderEmail,
      // FastAPI Header() convierte "company-id" → company_id en Python
      "company-id": companyId,
    },
    body: formData,
  });

  const raw: unknown = await res.json();

  if (!res.ok) {
    // Throw so ValidationModal can catch and parse 422 detail
    const err = new Error(`Upload failed: ${res.status}`);
    (err as Error & { status: number; data: unknown }).status = res.status;
    (err as Error & { status: number; data: unknown }).data = raw;
    throw err;
  }

  return uploadResponseSchema.parse(raw);
}

// ── Unified document processor — Patrón Adaptador ────────────────────────────
/**
 * POST /api/founder/process-document — Endpoint unificado para PDF y Excel.
 *
 * Envía el archivo con period_id y company_id como campos de formulario.
 * El backend extrae KPIs con Gemini, corre el Cerebro de validación,
 * escribe en BD_Cometa_Dev y devuelve ProcessDocumentApiResponse.
 *
 * Errores propagados:
 *   422 — extracción fallida o contrato inválido (Pydantic)
 *   404 — empresa no encontrada en dim_company
 *   413 — archivo demasiado grande
 *   500 — error interno del servidor
 */
export async function processDocument(
  file:      File,
  periodId:  string,
  companyId: string,
): Promise<ProcessDocumentApiResponse> {
  const formData = new FormData();
  formData.append("file",       file);
  formData.append("period_id",  periodId);
  formData.append("company_id", companyId);

  const { data } = await apiClient.post<unknown>(
    "/api/founder/process-document",
    formData,
    // Axios gestiona el Content-Type multipart/form-data automáticamente
  );

  console.log("[processDocument] Respuesta del backend:", data);
  try {
    return processDocumentResponseSchema.parse(data);
  } catch (zodErr) {
    console.error("[processDocument] Zod validation error:", zodErr);
    throw zodErr;
  }
}

// ── Finalize expediente ────────────────────────────────────────────────────────
/**
 * POST /api/founder/finalize — marks the submission set as complete,
 * sends a confirmation email, and returns a status message.
 */
export async function finalizeExpediente(body: {
  file_hashes:    string[];
  company_domain: string;
  file_names?:    string[];
  manual_kpis?:   Record<string, string>;
}): Promise<FinalizeResponse> {
  return apiPost("/api/founder/finalize", body, finalizeResponseSchema);
}

// ── KPI Metadata — dynamic KPI catalogue from dim_kpi_metadata ───────────────
/**
 * GET /api/kpi-metadata?vertical=SAAS
 * Returns KPIs for the given vertical plus GENERAL (core) KPIs.
 * Falls back to an empty array on network error so the UploadFlow degrades
 * gracefully without crashing.
 */
export async function fetchKpisByVertical(vertical: string): Promise<KpiMetadataItem[]> {
  try {
    const response = await apiGet(
      `/api/kpi-metadata?vertical=${encodeURIComponent(vertical)}`,
      kpiMetadataResponseSchema,
    );
    return response.kpis;
  } catch {
    return [];
  }
}

// ── Founder auto-config — company_id y vertical desde JWT ─────────────────────
/**
 * GET /api/founder/config — devuelve company_id y vertical auto-detectados.
 * Returns null on any error so UploadFlow falls back to manual selection.
 */
export async function fetchFounderConfig(): Promise<FounderConfig | null> {
  try {
    return await apiGet("/api/founder/config", founderConfigSchema);
  } catch {
    return null;
  }
}

// ── Staging review — KPIs en fact_kpi_staging con status PENDING ──────────────
/**
 * GET /api/founder/staging — devuelve los KPIs pendientes de revisión para la
 * empresa del founder autenticado.  La empresa se deriva del JWT en el backend.
 */
export async function fetchStagingData(): Promise<FounderStaging | null> {
  try {
    return await apiGet("/api/founder/staging", founderStagingSchema);
  } catch {
    return null;
  }
}

// ── Upload notification (fire-and-forget) ─────────────────────────────────────
/**
 * POST /api/notify/upload — optimistic email confirmation trigger.
 * Silently fails if the backend endpoint doesn't exist yet.
 */
export async function notifyUploadComplete(
  founderEmail: string,
  fileHash: string,
  companyDomain?: string,
): Promise<void> {
  try {
    await apiFetch(`${API_BASE}/api/notify/upload`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        founder_email:  founderEmail,
        file_hash:      fileHash,
        company_domain: companyDomain ?? "",
      }),
    });
  } catch {
    // Best-effort — notification failure must never block the UI
  }
}
