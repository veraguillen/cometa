"use client";

/**
 * /login — Authentication page.
 *
 * Always renders the login form (proxy never blocks this route).
 * On mount, if a valid JWT exists, shows a "ya tienes sesión" banner
 * with a direct link to the dashboard — but never redirects automatically,
 * so the user can always re-login with different credentials.
 *
 * On submit:
 *   1. loginWithCredentials() → JWT to localStorage + cometa_user_id cookie
 *   2. router.push() to intended path or role-appropriate dashboard
 */

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Mail, Lock, LogIn } from "lucide-react";
import {
  loginWithCredentials,
  loginWithGoogle,
  validateSession,
  clearSession,
  type UserInfo,
} from "@/services/api-client";
import { validationErrorSchema } from "@/lib/schemas";
import GeometricBackground from "@/components/analyst/GeometricBackground";
import ResetTheme from "@/components/ResetTheme";
import Script from "next/script";
import axios from "axios";

const INTERNAL_DOMAINS = ["@cometa.vc", "@cometa.fund", "@cometavc.com"];

// Minimal types for the Google Identity Services (GIS) browser API
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }) => void;
          renderButton: (el: HTMLElement, cfg: object) => void;
          prompt: () => void;
        };
      };
    };
  }
}

// Exported page wraps the real content in Suspense (required by useSearchParams in App Router)
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const nextPath     = searchParams.get("next");

  const [email,        setEmail]        = useState("");
  const [password,     setPassword]     = useState("");
  const [error,        setError]        = useState("");
  const [isLoading,    setIsLoading]    = useState(false);
  const [gLoading,     setGLoading]     = useState(false);
  const [existingUser, setExistingUser] = useState<UserInfo | null>(null);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    validateSession().then((u) => setExistingUser(u));
  }, []);

  // Initialise Google Identity Services once the GIS script has loaded
  function initGoogleSignIn() {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || !window.google || !googleBtnRef.current) return;
    window.google.accounts.id.initialize({
      client_id:   clientId,
      auto_select: false,
      callback:    handleGoogleCredential,
    });
    window.google.accounts.id.renderButton(googleBtnRef.current, {
      theme:           "outline",
      size:            "large",
      shape:           "rectangular",
      logo_alignment:  "center",
      width:           400,
      text:            "signin_with",
      locale:          "es",
    });
  }

  async function handleGoogleCredential(response: { credential: string }) {
    setGLoading(true);
    setError("");
    try {
      const { user } = await loginWithGoogle(response.credential);
      const dest = nextPath ?? "/analyst/dashboard";
      router.push(dest);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 403) {
          setError("Solo cuentas @cometa.vc pueden acceder como analistas.");
        } else if (status === 401) {
          setError("Token de Google inválido. Intenta de nuevo.");
        } else {
          setError("Error de autenticación. Verifica la conexión al servidor.");
        }
      } else {
        setError("Error inesperado al autenticar con Google.");
      }
    } finally {
      setGLoading(false);
    }
  }

  const isValidEmail    = email.includes("@") && email.includes(".");
  const isInternalEmail = INTERNAL_DOMAINS.some((d) => email.toLowerCase().endsWith(d));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidEmail || !password || isLoading) return;
    setIsLoading(true);
    setError("");
    try {
      const { user } = await loginWithCredentials(email.trim(), password);
      const dest = nextPath
        ?? (user.user_id.startsWith("ANA-") ? "/analyst/dashboard" : "/founder/onboarding");
      router.push(dest);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 422) {
        const { detail } = validationErrorSchema.parse(err.response.data);
        setError(detail[0]?.msg ?? "Error de validación");
      } else {
        const status = (err as { response?: { status?: number } })?.response?.status;
        setError(
          status === 401
            ? "Credenciales incorrectas. Verifica tu email y contraseña."
            : "Error de conexión. Asegúrate de que el servidor esté activo.",
        );
      }
    } finally {
      setIsLoading(false);
    }
  }

  function handleGoToDashboard() {
    if (!existingUser) return;
    router.push(existingUser.user_id.startsWith("ANA-") ? "/analyst/dashboard" : "/founder/onboarding");
  }

  function handleForceLogout() {
    clearSession();
    setExistingUser(null);
  }

  return (
    <div
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
      style={{ background: "var(--cometa-bg)" }}
    >
      {/* Animated geometric decoration */}
      <GeometricBackground />

      {/* Theme switcher — top-right floating */}
      <div className="absolute top-4 right-4 z-50">
        <ResetTheme />
      </div>

      {/* Form card — motion entry */}
      <motion.div
        initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0,  filter: "blur(0px)" }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-md px-6"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-14">
          <img
            src="/COMETALOGO.png"
            alt="Cometa"
            className="mb-6 h-20 w-auto object-contain"
            style={{ filter: "brightness(0) invert(1) drop-shadow(0 0 24px color-mix(in srgb, var(--cometa-accent) 30%, transparent))" }}
          />
        </div>

        {/* Active session banner */}
        <AnimatePresence>
          {existingUser && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{    opacity: 0, height: 0 }}
              className="mb-8 overflow-hidden rounded-xl"
              style={{
                border:     "1px solid var(--cometa-card-border)",
                background: "var(--cometa-card-bg)",
              }}
            >
              <div className="px-4 py-3">
                <p className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                  Sesión activa: <span style={{ color: "var(--cometa-fg)" }}>{existingUser.email}</span>
                </p>
                <div className="mt-2 flex gap-3">
                  <button
                    onClick={handleGoToDashboard}
                    className="flex items-center gap-1.5 text-[11px] transition-opacity hover:opacity-80"
                    style={{ color: "var(--cometa-accent)" }}
                  >
                    <LogIn size={12} />
                    Ir al dashboard
                  </button>
                  <span style={{ color: "var(--cometa-card-border)" }}>·</span>
                  <button
                    onClick={handleForceLogout}
                    className="text-[11px] transition-opacity hover:opacity-80"
                    style={{ color: "var(--cometa-fg-muted)" }}
                  >
                    Cerrar sesión
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email field */}
          <div className="relative">
            <Mail
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--cometa-fg-muted)" }}
            />
            <input
              type="email"
              id="email"
              value={email}
              required
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
              placeholder="tu@empresa.com"
              autoComplete="username"
              className="w-full rounded-xl py-3 pl-10 pr-4 text-sm outline-none transition-all"
              style={{
                background:  "var(--cometa-card-bg)",
                border:      "1px solid var(--cometa-card-border)",
                color:       "var(--cometa-fg)",
                fontWeight:  400,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--cometa-accent) 50%, transparent)")}
              onBlur={(e)  => (e.currentTarget.style.borderColor = "var(--cometa-card-border)")}
            />
          </div>

          {/* Password field */}
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--cometa-fg-muted)" }}
            />
            <input
              type="password"
              id="password"
              value={password}
              required
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              placeholder="Contraseña"
              autoComplete="current-password"
              className="w-full rounded-xl py-3 pl-10 pr-4 text-sm outline-none transition-all"
              style={{
                background:  "var(--cometa-card-bg)",
                border:      "1px solid var(--cometa-card-border)",
                color:       "var(--cometa-fg)",
                fontWeight:  400,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--cometa-accent) 50%, transparent)")}
              onBlur={(e)  => (e.currentTarget.style.borderColor = "var(--cometa-card-border)")}
            />
          </div>

          {/* Role hint */}
          <AnimatePresence>
            {isValidEmail && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{    opacity: 0 }}
                className="text-[11px] tracking-wide pl-1"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                {isInternalEmail ? "→ Acceso Analista Cometa" : "→ Acceso Founder / Socio"}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{    opacity: 0 }}
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
            disabled={!isValidEmail || !password || isLoading}
            whileHover={!isLoading ? { scale: 1.01 } : {}}
            whileTap={!isLoading  ? { scale: 0.97 } : {}}
            className="w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2 transition-all"
            style={{
              background: "var(--cometa-accent)",
              color:      "var(--cometa-accent-fg)",
              fontWeight: 400,
              opacity:    (!isValidEmail || !password || isLoading) ? 0.4 : 1,
            }}
          >
            {isLoading ? (
              <>
                <div
                  className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
                  style={{ borderTopColor: "var(--cometa-accent-fg)" }}
                />
                <span>Verificando…</span>
              </>
            ) : (
              <>
                <span>Ingresar</span>
                <ArrowRight size={16} />
              </>
            )}
          </motion.button>
        </form>

        {/* ── Google Sign-In — Analistas Cometa ─────────────────────────── */}
        {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && (
          <>
            {/* Divider */}
            <div className="relative my-6 flex items-center">
              <div className="flex-1 border-t" style={{ borderColor: "var(--cometa-card-border)" }} />
              <span className="px-3 text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                Acceso analistas
              </span>
              <div className="flex-1 border-t" style={{ borderColor: "var(--cometa-card-border)" }} />
            </div>

            {/* Google button rendered by GIS — centered wrapper */}
            <div className="flex flex-col items-center gap-2">
              {gLoading ? (
                <div className="flex items-center gap-2 py-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
                       style={{ borderTopColor: "var(--cometa-fg-muted)" }} />
                  <span className="text-[12px]" style={{ color: "var(--cometa-fg-muted)" }}>
                    Autenticando…
                  </span>
                </div>
              ) : (
                <div ref={googleBtnRef} />
              )}
              <p className="text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
                Solo cuentas <span style={{ color: "var(--cometa-fg)" }}>@cometa.vc</span> verificadas por Google
              </p>
            </div>
          </>
        )}

      </motion.div>

      {/* Load Google Identity Services script */}
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="lazyOnload"
        onLoad={initGoogleSignIn}
      />
    </div>
  );
}
