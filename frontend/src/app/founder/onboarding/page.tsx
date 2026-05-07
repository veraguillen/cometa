"use client";

/**
 * /founder/onboarding — layout multi-empresa dinámico.
 *
 * El nombre de la empresa se resuelve desde el email del Founder:
 *   - email de prueba (founder_test@, test@, demo@) → "Startup Demo"
 *   - dominio conocido → nombre canónico del portafolio
 *   - dominio desconocido → capitalizar dominio base
 *
 * Header: "Consola de Founder | [Nombre Empresa]"
 * No theme switcher — tema obsidian fijo para Founders.
 */

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { validateSession, clearSession, type UserInfo } from "@/services/api-client";
import UploadFlow from "@/components/founder/UploadFlow";
import ResetTheme from "@/components/ResetTheme";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { resolveCompanyFromEmail } from "@/lib/company-resolver";

export default function FounderOnboardingPage() {
  const [user,     setUser]     = useState<UserInfo | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const router = useRouter();

  useEffect(() => {
    validateSession().then((u) => { setUser(u); setHydrated(true); });
  }, []);

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  // Identidad de empresa: fuente primaria = JWT (/api/me), fallback = resolver client-side
  const companyName = user?.company_name
    || resolveCompanyFromEmail(user?.email ?? "").displayName;

  if (!hydrated) return null;

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--cometa-bg)" }}
    >
      <ResetTheme theme="obsidian" />

      {/* ── Header ── */}
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b px-6"
        style={{
          borderColor:    "var(--cometa-card-border)",
          background:     "color-mix(in srgb, var(--cometa-bg) 88%, transparent)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Logo + título dinámico */}
        <div className="flex items-center gap-3">
          <img
            src="/COMETALOGO.png"
            alt="Cometa"
            className="h-7 w-auto object-contain"
            style={{ filter: "brightness(0) invert(1)" }}
          />
          {companyName && companyName !== "tu empresa" && (
            <div
              className="hidden sm:flex items-center gap-2 border-l pl-3"
              style={{ borderColor: "var(--cometa-card-border)" }}
            >
              <span
                className="text-[11px] font-light"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                Consola de Founder
              </span>
              <span
                className="text-[11px]"
                style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }}
              >
                |
              </span>
              <span
                className="text-[11px] font-medium"
                style={{ color: "var(--cometa-fg)" }}
              >
                {companyName}
              </span>
            </div>
          )}
        </div>

        {/* User info + logout */}
        <div className="flex items-center gap-3">
          {user && (
            <span
              className="hidden sm:block border-l pl-3 text-xs"
              style={{
                color:       "var(--cometa-fg-muted)",
                borderColor: "var(--cometa-card-border)",
                fontWeight:  400,
              }}
            >
              {user.name || user.email}
            </span>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
            style={{
              color:   "var(--cometa-fg-muted)",
              border:  "1px solid var(--cometa-card-border)",
            }}
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Cerrar Sesión</span>
          </button>
        </div>
      </motion.header>

      {/* ── Body ── */}
      <div className="flex min-h-[calc(100vh-56px)] flex-col w-full py-8">

        {/* Title section */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="text-center px-4 mb-8"
        >
          <h1
            className="text-3xl font-extralight mb-2"
            style={{ color: "var(--cometa-fg)" }}
          >
            Carga de datos financieros
          </h1>
          <p
            className="text-sm font-light"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            Sube tu reporte y Cometa Assistant auditará la consistencia de los datos automáticamente.
          </p>
        </motion.div>

        {/* UploadFlow — full width, identity from JWT */}
        <UploadFlow
          founderEmail={user?.email ?? ""}
          companySlug={user?.company_slug}
          companyNameJwt={user?.company_name}
          companyIdBq={user?.company_id}
          onSuccess={() => void 0}
        />

      </div>
    </div>
  );
}
