"use client";

/**
 * /analyst/portfolio — Portfolio KPI Comparison Table.
 *
 * Two tabs:
 *   "Documentos"  — PDFs reales subidos por founders (source ≠ bigquery_legacy)
 *   "Histórico"   — Datos legacy de BigQuery (source = bigquery_legacy)
 */

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { ArrowLeft, Search, RefreshCw, TrendingUp, TrendingDown, Minus, FileText, Database } from "lucide-react";
import { validateSession, apiGet } from "@/services/api-client";
import { extractKPIs } from "@/services/analyst";
import { z } from "zod";
import AppHeader from "@/components/analyst/AppHeader";
import GeometricBackground from "@/components/analyst/GeometricBackground";
import type { UserInfo } from "@/services/api-client";

// ── Inline schema ─────────────────────────────────────────────────────────────
const allResultsSchema = z.object({
  status:  z.string(),
  results: z.array(
    z.object({
      id:   z.string(),
      data: z.record(z.string(), z.unknown()),
      date: z.string(),
      metadata: z.object({
        original_filename: z.string(),
        founder_email:     z.string(),
        file_hash:         z.string(),
        processed_at:      z.string(),
        gcs_path:          z.string().default(""),
        company_domain:    z.string().optional(),
        portfolio_id:      z.string().optional(),
      }),
    })
  ),
  total: z.number().optional(),
});

function formatPeriod(raw: string): string {
  const m = raw.match(/^P(\d{4})Q(\d)M\d{2}$/);
  if (m) return `Q${m[2]} ${m[1]}`;
  try {
    return new Date(raw).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return raw;
  }
}


function parseNum(v: string): number | null {
  if (!v || v === "—") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

function TrendIcon({ value }: { value: string }) {
  const n = parseNum(value);
  if (n === null) return <Minus size={11} style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }} />;
  if (n > 0)      return <TrendingUp size={11} className="text-kpi-positive" />;
  return               <TrendingDown size={11} className="text-kpi-negative" />;
}

interface CompanyRow {
  domain:        string;
  lastDate:      string;
  revenueGrowth: string;
  grossMargin:   string;
  ebitdaMargin:  string;
  isLegacy:      boolean;
  founderEmail:  string;
  filename:      string;
}

// ── Company table ─────────────────────────────────────────────────────────────

function CompanyTable({
  rows,
  onRowClick,
  showEmail,
}: {
  rows:       CompanyRow[];
  onRowClick: (domain: string) => void;
  showEmail:  boolean;
}) {
  const cols = showEmail
    ? "2fr 1.2fr 1fr 1fr 1fr 1fr"
    : "2fr 1fr 1fr 1fr 1fr";

  if (rows.length === 0) {
    return (
      <div
        className="py-14 text-center text-[13px] rounded-2xl"
        style={{
          color:  "var(--cometa-fg-muted)",
          opacity: 0.4,
          border: "1px dashed var(--cometa-card-border)",
        }}
      >
        Sin datos
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ border: "1px solid var(--cometa-card-border)" }}
    >
      {/* Header */}
      <div
        className="grid gap-4 px-5 py-2.5 text-[9px] uppercase tracking-widest"
        style={{
          gridTemplateColumns: cols,
          color:        "var(--cometa-fg-muted)",
          borderBottom: "1px solid var(--cometa-card-border)",
          background:   "color-mix(in srgb, var(--cometa-fg) 3%, transparent)",
        }}
      >
        <span>Empresa</span>
        {showEmail && <span>Founder</span>}
        <span>Rev. Growth</span>
        <span>Gross Margin</span>
        <span>EBITDA Margin</span>
        <span>Último período</span>
      </div>

      {/* Rows */}
      <AnimatePresence>
        {rows.map((row, idx) => (
          <motion.div
            key={row.domain}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: idx * 0.025 }}
            className="grid gap-4 px-5 py-3 cursor-pointer transition-colors
                       hover:bg-[color-mix(in_srgb,var(--cometa-fg)_3%,transparent)]"
            style={{
              gridTemplateColumns: cols,
              borderBottom: idx < rows.length - 1
                ? "1px solid var(--cometa-card-border)"
                : "none",
            }}
            onClick={() => onRowClick(row.domain)}
          >
            {/* Domain */}
            <span
              className="text-[13px] font-light truncate"
              style={{ color: "var(--cometa-fg)" }}
              title={row.domain}
            >
              {row.domain}
            </span>

            {/* Founder email — only in Documentos tab */}
            {showEmail && (
              <span
                className="text-[11px] truncate"
                style={{ color: "var(--cometa-fg-muted)" }}
                title={row.founderEmail}
              >
                {row.founderEmail || "—"}
              </span>
            )}

            {/* Revenue Growth */}
            <span className="flex items-center gap-1.5 text-[13px]"
                  style={{ color: "var(--cometa-fg)", fontWeight: 300 }}>
              <TrendIcon value={row.revenueGrowth} />
              {row.revenueGrowth}
            </span>

            {/* Gross Margin */}
            <span className="flex items-center gap-1.5 text-[13px]"
                  style={{ color: "var(--cometa-fg)", fontWeight: 300 }}>
              <TrendIcon value={row.grossMargin} />
              {row.grossMargin}
            </span>

            {/* EBITDA Margin */}
            <span className="flex items-center gap-1.5 text-[13px]"
                  style={{ color: "var(--cometa-fg)", fontWeight: 300 }}>
              <TrendIcon value={row.ebitdaMargin} />
              {row.ebitdaMargin}
            </span>

            {/* Period */}
            <span className="text-[11px]"
                  style={{ color: "var(--cometa-fg-muted)", opacity: 0.55 }}>
              {row.lastDate && row.lastDate !== "unknown" ? formatPeriod(row.lastDate) : "—"}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const router = useRouter();

  const [user,     setUser]     = useState<UserInfo | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [rows,     setRows]     = useState<CompanyRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [search,   setSearch]   = useState("");
  const [tab,      setTab]      = useState<"docs" | "legacy">("docs");

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const res = await apiGet("/api/results/all", allResultsSchema);

      // Group by domain — keep latest result per company
      const byCompany = new Map<string, {
        date:         string;
        data:         Record<string, unknown>;
        founderEmail: string;
        filename:     string;
      }>();

      for (const r of res.results) {
        const domain = r.metadata.company_domain ?? r.id ?? "unknown";
        const existing = byCompany.get(domain);
        if (!existing || r.date > existing.date) {
          byCompany.set(domain, {
            date:         r.date,
            data:         r.data,
            founderEmail: r.metadata.founder_email,
            filename:     r.metadata.original_filename,
          });
        }
      }

      const built: CompanyRow[] = [];
      byCompany.forEach(({ date, data, founderEmail, filename }, domain) => {
        // extractKPIs expects an AnalysisResult array — wrap the single result
        const kpis = extractKPIs([{ id: domain, data, date, metadata: {
          file_hash: "", original_filename: filename,
          founder_email: founderEmail, processed_at: date, gcs_path: "",
        }}]);
        built.push({
          domain,
          lastDate:      date,
          founderEmail,
          filename,
          isLegacy:      (data as Record<string, unknown>)._source === "bigquery_legacy",
          revenueGrowth: kpis.revenueGrowth ?? "—",
          grossMargin:   kpis.grossMargin   ?? "—",
          ebitdaMargin:  kpis.ebitdaMargin  ?? "—",
        });
      });

      built.sort((a, b) => a.domain.localeCompare(b.domain));
      setRows(built);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error cargando datos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    validateSession().then((u) => { setUser(u); setHydrated(true); });
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const docs   = useMemo(() => rows.filter((r) => !r.isLegacy), [rows]);
  const legacy = useMemo(() => rows.filter((r) =>  r.isLegacy), [rows]);

  const activeRows = tab === "docs" ? docs : legacy;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeRows;
    return activeRows.filter((r) => r.domain.toLowerCase().includes(q));
  }, [activeRows, search]);

  if (!hydrated) return null;

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: "var(--cometa-bg)" }}>
      <AppHeader user={user} />

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <GeometricBackground />

        <div className="relative z-10 flex flex-1 flex-col overflow-hidden">

          {/* ── Sticky bar ── */}
          <div
            className="sticky top-0 z-30 shrink-0 border-b px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap"
            style={{
              borderColor:    "var(--cometa-card-border)",
              background:     "color-mix(in srgb, var(--cometa-bg) 70%, transparent)",
              backdropFilter: "blur(12px)",
            }}
          >
            <button
              onClick={() => router.push("/analyst/dashboard")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]
                         transition-opacity hover:opacity-70 shrink-0"
              style={{
                color:      "var(--cometa-fg-muted)",
                border:     "1px solid var(--cometa-card-border)",
                background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
              }}
            >
              <ArrowLeft size={12} />
              Dashboard
            </button>

            <h1
              className="text-[14px] shrink-0"
              style={{ color: "var(--cometa-fg)", fontWeight: 100, letterSpacing: "0.04em" }}
            >
              Comparativa de Portfolio
            </h1>

            {/* ── Tab pills ── */}
            <div className="flex gap-1">
              {(["docs", "legacy"] as const).map((t) => {
                const active = tab === t;
                const count  = t === "docs" ? docs.length : legacy.length;
                const Icon   = t === "docs" ? FileText : Database;
                const label  = t === "docs" ? "Documentos" : "Histórico BQ";
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-all"
                    style={{
                      background: active
                        ? "var(--cometa-accent)"
                        : "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
                      border: active
                        ? "1px solid var(--cometa-accent)"
                        : "1px solid var(--cometa-card-border)",
                      color: active ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
                      fontWeight: active ? 500 : 400,
                    }}
                  >
                    <Icon size={11} />
                    {label}
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px]"
                      style={{
                        background: active
                          ? "color-mix(in srgb, var(--cometa-accent-fg) 20%, transparent)"
                          : "color-mix(in srgb, var(--cometa-fg) 8%, transparent)",
                        color: active ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
                      }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div className="relative ml-auto w-44">
              <Search
                size={11}
                className="absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: "var(--cometa-fg-muted)" }}
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar startup…"
                className="w-full rounded-lg pl-7 pr-3 py-1.5 text-[12px] outline-none"
                style={{
                  background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                  border:     "1px solid var(--cometa-card-border)",
                  color:      "var(--cometa-fg)",
                  fontWeight: 400,
                }}
              />
            </div>

            <button
              onClick={fetchData}
              disabled={loading}
              className="rounded-lg p-1.5 transition-opacity disabled:opacity-40 hover:opacity-70 shrink-0"
              style={{ color: "var(--cometa-fg-muted)" }}
              title="Refrescar"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          {/* ── Main content ── */}
          <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">

            {error && (
              <div
                className="mb-4 rounded-xl px-4 py-3 text-[12px]"
                style={{
                  background: "color-mix(in srgb, #f87171 10%, transparent)",
                  border:     "1px solid color-mix(in srgb, #f87171 20%, transparent)",
                  color:      "#f87171",
                }}
              >
                {error}
              </div>
            )}

            {loading ? (
              <div className="space-y-1.5">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="h-11 rounded-xl animate-pulse"
                    style={{ background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)" }}
                  />
                ))}
              </div>
            ) : (
              <>
                {/* Context label */}
                <p className="mb-3 text-[10px] uppercase tracking-widest"
                   style={{ color: "var(--cometa-fg-muted)", opacity: 0.5 }}>
                  {tab === "docs"
                    ? "PDFs procesados y subidos por founders"
                    : "Datos históricos importados desde BigQuery"}
                </p>

                <CompanyTable
                  rows={filtered}
                  onRowClick={(domain) =>
                    router.push(`/analyst/dashboard?company=${encodeURIComponent(domain)}`)
                  }
                  showEmail={tab === "docs"}
                />

                {filtered.length > 0 && (
                  <p className="mt-4 text-[10px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }}>
                    {filtered.length} empresa{filtered.length !== 1 ? "s" : ""}
                    {search ? ` · filtrado por "${search}"` : ""}
                  </p>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
