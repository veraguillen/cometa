"use client";

/**
 * InviteFounder — Standalone modal for analyst to invite a founder.
 *
 * State machine:
 *   idle → processing → user_created → email_sent  (auto-close 3 s)
 *                                   → email_error  (stay open, show exact error)
 *
 * One button flow:
 *   1. Analyst fills email + company name
 *   2. Clicks "Invitar"
 *   3. Modal shows:
 *        "Procesando…"            (request in flight)
 *        "Usuario Creado en DB"   (API returned 200)
 *        "Correo Enviado"         (email_sent: true)   OR
 *        [exact Resend/SMTP error] (email_sent: false)
 */

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  UserPlus,
  CheckCircle2,
  Mail,
  AlertCircle,
  Loader2,
  Database,
} from "lucide-react";
import { apiPost } from "@/services/api-client";
import { adminInviteResponseSchema } from "@/lib/schemas";
import axios from "axios";

// ── Types ──────────────────────────────────────────────────────────────────────

type Step = "idle" | "processing" | "user_created" | "email_sent" | "email_error";

interface InviteFounderProps {
  open:     boolean;
  onClose:  () => void;
}

// ── Status step display ────────────────────────────────────────────────────────

interface StatusRowProps {
  icon:   React.ReactNode;
  label:  string;
  active: boolean;
  done:   boolean;
  error?: boolean;
}

function StatusRow({ icon, label, active, done, error }: StatusRowProps) {
  const color = error
    ? "#f87171"
    : done || active
      ? "#34d399"
      : "var(--cometa-fg-muted)";

  return (
    <div className="flex items-center gap-3 py-2">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          background: error
            ? "color-mix(in srgb, #f87171 12%, transparent)"
            : done || active
              ? "color-mix(in srgb, #34d399 12%, transparent)"
              : "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
          border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
          transition: "background 0.3s, border-color 0.3s",
        }}
      >
        {active && !done && !error ? (
          <Loader2 size={13} className="animate-spin" style={{ color }} />
        ) : (
          <span style={{ color, transition: "color 0.3s" }}>{icon}</span>
        )}
      </div>
      <span
        className="text-[13px]"
        style={{
          color,
          fontWeight: active || done ? 400 : 300,
          opacity:    active || done || error ? 1 : 0.45,
          transition: "color 0.3s, opacity 0.3s",
        }}
      >
        {label}
      </span>
      {done && (
        <CheckCircle2
          size={13}
          className="ml-auto shrink-0"
          style={{ color: "#34d399" }}
        />
      )}
    </div>
  );
}

// ── Internal domain detection (mirrors login/page.tsx) ───────────────────────
const INTERNAL_DOMAINS = ["@cometa.vc", "@cometa.fund", "@cometavc.com"];

function isInternalEmail(email: string): boolean {
  return INTERNAL_DOMAINS.some((d) => email.toLowerCase().endsWith(d));
}

// ── DNS / domain error detection ──────────────────────────────────────────────

const DNS_KEYWORDS = [
  "not verified", "verify a domain", "domain is not verified",
  "recipient not verified", "testing emails to your own", "verify your domain",
  "dns", "spf", "dkim", "domain verification",
];

function isDnsError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return DNS_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function InviteFounder({ open, onClose }: InviteFounderProps) {
  const [email,       setEmail]       = useState("");
  const [companyName, setCompanyName] = useState("");
  const [step,        setStep]        = useState<Step>("idle");
  const [emailError,  setEmailError]  = useState("");

  const isInternal   = useMemo(() => isInternalEmail(email), [email]);
  const isValidEmail = email.includes("@") && email.includes(".");

  // Auto-fill company for internal emails
  useEffect(() => {
    if (isInternal) setCompanyName("Cometa");
    else if (companyName === "Cometa") setCompanyName("");
  }, [isInternal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-close 3 s after success
  useEffect(() => {
    if (step !== "email_sent") return;
    const t = setTimeout(handleClose, 3000);
    return () => clearTimeout(t);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleClose() {
    if (step === "processing" || step === "user_created") return; // don't interrupt
    setStep("idle");
    setEmail("");
    setCompanyName("");
    setEmailError("");
    onClose();
  }

  async function handleInvite() {
    const emailTrimmed   = email.trim().toLowerCase();
    const companyTrimmed = companyName.trim();
    if (!emailTrimmed || !companyTrimmed || step !== "idle") return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      setEmailError("Email inválido.");
      setStep("email_error");
      return;
    }

    setStep("processing");
    setEmailError("");

    try {
      const result = await apiPost(
        "/api/admin/invite",
        { email: emailTrimmed, company_name: companyTrimmed },
        adminInviteResponseSchema,
      );

      // Brief "user created" flash
      setStep("user_created");
      await new Promise((r) => setTimeout(r, 700));

      if (result.email_sent) {
        setStep("email_sent");
      } else {
        setEmailError(
          result.email_error ||
            "Resend no entregó el correo. Verifica la configuración de dominio.",
        );
        setStep("email_error");
      }
    } catch (err: unknown) {
      let errMsg = "Error al procesar la invitación.";
      if (axios.isAxiosError(err)) {
        const d = err.response?.data?.detail;
        errMsg = typeof d === "string" ? d : errMsg;
      }
      setEmailError(errMsg);
      setStep("email_error");
    }
  }

  // Derived state for StatusRow
  const processing = step === "processing" || step === "user_created";
  const dbDone     = ["user_created", "email_sent", "email_error"].includes(step);
  const mailActive = step === "user_created";   // brief transitional state
  const mailDone   = step === "email_sent";
  const mailError  = step === "email_error";
  const busy       = step === "processing" || step === "user_created";

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50"
            style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
          />

          {/* Modal */}
          <motion.div
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2
                       rounded-2xl overflow-hidden"
            style={{
              background:     "color-mix(in srgb, var(--cometa-bg) 97%, transparent)",
              border:         "1px solid var(--cometa-card-border)",
              backdropFilter: "blur(32px)",
              boxShadow:      "0 24px 64px rgba(0,0,0,0.48)",
            }}
            initial={{ scale: 0.95, opacity: 0, y: "-48%" }}
            animate={{ scale: 1,    opacity: 1, y: "-50%" }}
            exit={{    scale: 0.95, opacity: 0, y: "-48%" }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
          >
            {/* ── Header ── */}
            <div
              className="flex items-center gap-3 px-6 py-4 border-b"
              style={{ borderColor: "var(--cometa-card-border)" }}
            >
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{
                  background: "color-mix(in srgb, var(--cometa-accent) 10%, transparent)",
                  border:     "1px solid color-mix(in srgb, var(--cometa-accent) 22%, transparent)",
                }}
              >
                <UserPlus size={14} style={{ color: "var(--cometa-accent)" }} />
              </div>
              <div>
                <p className="text-[13px]" style={{ color: "var(--cometa-fg)", fontWeight: 400 }}>
                  Invitar usuario
                </p>
                <p className="text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
                  Genera acceso seguro a la Bóveda Digital
                </p>
              </div>
              <button
                onClick={handleClose}
                disabled={busy}
                className="ml-auto rounded-lg p-1.5 transition-opacity hover:opacity-60 disabled:opacity-30"
                style={{ color: "var(--cometa-fg-muted)", border: "1px solid var(--cometa-card-border)" }}
              >
                <X size={13} />
              </button>
            </div>

            {/* ── Body ── */}
            <div className="px-6 py-5 space-y-4">

              {/* Form — only visible in idle / error states */}
              <AnimatePresence>
                {(step === "idle" || step === "email_error") && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-3"
                  >
                    {/* Email */}
                    <div>
                      <label
                        className="block text-[10px] uppercase tracking-widest mb-1.5"
                        style={{ color: "var(--cometa-fg-muted)" }}
                      >
                        Email
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          if (step === "email_error") {
                            setStep("idle");
                            setEmailError("");
                          }
                        }}
                        placeholder="usuario@empresa.com"
                        className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none"
                        style={{
                          background:  "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                          border:      "1px solid var(--cometa-card-border)",
                          color:       "var(--cometa-fg)",
                          fontFamily:  "var(--font-sans)",
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") handleInvite(); }}
                      />
                      {isValidEmail && (
                        <p className="mt-1 text-[10px] pl-0.5" style={{ color: "var(--cometa-fg-muted)" }}>
                          {isInternal ? "→ Acceso Analista Cometa (ANA-)" : "→ Acceso Founder (FND-)"}
                        </p>
                      )}
                    </div>

                    {/* Company — hidden for internal (Cometa) emails */}
                    <div style={{ display: isInternal ? "none" : undefined }}>
                      <label
                        className="block text-[10px] uppercase tracking-widest mb-1.5"
                        style={{ color: "var(--cometa-fg-muted)" }}
                      >
                        Nombre de la empresa
                      </label>
                      <input
                        type="text"
                        value={companyName}
                        onChange={(e) => {
                          setCompanyName(e.target.value);
                          if (step === "email_error") {
                            setStep("idle");
                            setEmailError("");
                          }
                        }}
                        placeholder="Nombre Startup"
                        className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none"
                        style={{
                          background:  "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                          border:      "1px solid var(--cometa-card-border)",
                          color:       "var(--cometa-fg)",
                          fontFamily:  "var(--font-sans)",
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") handleInvite(); }}
                      />
                    </div>

                    {/* Error banner */}
                    {step === "email_error" && emailError && (
                      <div
                        className="rounded-lg overflow-hidden"
                        style={{
                          border: isDnsError(emailError)
                            ? "1px solid color-mix(in srgb, #fbbf24 30%, transparent)"
                            : "1px solid color-mix(in srgb, #f87171 20%, transparent)",
                        }}
                      >
                        {/* Primary message */}
                        <div
                          className="flex items-start gap-2.5 px-3.5 py-3 text-[11px] leading-relaxed"
                          style={{
                            background: isDnsError(emailError)
                              ? "color-mix(in srgb, #fbbf24 7%, transparent)"
                              : "color-mix(in srgb, #f87171 8%, transparent)",
                            color: isDnsError(emailError) ? "#fbbf24" : "#f87171",
                          }}
                        >
                          <AlertCircle size={13} className="shrink-0 mt-0.5" />
                          <span className="break-words font-medium">
                            {isDnsError(emailError)
                              ? "Error de Dominio: verifica que los registros DNS en Resend estén activos"
                              : emailError}
                          </span>
                        </div>
                        {/* DNS detail row */}
                        {isDnsError(emailError) && (
                          <div
                            className="px-3.5 py-2.5 text-[10px] leading-relaxed border-t space-y-1"
                            style={{
                              borderColor: "color-mix(in srgb, #fbbf24 18%, transparent)",
                              color:       "var(--cometa-fg-muted)",
                            }}
                          >
                            <p>El dominio <strong style={{ color: "var(--cometa-fg)" }}>cometa.vc</strong> requiere verificación en el panel de Resend.</p>
                            <p>Añade los registros SPF, DKIM y DMARC indicados en <strong style={{ color: "var(--cometa-fg)" }}>resend.com/domains</strong> y espera la propagación DNS (~5 min).</p>
                            <p className="opacity-60 text-[9px] mt-1 break-words">{emailError}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Progress steps — visible while processing / done */}
              <AnimatePresence>
                {step !== "idle" && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl px-4 py-3 space-y-0.5"
                    style={{
                      background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
                      border:     "1px solid var(--cometa-card-border)",
                    }}
                  >
                    <StatusRow
                      icon={<Loader2 size={12} />}
                      label="Procesando solicitud"
                      active={step === "processing"}
                      done={dbDone || mailDone}
                    />
                    <StatusRow
                      icon={<Database size={12} />}
                      label="Usuario creado en DB"
                      active={step === "user_created"}
                      done={dbDone}
                    />
                    <StatusRow
                      icon={<Mail size={12} />}
                      label={
                        mailDone  ? "Correo enviado con éxito" :
                        mailError ? "Error al enviar correo" :
                        "Enviando correo"
                      }
                      active={mailActive}
                      done={mailDone}
                      error={mailError}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Success note */}
              <AnimatePresence>
                {step === "email_sent" && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-[11px]"
                    style={{ color: "var(--cometa-fg-muted)" }}
                  >
                    El founder recibirá las instrucciones para configurar su acceso.
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            {/* ── Footer ── */}
            <div
              className="px-6 pb-5 flex justify-end gap-2"
            >
              {(step === "idle" || step === "email_error") && (
                <>
                  <button
                    onClick={handleClose}
                    className="rounded-lg px-4 py-2 text-[12px] transition-opacity hover:opacity-70"
                    style={{
                      color:      "var(--cometa-fg-muted)",
                      border:     "1px solid var(--cometa-card-border)",
                      fontWeight: 400,
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleInvite}
                    disabled={!email.trim() || !companyName.trim()}
                    className="flex items-center gap-2 rounded-lg px-5 py-2 text-[12px]
                               transition-opacity hover:opacity-80 disabled:opacity-35"
                    style={{
                      background: "color-mix(in srgb, var(--cometa-accent) 14%, transparent)",
                      border:     "1px solid color-mix(in srgb, var(--cometa-accent) 35%, transparent)",
                      color:      "var(--cometa-accent)",
                      fontWeight: 400,
                    }}
                  >
                    <UserPlus size={12} />
                    Invitar
                  </button>
                </>
              )}

              {busy && (
                <div
                  className="flex items-center gap-2 rounded-lg px-4 py-2 text-[12px]"
                  style={{ color: "var(--cometa-fg-muted)" }}
                >
                  <Loader2 size={12} className="animate-spin" />
                  Procesando…
                </div>
              )}

              {step === "email_sent" && (
                <div
                  className="flex items-center gap-2 rounded-lg px-4 py-2 text-[12px]"
                  style={{ color: "#34d399" }}
                >
                  <CheckCircle2 size={12} />
                  Cerrando…
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
