"use client";

/**
 * AppHeader — full-width sticky header with integrated tab navigation.
 *
 * Layout:
 *   Left:   Logo + analyst name
 *   Center: Portfolio | Analytics | Ingestión  (tab nav)
 *   Right:  Export CSV · Invite · Theme · Logout
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { LogOut, Menu, Download, Loader2, UserPlus, AlertCircle, Settings } from "lucide-react";
import { clearSession, downloadCsv } from "@/services/api-client";
import { useRouter } from "next/navigation";
import ThemeSwitcher from "./ThemeSwitcher";
import { useTheme } from "@/contexts/ThemeContext";
import type { UserInfo } from "@/services/api-client";
import type { MainTab } from "@/app/analyst/dashboard/page";

// ── Tab config ────────────────────────────────────────────────────────────────

const NAV_TABS: { id: MainTab; label: string }[] = [
  { id: "portfolio", label: "Portfolio"  },
  { id: "analytics", label: "Analytics"  },
  { id: "ingestion", label: "Ingestión"  },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface AppHeaderProps {
  user:               UserInfo | null;
  onMobileMenuOpen?:  () => void;
  selectedCompanyId?: string | null;
  selectedFund?:      string | null;
  onInviteClick?:     () => void;
  activeTab?:         MainTab;
  onTabChange?:       (tab: MainTab) => void;
  hasError?:          boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AppHeader({
  user,
  onMobileMenuOpen,
  selectedCompanyId,
  selectedFund,
  onInviteClick,
  activeTab,
  onTabChange,
  hasError,
}: AppHeaderProps) {
  const router = useRouter();
  const { theme } = useTheme();
  const [exporting, setExporting] = useState(false);

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  async function handleExportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (selectedFund)      params.set("portfolio_id", selectedFund);
      if (selectedCompanyId) params.set("company_id",   selectedCompanyId);
      const scope    = selectedCompanyId ?? selectedFund ?? "portfolio";
      const filename = `cometa_kpis_${scope}_${new Date().toISOString().slice(0, 10)}.csv`;
      await downloadCsv(`/api/export/csv?${params.toString()}`, filename);
    } catch (err) {
      console.error("[export/csv]", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-40 flex h-14 shrink-0 items-center border-b px-4 sm:px-6"
      style={{
        borderColor:    "var(--cometa-card-border)",
        background:     "color-mix(in srgb, var(--cometa-bg) 92%, transparent)",
        backdropFilter: "blur(20px)",
      }}
    >
      {/* ── Left: Logo + name ── */}
      <div className="flex items-center gap-3 shrink-0">
        {onMobileMenuOpen && (
          <button
            onClick={onMobileMenuOpen}
            className="lg:hidden p-1.5 rounded-lg transition-opacity hover:opacity-70"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            <Menu size={16} />
          </button>
        )}

        <img
          src="/COMETALOGO.png"
          alt="Cometa"
          className="h-7 w-auto object-contain"
          style={{ filter: theme === "slate" ? "brightness(0)" : "brightness(0) invert(1)" }}
        />

        {user && (
          <span
            className="hidden sm:block border-l pl-3 ml-1 text-xs"
            style={{ color: "var(--cometa-fg-muted)", borderColor: "var(--cometa-card-border)", fontWeight: 400 }}
          >
            Analista · {user.name || user.email}
          </span>
        )}
      </div>

      {/* ── Center: Tab navigation (absolutely centered) ── */}
      <div className="absolute left-1/2 -translate-x-1/2 hidden md:flex items-stretch h-full">
        {NAV_TABS.map(({ id, label }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => onTabChange?.(id)}
              className="relative px-5 text-[11px] tracking-widest uppercase transition-all duration-200"
              style={{
                color:        active ? "#e2e8f0" : "var(--cometa-fg-muted)",
                fontWeight:   active ? 400 : 300,
                background:   active ? "rgba(0,35,127,0.12)" : "transparent",
                borderBottom: active ? "2px solid #3b82f6" : "2px solid transparent",
                letterSpacing: "0.12em",
                opacity:      active ? 1 : 0.45,
              }}
            >
              {label}
            </button>
          );
        })}

        {/* Error indicator inline with tabs */}
        {hasError && (
          <div
            className="self-center ml-2 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
            style={{
              color:      "#f87171",
              background: "color-mix(in srgb, #f87171 10%, transparent)",
              border:     "1px solid color-mix(in srgb, #f87171 20%, transparent)",
            }}
          >
            <AlertCircle size={10} />
            offline
          </div>
        )}
      </div>

      {/* ── Right: Actions ── */}
      <div className="flex items-center gap-2 ml-auto">
        {(selectedCompanyId || selectedFund) && (
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{
              color:      "var(--cometa-fg-muted)",
              border:     "1px solid var(--cometa-card-border)",
              fontWeight: 500,
              background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
            }}
            title="Exportar KPIs a CSV"
          >
            {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            <span className="hidden sm:inline">CSV</span>
          </button>
        )}

        {onInviteClick && (
          <button
            onClick={onInviteClick}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-opacity hover:opacity-70"
            style={{
              color:      "var(--cometa-fg-muted)",
              border:     "1px solid var(--cometa-card-border)",
              fontWeight: 500,
              background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
            }}
            title="Invitar Founder"
          >
            <UserPlus size={12} />
            <span className="hidden sm:inline">Invitar</span>
          </button>
        )}

        {/* Settings gear — highlighted when activeTab === "settings" */}
        <button
          onClick={() => onTabChange?.("settings")}
          title="Configuración"
          className="flex items-center justify-center rounded-lg p-2 transition-all duration-150 hover:opacity-100"
          style={{
            color:      activeTab === "settings" ? "var(--cometa-fg)" : "var(--cometa-fg-muted)",
            opacity:    activeTab === "settings" ? 1 : 0.5,
            background: activeTab === "settings"
              ? "color-mix(in srgb, var(--cometa-fg) 8%, transparent)"
              : "transparent",
            border: activeTab === "settings"
              ? "1px solid var(--cometa-card-border)"
              : "1px solid transparent",
          }}
        >
          <Settings size={14} style={{ transition: "transform 300ms ease" }} />
        </button>

        <ThemeSwitcher />

        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-opacity hover:opacity-70"
          style={{
            color:      "var(--cometa-fg-muted)",
            border:     "1px solid var(--cometa-card-border)",
            fontWeight: 500,
            background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
          }}
        >
          <LogOut size={13} />
          <span className="hidden sm:inline">Salir</span>
        </button>
      </div>
    </motion.header>
  );
}
