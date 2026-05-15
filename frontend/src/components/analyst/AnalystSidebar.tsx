"use client";

/**
 * AnalystSidebar — matches fron/PortfolioSidebar exactly.
 *
 * Structure:
 *   1. motion.aside entry animation (x: -20 → 0)
 *   2. Full-width collapse toggle — ChevronRight rotates 180° when expanded
 *   3. Content (visible when !collapsed):
 *        "Fondo"    label + <select> dropdown
 *        "Empresas" label + company list (Building2 + name)
 *
 * Widths: w-12 collapsed / w-64 expanded
 * Real data from /api/portfolio-companies (no auth required).
 */

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Building2, ChevronRight, X, Loader2, UserPlus, Mail, ChevronDown, ClipboardCheck } from "lucide-react";
import { getPortfolioCompanies } from "@/services/analyst";
import { apiGet } from "@/services/api-client";
import {
  invitationsResponseSchema,
  type Invitation,
  type PortfolioEntry,
  type PortfolioCompanyEntry,
} from "@/lib/schemas";

const FUND_LABELS: Record<string, string> = {
  CIII: "Cometa III",
  VII:  "Cometa VII",
};

export interface AnalystSidebarProps {
  selectedCompanyId: string | null;
  onCompanySelect:   (id: string) => void;
  selectedFund?:     string | null;
  onFundSelect?:     (fund: string) => void;
  mobileOpen?:       boolean;
  onMobileClose?:    () => void;
  onInviteClick?:    () => void;
}

export default function AnalystSidebar({
  selectedCompanyId,
  onCompanySelect,
  selectedFund = null,
  onFundSelect,
  mobileOpen = false,
  onMobileClose,
  onInviteClick,
}: AnalystSidebarProps) {
  const router   = useRouter();
  const pathname = usePathname();
  const [collapsed,         setCollapsed]         = useState(false);
  const [portfolios,        setPortfolios]        = useState<PortfolioEntry[]>([]);
  const [invitations,       setInvitations]       = useState<Invitation[]>([]);
  const [invitesOpen,       setInvitesOpen]       = useState(false);
  const [invitesLoading,    setInvitesLoading]    = useState(false);
  const [comboOpen,         setComboOpen]         = useState(false);
  const [comboSearch,       setComboSearch]       = useState("");

  useEffect(() => {
    getPortfolioCompanies().then(setPortfolios);
  }, []);

  async function loadInvitations() {
    if (invitesLoading) return;
    setInvitesLoading(true);
    try {
      const res = await apiGet("/api/admin/invitations", invitationsResponseSchema);
      setInvitations(res.invitations);
    } catch {
      // silently fail — not all contexts have invitations
    } finally {
      setInvitesLoading(false);
    }
  }

  function toggleInvites() {
    if (!invitesOpen) loadInvitations();
    setInvitesOpen((v) => !v);
  }

  const companies: PortfolioCompanyEntry[] = selectedFund
    ? (portfolios.find((p) => p.portfolio_id === selectedFund)?.companies ?? [])
    : portfolios.flatMap((p) => p.companies);

  function handleCompanyClick(entry: PortfolioCompanyEntry) {
    // Use `id` (canonical company_id from API) if available, fall back to `key`
    onCompanySelect(entry.id ?? entry.company_id ?? entry.key);
    onMobileClose?.();
  }

  const content = (
    <div
      className="flex h-full flex-col"
      style={{ background: "color-mix(in srgb, var(--cometa-bg) 95%, transparent)" }}
    >
      {/* ── Collapse toggle ── */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center p-3 border-b transition-colors"
        style={{
          borderColor: "var(--cometa-card-border)",
          color:       "var(--cometa-fg-muted)",
          justifyContent: onMobileClose ? "space-between" : collapsed ? "center" : "flex-end",
        }}
      >
        {onMobileClose && (
          <span
            className="lg:hidden"
            onClick={(e) => { e.stopPropagation(); onMobileClose(); }}
          >
            <X size={14} />
          </span>
        )}
        <ChevronRight
          size={16}
          style={{ transition: "transform 0.3s", transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}
        />
      </button>

      {/* ── Expanded content ── */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-6"
          >
            {/* Fund combobox */}
            <div>
              <label
                className="text-[10px] uppercase tracking-widest mb-2 block"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                Fondo
              </label>
              {portfolios.length === 0 ? (
                <div
                  className="w-full h-9 rounded-md animate-pulse"
                  style={{ background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)" }}
                />
              ) : (
                <div className="relative">
                  <button
                    onClick={() => { setComboOpen((v) => !v); setComboSearch(""); }}
                    className="w-full rounded-md px-3 py-2 text-sm flex items-center justify-between gap-1 outline-none"
                    style={{
                      background: selectedFund
                        ? "var(--cometa-accent)"
                        : "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                      border:     selectedFund
                        ? "1px solid var(--cometa-accent)"
                        : "1px solid var(--cometa-card-border)",
                      color:      selectedFund ? "var(--cometa-accent-fg)" : "var(--cometa-fg)",
                      fontWeight: selectedFund ? 500 : 400,
                    }}
                  >
                    <span className="truncate">
                      {selectedFund
                        ? (FUND_LABELS[selectedFund] ?? selectedFund)
                        : "Todos los fondos"}
                    </span>
                    <ChevronDown
                      size={12}
                      style={{
                        flexShrink: 0,
                        transition: "transform 0.2s",
                        transform: comboOpen ? "rotate(180deg)" : "rotate(0deg)",
                        opacity: 0.6,
                      }}
                    />
                  </button>

                  <AnimatePresence>
                    {comboOpen && (
                      <>
                        {/* Click-outside backdrop */}
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setComboOpen(false)}
                        />
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.12 }}
                          className="absolute left-0 right-0 z-50 mt-1 rounded-md overflow-hidden"
                          style={{
                            background: "var(--cometa-bg)",
                            border:     "1px solid var(--cometa-card-border)",
                            boxShadow:  "0 8px 24px rgba(0,0,0,0.4)",
                          }}
                        >
                          {/* Search input */}
                          <div
                            className="px-2 py-1.5 border-b"
                            style={{ borderColor: "var(--cometa-card-border)" }}
                          >
                            <input
                              autoFocus
                              placeholder="Buscar fondo…"
                              value={comboSearch}
                              onChange={(e) => setComboSearch(e.target.value)}
                              className="w-full bg-transparent text-xs outline-none px-1"
                              style={{ color: "var(--cometa-fg)" }}
                            />
                          </div>

                          {/* All Funds option */}
                          {"todos los fondos".includes(comboSearch.toLowerCase()) && (
                            <button
                              onClick={() => { onFundSelect?.(""); setComboOpen(false); }}
                              className="w-full text-left px-3 py-2 text-sm transition-colors"
                              style={{
                                color:      !selectedFund ? "var(--cometa-accent-fg)" : "var(--cometa-fg)",
                                background: !selectedFund ? "var(--cometa-accent)" : "transparent",
                                fontWeight: !selectedFund ? 500 : 400,
                              }}
                            >
                              Todos los fondos
                            </button>
                          )}

                          {/* Per-fund options */}
                          {portfolios
                            .filter((p) =>
                              (FUND_LABELS[p.portfolio_id] ?? p.portfolio_name)
                                .toLowerCase()
                                .includes(comboSearch.toLowerCase()),
                            )
                            .map((p) => {
                              const label    = FUND_LABELS[p.portfolio_id] ?? p.portfolio_name;
                              const isActive = selectedFund === p.portfolio_id;
                              return (
                                <button
                                  key={p.portfolio_id}
                                  onClick={() => { onFundSelect?.(p.portfolio_id); setComboOpen(false); }}
                                  className="w-full text-left px-3 py-2 text-sm transition-colors"
                                  style={{
                                    color:      isActive ? "var(--cometa-accent-fg)" : "var(--cometa-fg)",
                                    background: isActive ? "var(--cometa-accent)" : "transparent",
                                    fontWeight: isActive ? 500 : 400,
                                  }}
                                >
                                  {label}
                                </button>
                              );
                            })}
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>

            {/* Company list */}
            <div>
              <label
                className="text-[10px] uppercase tracking-widest mb-2 block"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                Empresas
              </label>

              {companies.length === 0 ? (
                <div className="space-y-1">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-9 rounded-md animate-pulse"
                      style={{ background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)" }}
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {companies.map((entry) => {

                    const active = entry.key === selectedCompanyId;
                    const isOvw  = entry.is_overview;

                    // ── Button style: 2 states (analysts see all companies) ──
                    // 1. active   — accent highlight
                    // 2. default  — overview gets subtle border, rest plain
                    const buttonStyle: React.CSSProperties = active ? {
                      background: "var(--cometa-accent)",
                      color:      "var(--cometa-accent-fg)",
                      border:     "1px solid var(--cometa-accent)",
                    } : isOvw ? {
                      color:      "var(--cometa-fg)",
                      border:     "1px solid color-mix(in srgb, var(--cometa-fg-muted) 15%, transparent)",
                      background: "color-mix(in srgb, var(--cometa-fg) 3%, transparent)",
                      opacity:    1,
                    } : {
                      color:      "var(--cometa-fg)",
                      border:     "1px solid transparent",
                      opacity:    1,
                    };

                    return (
                      <button
                        key={entry.key}
                        onClick={() => handleCompanyClick(entry)}
                        title={entry.label}
                        className="w-full text-left px-3 py-2 rounded-md text-sm transition-all flex items-center gap-2"
                        style={buttonStyle}
                      >
                        <Building2
                          size={14}
                          className="shrink-0"
                          style={{ opacity: active ? 1 : hasData ? 0.7 : 0.4 }}
                        />
                        <span className="truncate">{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Mesa de Control — staging queue */}
            <div className="pt-2 border-t" style={{ borderColor: "var(--cometa-card-border)" }}>
              <button
                onClick={() => { router.push("/analyst/staging"); onMobileClose?.(); }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
                style={{
                  background: pathname === "/analyst/staging"
                    ? "var(--cometa-accent)"
                    : "transparent",
                  color: pathname === "/analyst/staging"
                    ? "var(--cometa-accent-fg)"
                    : "var(--cometa-fg-muted)",
                  border: "1px solid transparent",
                }}
              >
                <ClipboardCheck size={13} className="shrink-0" />
                {!collapsed && <span>Mesa de Control</span>}
              </button>
            </div>

            {/* Invitaciones Enviadas — collapsible */}
            <div className="pt-2 border-t" style={{ borderColor: "var(--cometa-card-border)" }}>
              <button
                onClick={toggleInvites}
                className="flex w-full items-center justify-between px-1 py-1.5 text-[10px] uppercase tracking-widest transition-opacity hover:opacity-70"
                style={{ color: "var(--cometa-fg-muted)" }}
              >
                <span className="flex items-center gap-1.5">
                  <Mail size={10} />
                  Invitaciones Enviadas
                  {invitations.length > 0 && (
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[8px]"
                      style={{
                        background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)",
                        color:      "var(--cometa-fg-muted)",
                      }}
                    >
                      {invitations.length}
                    </span>
                  )}
                </span>
                <ChevronDown
                  size={11}
                  style={{ transition: "transform 0.2s", transform: invitesOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                />
              </button>

              <AnimatePresence initial={false}>
                {invitesOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ overflow: "hidden" }}
                  >
                    <div className="mt-1 space-y-1">
                      {invitesLoading ? (
                        <div className="flex items-center gap-1.5 px-2 py-1.5">
                          <Loader2 size={10} className="animate-spin" style={{ color: "var(--cometa-fg-muted)" }} />
                          <span className="text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.5 }}>
                            Cargando…
                          </span>
                        </div>
                      ) : invitations.length === 0 ? (
                        <p className="px-2 py-1.5 text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }}>
                          Sin invitaciones
                        </p>
                      ) : (
                        invitations.map((inv) => {
                          const isPending = inv.status === "PENDING_INVITE";
                          return (
                            <div
                              key={inv.email}
                              className="rounded-md px-2 py-1.5 flex items-start justify-between gap-2"
                              style={{
                                background: "color-mix(in srgb, var(--cometa-fg) 3%, transparent)",
                                border:     "1px solid var(--cometa-card-border)",
                              }}
                            >
                              <div className="min-w-0">
                                <p className="truncate text-[11px]" style={{ color: "var(--cometa-fg)", fontWeight: 400 }}>
                                  {inv.email}
                                </p>
                                {inv.company_id && (
                                  <p className="truncate text-[10px] mt-0.5" style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}>
                                    {inv.company_id}
                                  </p>
                                )}
                              </div>
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[8px] uppercase tracking-widest mt-0.5"
                                style={isPending ? {
                                  background: "color-mix(in srgb, var(--cometa-accent) 10%, transparent)",
                                  color:      "var(--cometa-accent)",
                                  border:     "1px solid color-mix(in srgb, var(--cometa-accent) 20%, transparent)",
                                } : {
                                  background: "color-mix(in srgb, #34d399 10%, transparent)",
                                  color:      "#34d399",
                                  border:     "1px solid color-mix(in srgb, #34d399 20%, transparent)",
                                }}
                              >
                                {isPending ? "Pendiente" : "Activo"}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Invite Founder — always visible at bottom */}
            <div className="pt-2 border-t" style={{ borderColor: "var(--cometa-card-border)" }}>
              <button
                onClick={onInviteClick}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-[12px]
                           transition-opacity hover:opacity-80"
                style={{
                  color:      "var(--cometa-accent-fg)",
                  border:     "1px solid var(--cometa-accent)",
                  fontWeight: 500,
                  background: "var(--cometa-accent)",
                }}
              >
                <UserPlus size={12} className="shrink-0" />
                Invitar
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <motion.aside
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="hidden lg:flex h-full shrink-0 flex-col border-r transition-all duration-300 overflow-hidden"
        style={{
          width:       collapsed ? "3rem" : "16rem",
          borderColor: "var(--cometa-card-border)",
        }}
      >
        {content}
      </motion.aside>

      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-30 lg:hidden"
              style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={onMobileClose}
            />
            <motion.aside
              className="fixed left-0 top-0 z-40 h-full border-r lg:hidden overflow-hidden"
              style={{ width: "16rem", borderColor: "var(--cometa-card-border)" }}
              initial={{ x: -256 }} animate={{ x: 0 }} exit={{ x: -256 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              {content}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
