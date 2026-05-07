"use client";

/**
 * ValidationModal — renders 422 validation errors from the backend.
 * Parses error with validationErrorSchema (R-F5) before rendering.
 * Blocks progress until the user acknowledges.
 */

import { motion, AnimatePresence } from "framer-motion";
import { XCircle, X } from "lucide-react";
import { validationErrorSchema, type ValidationErrorResponse } from "@/lib/schemas";

interface ValidationModalProps {
  error:   unknown;
  onClose: () => void;
}

function parseErrors(raw: unknown): ValidationErrorResponse | null {
  try {
    const data = (raw as { data?: unknown })?.data ?? raw;
    return validationErrorSchema.parse(data);
  } catch { return null; }
}

function formatLoc(loc: (string | number)[]): string {
  return loc.filter((p) => p !== "body").join(" → ");
}

export default function ValidationModal({ error, onClose }: ValidationModalProps) {
  const parsed = parseErrors(error);

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 backdrop-blur-sm"
          style={{ background: "rgba(0,0,0,0.65)" }}
          onClick={onClose}
        />

        {/* Panel */}
        <motion.div
          className="relative z-10 w-full max-w-md rounded-2xl p-6 shadow-2xl"
          style={{
            background:  "var(--cometa-bg)",
            border:      "1px solid var(--cometa-card-border)",
          }}
          initial={{ scale: 0.95, y: 12 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 12 }}
          transition={{ type: "spring", stiffness: 320, damping: 28 }}
        >
          {/* Header */}
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <XCircle size={20} className="shrink-0 text-red-400" />
              <div>
                <h2 className="text-[13px] font-semibold" style={{ color: "var(--cometa-fg)" }}>
                  Documento no válido
                </h2>
                <p className="mt-0.5 text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                  Corrige los errores y vuelve a subir el documento.
                </p>
              </div>
            </div>
            <button onClick={onClose} className="shrink-0 rounded-md p-1 transition-opacity hover:opacity-60"
                    style={{ color: "var(--cometa-fg-muted)" }}>
              <X size={15} />
            </button>
          </div>

          {/* Error list */}
          {parsed ? (
            <ul className="space-y-2">
              {parsed.detail.map((item, i) => (
                <li key={i}
                    className="rounded-xl border px-4 py-3"
                    style={{
                      borderColor: "rgba(248,113,113,0.2)",
                      background:  "rgba(248,113,113,0.05)",
                    }}>
                  {item.loc.length > 0 && (
                    <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-red-400/60">
                      {formatLoc(item.loc)}
                    </p>
                  )}
                  <p className="text-[12px] text-red-300">{item.msg}</p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border px-4 py-3"
                 style={{ borderColor: "rgba(248,113,113,0.2)", background: "rgba(248,113,113,0.05)" }}>
              <p className="text-[12px] text-red-300">
                {String((error as { message?: string })?.message ?? error)}
              </p>
            </div>
          )}

          <button
            onClick={onClose}
            className="mt-5 w-full rounded-xl py-2.5 text-[12px] transition-opacity hover:opacity-70"
            style={{
              border:     "1px solid var(--cometa-card-border)",
              color:      "var(--cometa-fg-muted)",
            }}
          >
            Entendido
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
