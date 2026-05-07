"use client";

/**
 * /auth/setup-password — Founder account activation page.
 *
 * Flow:
 *   1. Reads `?token=` from URL — shows error if missing.
 *   2. Validates password strength client-side (≥8 chars, digit, symbol).
 *   3. POST /api/auth/setup-password → auto-login JWT → /founder/onboarding.
 *
 * Design:
 *   - GeometricBackground (same as /login)
 *   - Title weight 100, no all-caps
 *   - Minimal two-field form, strength indicator below input
 */

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { apiPost } from "@/services/api-client";
import { TOKEN_KEY, SESSION_KEY } from "@/services/api-client";
import { setupPasswordResponseSchema } from "@/lib/schemas";
import GeometricBackground from "@/components/analyst/GeometricBackground";
import ResetTheme from "@/components/ResetTheme";
import axios from "axios";

// ── Password strength ────────────────────────────────────────────────────────

interface Strength {
  score:  0 | 1 | 2 | 3;   // 0=empty, 1=weak, 2=ok, 3=strong
  label:  string;
  color:  string;
}

function measureStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: "", color: "transparent" };
  const hasLen    = pw.length >= 8;
  const hasDigit  = /\d/.test(pw);
  const hasSymbol = /[\W_]/.test(pw);
  const hasUpper  = /[A-Z]/.test(pw);
  const score     = [hasLen, hasDigit, hasSymbol, hasUpper].filter(Boolean).length;

  if (score <= 1) return { score: 1, label: "Débil",    color: "#f87171" };
  if (score === 2) return { score: 2, label: "Aceptable", color: "#fbbf24" };
  return              { score: 3, label: "Segura",    color: "#34d399" };
}

// ── Exported page wraps content in Suspense (required by useSearchParams) ────
export default function SetupPasswordPage() {
  return (
    <Suspense>
      <SetupPasswordForm />
    </Suspense>
  );
}

function SetupPasswordForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const token        = searchParams.get("token") ?? "";

  const [password,    setPassword]    = useState("");
  const [confirm,     setConfirm]     = useState("");
  const [showPw,      setShowPw]      = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error,       setError]       = useState("");
  const [isLoading,   setIsLoading]   = useState(false);
  const [done,        setDone]        = useState(false);

  const strength    = measureStrength(password);
  const mismatch    = confirm.length > 0 && password !== confirm;
  const canSubmit   = strength.score >= 2 && password === confirm && !isLoading;

  // Show immediate error if no token in URL
  const missingToken = !token;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || missingToken) return;

    setIsLoading(true);
    setError("");

    try {
      const data = await apiPost(
        "/api/auth/setup-password",
        { token, password, password_confirm: confirm },
        setupPasswordResponseSchema,
      );

      // Auto-login: persist JWT exactly as /login does
      localStorage.setItem(TOKEN_KEY, data.access_token);
      document.cookie = `cometa_user_id=${data.user.user_id}; path=/; max-age=86400; SameSite=Lax`;

      setDone(true);
      setTimeout(() => router.push("/founder/onboarding"), 1800);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.detail;
        setError(typeof msg === "string" ? msg : "Error al activar la cuenta.");
      } else {
        setError("Error de conexión. Inténtalo de nuevo.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
      style={{ background: "var(--cometa-bg)" }}
    >
      <ResetTheme />
      <GeometricBackground />

      <motion.div
        initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0,  filter: "blur(0px)" }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-md px-6"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-12">
          <img
            src="/COMETALOGO.png"
            alt="Cometa"
            className="mb-6 h-16 w-auto object-contain"
            style={{ filter: "brightness(0) invert(1)" }}
          />
          <h1
            className="text-2xl text-center"
            style={{ color: "var(--cometa-fg)", fontWeight: 100, letterSpacing: "0.03em" }}
          >
            Configura tu acceso seguro
          </h1>
          <p className="mt-2 text-sm text-center" style={{ color: "var(--cometa-fg-muted)", fontWeight: 300 }}>
            Elige una contraseña para tu Bóveda Digital en Cometa VC
          </p>
        </div>

        {/* Missing token error */}
        {missingToken ? (
          <div
            className="rounded-xl px-4 py-4 text-sm text-center"
            style={{
              background: "color-mix(in srgb, #f87171 10%, transparent)",
              border:     "1px solid color-mix(in srgb, #f87171 20%, transparent)",
              color:      "#f87171",
            }}
          >
            Enlace de invitación inválido o expirado.
            <br />
            <span style={{ fontSize: "11px", opacity: 0.7 }}>
              Solicita una nueva invitación a tu contacto en Cometa VC.
            </span>
          </div>
        ) : done ? (
          /* Success state */
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4 text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 380, damping: 20, delay: 0.1 }}
            >
              <ShieldCheck size={52} style={{ color: "var(--cometa-accent)" }} />
            </motion.div>
            <p style={{ color: "var(--cometa-fg)", fontWeight: 100, fontSize: "20px" }}>
              Acceso configurado
            </p>
            <p style={{ color: "var(--cometa-fg-muted)", fontSize: "13px", fontWeight: 300 }}>
              Redirigiendo a tu Bóveda Digital…
            </p>
          </motion.div>
        ) : (
          /* Form */
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Password */}
            <div className="space-y-1">
              <div className="relative">
                <Lock
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: "var(--cometa-fg-muted)" }}
                />
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(""); }}
                  placeholder="Nueva contraseña"
                  autoComplete="new-password"
                  className="w-full rounded-xl py-3 pl-10 pr-10 text-sm outline-none transition-all"
                  style={{
                    background: "var(--cometa-card-bg)",
                    border:     "1px solid var(--cometa-card-border)",
                    color:      "var(--cometa-fg)",
                    fontWeight: 400,
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--cometa-accent) 50%, transparent)")}
                  onBlur={(e)  => (e.currentTarget.style.borderColor = "var(--cometa-card-border)")}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                  style={{ color: "var(--cometa-fg-muted)" }}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>

              {/* Strength bar */}
              {password.length > 0 && (
                <div className="flex items-center gap-2 px-1">
                  <div className="flex gap-1 flex-1">
                    {([1, 2, 3] as const).map((level) => (
                      <div
                        key={level}
                        className="h-0.5 flex-1 rounded-full transition-all duration-300"
                        style={{
                          background: strength.score >= level ? strength.color : "var(--cometa-card-border)",
                        }}
                      />
                    ))}
                  </div>
                  <span className="text-[10px]" style={{ color: strength.color, fontWeight: 400 }}>
                    {strength.label}
                  </span>
                </div>
              )}

              <p className="text-[10px] px-1" style={{ color: "var(--cometa-fg-muted)", opacity: 0.5 }}>
                Mínimo 8 caracteres, un número y un símbolo
              </p>
            </div>

            {/* Confirm */}
            <div className="relative">
              <Lock
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: "var(--cometa-fg-muted)" }}
              />
              <input
                type={showConfirm ? "text" : "password"}
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setError(""); }}
                placeholder="Confirmar contraseña"
                autoComplete="new-password"
                className="w-full rounded-xl py-3 pl-10 pr-10 text-sm outline-none transition-all"
                style={{
                  background: "var(--cometa-card-bg)",
                  border:     mismatch
                    ? "1px solid color-mix(in srgb, #f87171 50%, transparent)"
                    : "1px solid var(--cometa-card-border)",
                  color:      "var(--cometa-fg)",
                  fontWeight: 400,
                }}
                onFocus={(e) => {
                  if (!mismatch) e.currentTarget.style.borderColor = "color-mix(in srgb, var(--cometa-accent) 50%, transparent)";
                }}
                onBlur={(e) => {
                  if (!mismatch) e.currentTarget.style.borderColor = "var(--cometa-card-border)";
                }}
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>

            {/* Mismatch hint */}
            <AnimatePresence>
              {mismatch && (
                <motion.p
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-[11px] pl-1"
                  style={{ color: "#f87171" }}
                >
                  Las contraseñas no coinciden
                </motion.p>
              )}
            </AnimatePresence>

            {/* Server error */}
            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-[11px] pl-1"
                  style={{ color: "#f87171" }}
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            {/* Submit */}
            <motion.button
              type="submit"
              disabled={!canSubmit}
              whileHover={canSubmit ? { scale: 1.01 } : {}}
              whileTap={canSubmit  ? { scale: 0.97 } : {}}
              className="w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2 transition-all"
              style={{
                background: "var(--cometa-accent)",
                color:      "var(--cometa-accent-fg)",
                fontWeight: 400,
                opacity:    canSubmit ? 1 : 0.35,
              }}
            >
              {isLoading ? (
                <div
                  className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
                  style={{ borderTopColor: "var(--cometa-accent-fg)" }}
                />
              ) : (
                "Activar cuenta"
              )}
            </motion.button>
          </form>
        )}
      </motion.div>
    </div>
  );
}
