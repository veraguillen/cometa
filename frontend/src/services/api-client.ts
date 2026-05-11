/**
 * services/api-client.ts — Canonical location.
 * This is the authoritative Axios client for Cometa Pipeline.
 *
 * Interceptors:
 *   - Request  → attaches JWT Bearer token from localStorage
 *   - Response → clears session and redirects to /login on 401
 *
 * Helpers:
 *   - loginWithCredentials()  POST /api/login, validates with Zod, persists JWT + cookie
 *   - loginWithGoogle()       POST /api/auth/google, Google ID token → JWT, persists session
 *   - validateSession()       GET  /api/me, validates with Zod
 *   - apiGet / apiPost        Zero-Trust wrappers — Zod schema is structurally required
 *   - apiFetch                Legacy fetch shim for components not yet migrated to Axios
 */

import axios from "axios";
import { z } from "zod";
import {
  loginResponseSchema,
  meResponseSchema,
  type LoginResponse,
  type UserInfo,
} from "@/lib/schemas";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const TOKEN_KEY   = "cometa_jwt";
export const SESSION_KEY = "cometa_user_session";

// ── Instancia Axios ───────────────────────────────────────────────────────────
export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
  withCredentials: false,
});

// ── Interceptor de petición: añade Bearer token + header de origen ────────────
// X-Cometa-Source es requerido por _verify_origin en el backend para endpoints
// que no usan Cloud IAP (chat, stream). Sin él el backend devuelve 403.
apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      config.headers["Authorization"] = `Bearer ${token}`;
    }
  }
  config.headers["X-Cometa-Source"] = "analyst-portal";
  // FormData: eliminar el Content-Type por defecto (application/json) para que
  // el navegador lo genere como multipart/form-data con el boundary correcto.
  if (config.data instanceof FormData) {
    delete config.headers["Content-Type"];
  }
  return config;
});

// ── Interceptor de respuesta: maneja 401 ──────────────────────────────────────
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== "undefined") {
      clearSession();
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

// ── Tipos re-exportados desde schemas.ts ──────────────────────────────────────
export type { UserInfo, LoginResponse };

// ── Helpers de sesión ─────────────────────────────────────────────────────────
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
  // Clear routing cookie
  document.cookie = "cometa_user_id=; path=/; max-age=0";
}

// ── loginWithCredentials ──────────────────────────────────────────────────────
/**
 * POST /api/login → validates with loginResponseSchema → persists JWT + routing cookie.
 * Throws ZodError on unexpected backend shape — never silences.
 */
export async function loginWithCredentials(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const parsed = await apiPost("/api/login", { email, password }, loginResponseSchema);
  // Purge any stale session before writing the new one.
  // Without this, a JWT minted before a users.json update (e.g. old company_id)
  // would stay in localStorage until the browser is manually cleared.
  clearSession();
  localStorage.setItem(TOKEN_KEY, parsed.access_token);
  // Set routing cookie (read by Next.js middleware)
  document.cookie = `cometa_user_id=${parsed.user.user_id}; path=/; max-age=86400; SameSite=Lax`;
  return parsed;
}

// ── loginWithGoogle ────────────────────────────────────────────────────────────
/**
 * POST /api/auth/google → validates with loginResponseSchema → persists JWT + cookie.
 * The idToken comes from Google Identity Services (GIS) credential callback.
 * Backend enforces @cometa.vc domain — throws 403 for any other account.
 */
export async function loginWithGoogle(idToken: string): Promise<LoginResponse> {
  const parsed = await apiPost("/api/auth/google", { id_token: idToken }, loginResponseSchema);
  clearSession();
  localStorage.setItem(TOKEN_KEY, parsed.access_token);
  document.cookie = `cometa_user_id=${parsed.user.user_id}; path=/; max-age=86400; SameSite=Lax`;
  return parsed;
}

// ── validateSession ───────────────────────────────────────────────────────────
/**
 * GET /api/me → validates with meResponseSchema → returns UserInfo or null.
 * Clears session if token expired, missing or shape invalid.
 */
export async function validateSession(): Promise<UserInfo | null> {
  if (!getToken()) return null;
  try {
    return await apiGet("/api/me", meResponseSchema);
  } catch {
    clearSession();
    return null;
  }
}

// ── Zero Trust helpers — parse estructuralmente obligatorio ───────────────────
/**
 * All new API calls MUST go through apiGet or apiPost.
 * The `schema` parameter makes Zod .parse() structurally required by TypeScript.
 *
 * Rule R-F1: never use apiClient.get/post directly in new code.
 */

export async function apiGet<T>(
  url: string,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const { data } = await apiClient.get<unknown>(url);
  return schema.parse(data);
}

export async function apiPost<T>(
  url: string,
  body: unknown,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const { data } = await apiClient.post<unknown>(url, body);
  return schema.parse(data);
}

export async function apiPut<T>(
  url: string,
  body: unknown,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const { data } = await apiClient.put<unknown>(url, body);
  return schema.parse(data);
}

// ── apiStream — SSE streaming helper ─────────────────────────────────────────
/**
 * Opens a POST SSE stream to the given endpoint.
 * Returns a ReadableStreamDefaultReader already attached to the response body.
 * Auth token is injected from localStorage (same pattern as apiClient interceptor).
 *
 * Rule R-F4 exception: SSE requires native fetch — Axios does not support streaming.
 * Auth logic is centralised here so components never touch localStorage directly.
 */
export async function apiStream(
  url: string,
  body: unknown,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const token = getToken();
  const res   = await fetch(`${API_BASE_URL}${url}`, {
    method:  "POST",
    headers: {
      "Content-Type":    "application/json",
      "X-Cometa-Source": "analyst-portal",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok)   throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error("Response body is null");

  return res.body.getReader();
}

// ── downloadCsv — triggers a file download for auth-gated CSV endpoints ──────
/**
 * Fetches a CSV from the backend with the JWT attached, then triggers a
 * browser "Save As" dialog.  Uses apiFetch so the auth header is injected
 * automatically — the URL must never be opened in a plain <a> tag.
 */
export async function downloadCsv(
  endpoint: string,
  filename: string,
): Promise<void> {
  // Resolve relative paths against the backend base URL so the request
  // reaches FastAPI, not the Next.js server.
  const url = endpoint.startsWith("/") ? `${API_BASE_URL}${endpoint}` : endpoint;
  const res = await apiFetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(detail);
  }
  const blob   = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement("a"), {
    href:     objUrl,
    download: filename,
  });
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objUrl);
}

// ── apiFetch — legacy shim for existing components ───────────────────────────
/**
 * Native fetch wrapper that attaches JWT from localStorage.
 * Same interface as window.fetch → returns Promise<Response>.
 * Rule R-F4: only use in legacy components, not in new code.
 */
export async function apiFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers as HeadersInit | undefined);
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}
