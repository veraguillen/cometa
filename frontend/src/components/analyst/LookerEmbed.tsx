"use client";

/**
 * LookerEmbed — Looker Studio iframe embebido.
 *
 * Configuración (.env.local):
 *   NEXT_PUBLIC_LOOKER_URL       — URL directa o short-link del reporte (prioridad)
 *   NEXT_PUBLIC_LOOKER_REPORT_ID — ID largo del reporte (fallback, construye embed URL)
 *   NEXT_PUBLIC_LOOKER_PAGE_ID   — page slug opcional
 */

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { LayoutDashboard, ExternalLink } from "lucide-react";

// ── URL builder (solo si no hay NEXT_PUBLIC_LOOKER_URL) ───────────────────────

function buildEmbedUrl(
  reportId: string,
  pageId:   string | undefined,
): string {
  const base = pageId
    ? `https://lookerstudio.google.com/embed/reporting/${reportId}/page/${pageId}`
    : `https://lookerstudio.google.com/embed/reporting/${reportId}`;
  // rm=minimal oculta la barra de navegación de Looker Studio para ganar espacio vertical
  return `${base}?rm=minimal`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface LookerEmbedProps {
  companyId?: string | null;
  kpiFocus?:  string | null;
  period?:    string | null;
  className?: string;
}

export default function LookerEmbed({
  companyId,
  kpiFocus,
  period,
  className = "",
}: LookerEmbedProps) {
  const [loaded, setLoaded] = useState(false);

  const lookerUrl = process.env.NEXT_PUBLIC_LOOKER_URL;
  const reportId  = process.env.NEXT_PUBLIC_LOOKER_REPORT_ID;
  const pageId    = process.env.NEXT_PUBLIC_LOOKER_PAGE_ID;

  // NEXT_PUBLIC_LOOKER_URL tiene prioridad — soporta short-links (/s/xxx)
  // y URLs completas de Looker Studio.
  const iframeSrc = useMemo(() => {
    if (lookerUrl) return lookerUrl;
    if (reportId)  return buildEmbedUrl(reportId, pageId);
    return null;
  }, [lookerUrl, reportId, pageId]);

  // URL de nueva pestaña (versión viewer, no embed)
  const directUrl = useMemo(() => {
    if (lookerUrl) return lookerUrl;
    if (reportId)  return `https://lookerstudio.google.com/reporting/${reportId}`;
    return "#";
  }, [lookerUrl, reportId]);

  // ── No configurado ────────────────────────────────────────────────────────────
  if (!iframeSrc) {
    return (
      <div
        className={`flex flex-col items-center justify-center rounded-2xl py-24 text-center ${className}`}
        style={{ border: "1px dashed var(--cometa-card-border)" }}
      >
        <LayoutDashboard size={32} style={{ color: "var(--cometa-fg-muted)", opacity: 0.25 }} />
        <p className="mt-4 text-[13px]" style={{ color: "var(--cometa-fg-muted)", fontWeight: 400 }}>
          Dashboard de Looker Studio no configurado
        </p>
        <p className="mt-1 text-[11px] max-w-xs" style={{ color: "var(--cometa-fg-muted)", opacity: 0.45 }}>
          Define <code className="font-mono px-1 rounded" style={{ background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)" }}>NEXT_PUBLIC_LOOKER_URL</code> en{" "}
          <code className="font-mono">.env.local</code>
        </p>
      </div>
    );
  }

  // ── Embed ─────────────────────────────────────────────────────────────────────
  return (
    <div
      className={`relative rounded-2xl overflow-hidden ${className}`}
      style={{
        border: "1px solid var(--cometa-card-border)",
      }}
    >
      {/* Filter pills (tras carga) */}
      {loaded && (companyId || kpiFocus || period) && (
        <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 flex-wrap pointer-events-none">
          {companyId && (
            <span className="rounded-full px-2.5 py-0.5 text-[10px] font-medium"
              style={{ background: "color-mix(in srgb, var(--cometa-accent) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--cometa-accent) 28%, transparent)", color: "var(--cometa-accent)", backdropFilter: "blur(8px)" }}>
              {companyId}
            </span>
          )}
          {kpiFocus && (
            <span className="rounded-full px-2.5 py-0.5 text-[10px] font-medium"
              style={{ background: "color-mix(in srgb, #34d399 10%, transparent)", border: "1px solid color-mix(in srgb, #34d399 22%, transparent)", color: "#34d399", backdropFilter: "blur(8px)" }}>
              {kpiFocus.replace(/_/g, " ")}
            </span>
          )}
          {period && (
            <span className="rounded-full px-2.5 py-0.5 text-[10px] font-medium"
              style={{ background: "color-mix(in srgb, #94a3b8 8%, transparent)", border: "1px solid color-mix(in srgb, #94a3b8 18%, transparent)", color: "#94a3b8", backdropFilter: "blur(8px)" }}>
              {period}
            </span>
          )}
        </div>
      )}

      {/* Abrir en nueva pestaña */}
      {loaded && (
        <a
          href={directUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] transition-opacity hover:opacity-70"
          style={{ background: "color-mix(in srgb, var(--cometa-bg) 80%, transparent)", border: "1px solid var(--cometa-card-border)", color: "var(--cometa-fg-muted)", backdropFilter: "blur(8px)" }}
        >
          <ExternalLink size={9} />
          Abrir
        </a>
      )}

      {/* Skeleton mientras carga */}
      {!loaded && (
        <div className="absolute inset-0 flex flex-col p-6 gap-3" style={{ background: "var(--cometa-card-bg)" }}>
          <motion.div
            className="absolute inset-x-0 h-px"
            style={{ background: "linear-gradient(90deg, transparent 0%, #00237F 50%, transparent 100%)", opacity: 0.4 }}
            animate={{ top: ["0%", "100%", "0%"] }}
            transition={{ duration: 3.5, repeat: Infinity, ease: "linear" }}
          />
          <div className="h-6 w-40 rounded-md animate-pulse" style={{ background: "color-mix(in srgb, #00237F 10%, transparent)" }} />
          <div className="grid grid-cols-3 gap-3 mt-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl p-4 animate-pulse"
                style={{ background: "color-mix(in srgb, #00237F 6%, transparent)", border: "1px solid color-mix(in srgb, #00237F 12%, transparent)", height: "72px" }} />
            ))}
          </div>
          <div className="flex-1 rounded-xl animate-pulse mt-1"
            style={{ background: "color-mix(in srgb, #00237F 5%, transparent)", border: "1px solid color-mix(in srgb, #00237F 10%, transparent)", minHeight: "200px" }} />
          <div className="grid grid-cols-2 gap-3">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-xl animate-pulse"
                style={{ background: "color-mix(in srgb, #00237F 6%, transparent)", border: "1px solid color-mix(in srgb, #00237F 12%, transparent)", height: "80px" }} />
            ))}
          </div>
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest whitespace-nowrap"
            style={{ color: "#00237F", opacity: 0.45 }}>
            Cargando Looker Studio…
          </p>
        </div>
      )}

      {/* iframe — 100% del contenedor padre; Looker maneja su propio scroll interno */}
      <iframe
        src={iframeSrc}
        title="Looker Studio Dashboard — Cometa"
        className="border-0"
        style={{
          display: loaded ? "block" : "none",
          width:   "100%",
          height:  "100%",
        }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        onLoad={() => setLoaded(true)}
        allowFullScreen
      />
    </div>
  );
}
