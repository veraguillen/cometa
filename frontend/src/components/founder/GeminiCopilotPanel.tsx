"use client";

/**
 * CometaCopilotPanel — Terminal de análisis IA para el Founder.
 *
 * Análisis de nivel analista VC:
 *   - Detección de confianza por tier (alta/media/baja)
 *   - Ratios cross-KPI computados (LTV/CAC, Runway, Gross Margin)
 *   - Inferencia del tipo de documento por patrón de KPIs
 *   - Recomendaciones específicas de documentos para cubrir gaps
 *   - Anomalías financieras con benchmarks de mercado
 *   - Priorización de KPIs para desbloquear más análisis
 *
 * LED:  azul=procesando  verde=listo  ámbar=atención  rojo=crítico
 * Fuente: JetBrains Mono — estética terminal.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence, type Transition } from "framer-motion";
import { X, Target, Send } from "lucide-react";
import type { KpiGridRow } from "@/lib/schemas";
import { apiStream } from "@/services/api-client";

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════

type Phase    = "welcome" | "scanning" | "findings" | "rescue" | "complete";
type LedColor = "blue" | "green" | "amber" | "red";
type MsgKind  = "system" | "success" | "warning" | "error" | "info" | "insight";

interface LogEntry {
  id:      string;
  kind:    MsgKind;
  text:    string;
  kpiId?:  string;
  alias?:  string;
  ts:      number;
  typed:   boolean;
  isUser?: boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
// ALIAS MAP — nombres alternativos en documentos financieros
// ══════════════════════════════════════════════════════════════════════════════

const KPI_ALIASES: Record<string, string[]> = {
  "KPI-001": ["Revenue", "Ingresos Netos", "Total Revenue", "Ventas Totales", "Net Revenue", "Ingresos"],
  "KPI-002": ["Gross Profit", "Utilidad Bruta", "Beneficio Bruto", "Ganancia Bruta"],
  "KPI-003": ["Gross Margin", "Margen Bruto", "Gross Profit Margin", "% Margen Bruto", "Gross Margin %"],
  "KPI-004": ["EBITDA", "EBIT", "Operating Income", "Utilidad Operativa", "Resultado Operativo"],
  "KPI-026": ["Cash", "Efectivo", "Cash in Bank", "Caja y Bancos", "Saldo de Caja", "Disponible"],
  "KPI-035": ["Burn Rate", "Quema Mensual", "Monthly Cash Burn", "Gasto Neto", "Net Burn", "Cash Burn"],
  "KPI-036": ["Runway", "Meses de Runway", "Months of Runway", "Meses de Caja"],
  "KPI-047": ["MRR", "Monthly Recurring Revenue", "Ingreso Recurrente Mensual", "ARR/12"],
  "KPI-053": ["CAC", "Customer Acquisition Cost", "Costo de Adquisición de Clientes", "Costo por Cliente"],
  "KPI-055": ["CAC Payback", "Payback Period", "Meses de Recuperación CAC"],
  "KPI-056": ["LTV/CAC", "LTV CAC Ratio", "Lifetime Value to CAC", "Relación LTV/CAC"],
  "KPI-100": ["Churn Rate", "Tasa de Cancelación", "Customer Churn", "Logo Churn", "Abandono", "Churn %"],
  "KPI-101": ["Employees", "Empleados", "Headcount", "Team Size", "FTEs"],
};

// Sección del documento donde suele aparecer cada KPI
const KPI_LOCATION: Record<string, string> = {
  "KPI-001": "Estado de Resultados · línea 'Ingresos / Revenue'",
  "KPI-002": "Estado de Resultados · 'Utilidad Bruta / Gross Profit'",
  "KPI-003": "Estado de Resultados · 'Margen Bruto %'",
  "KPI-004": "Estado de Resultados · sección EBITDA o Utilidad Operativa",
  "KPI-026": "Balance General · Activo Circulante · 'Caja y Bancos'",
  "KPI-035": "Estado de Flujo de Efectivo · 'Variación neta de caja / Net Cash Burn'",
  "KPI-036": "Dashboard financiero · 'Runway' o calculado como Cash / Burn",
  "KPI-047": "Dashboard SaaS o resumen ejecutivo · 'MRR'",
  "KPI-053": "Marketing report o deck de métricas · 'CAC'",
  "KPI-056": "Dashboard SaaS · 'LTV/CAC ratio'",
  "KPI-100": "Dashboard SaaS · 'Churn Rate %' o reporte de retención",
};

// ══════════════════════════════════════════════════════════════════════════════
// ANÁLISIS FINANCIERO — ratios y anomalías
// ══════════════════════════════════════════════════════════════════════════════

interface Anomaly {
  kpiId:    string;
  kpiName:  string;
  message:  string;
  severity: "critical" | "warning";
}

interface Ratio {
  name:   string;
  value:  string;
  signal: "good" | "warn" | "bad" | "neutral";
  note:   string;
}

function fmt(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function getVal(grid: KpiGridRow[], id: string): number | null {
  const row = grid.find((r) => r.kpi_id === id && r.value !== null);
  return row?.value ?? null;
}

/** Calcula ratios cross-KPI a partir de los valores disponibles. */
function computeRatios(grid: KpiGridRow[]): Ratio[] {
  const ratios: Ratio[] = [];

  const ltvCac  = getVal(grid, "KPI-056"); // LTV/CAC ratio directo
  const cac     = getVal(grid, "KPI-053");
  const cash    = getVal(grid, "KPI-026");
  const burn    = getVal(grid, "KPI-035");
  const runway  = getVal(grid, "KPI-036"); // runway en meses, si está directo
  const churn   = getVal(grid, "KPI-100");
  const gm      = getVal(grid, "KPI-003"); // Gross Margin %
  const revenue = getVal(grid, "KPI-001");
  const mrr     = getVal(grid, "KPI-047");

  // LTV/CAC ratio — si viene directo del KPI-056
  if (ltvCac !== null) {
    ratios.push({
      name:   "LTV/CAC",
      value:  `${ltvCac.toFixed(1)}x`,
      signal: ltvCac >= 3 ? "good" : ltvCac >= 1 ? "warn" : "bad",
      note:   ltvCac >= 3
        ? "saludable (benchmark VC: ≥3x)"
        : ltvCac >= 1
          ? "por debajo del benchmark VC (≥3x)"
          : "crítico — estás perdiendo dinero por cliente",
    });
  }

  // Runway — directo si existe KPI-036, si no lo calculamos
  if (runway !== null) {
    ratios.push({
      name:   "Runway",
      value:  `${runway.toFixed(1)} meses`,
      signal: runway >= 18 ? "good" : runway >= 6 ? "warn" : "bad",
      note:   runway >= 18
        ? "sólido — suficiente para levantar ronda"
        : runway >= 6
          ? "ajustado — considera levantar antes de 90 días"
          : "⚠ CRÍTICO — menos de 6 meses de vida",
    });
  } else if (cash !== null && burn !== null && burn > 0) {
    const months = cash / burn;
    ratios.push({
      name:   "Runway (calculado)",
      value:  `${months.toFixed(1)} meses`,
      signal: months >= 18 ? "good" : months >= 6 ? "warn" : "bad",
      note:   months >= 18
        ? "sólido — suficiente para levantar ronda"
        : months >= 6
          ? "ajustado — considera levantar antes de 90 días"
          : "⚠ CRÍTICO — menos de 6 meses de vida",
    });
  }

  // Implied Gross Margin from Revenue + Gross Profit
  const gp = getVal(grid, "KPI-002"); // Gross Profit
  if (gp !== null && revenue !== null && revenue > 0 && gm === null) {
    const impliedGm = (gp / revenue) * 100;
    ratios.push({
      name:   "Gross Margin (calculado)",
      value:  `${impliedGm.toFixed(1)}%`,
      signal: impliedGm >= 60 ? "good" : impliedGm >= 30 ? "warn" : "bad",
      note:   impliedGm >= 60
        ? "margen sólido para SaaS/fintech"
        : impliedGm >= 30
          ? "aceptable; SaaS saludable apunta a >60%"
          : "margen bajo — revisa estructura de costos",
    });
  }

  // Gross Margin directo
  if (gm !== null) {
    ratios.push({
      name:   "Gross Margin",
      value:  `${gm.toFixed(1)}%`,
      signal: gm >= 60 ? "good" : gm >= 30 ? "warn" : "bad",
      note:   gm >= 60
        ? "margen sólido para SaaS/fintech"
        : gm >= 30
          ? "aceptable; SaaS saludable apunta a >60%"
          : "margen bajo — revisa estructura de costos",
    });
  }

  // CAC Payback (meses) = CAC / MRR por cliente ≈ CAC / (MRR * GrossMargin/100 / activeCustomers)
  // Aproximación simple: si tenemos CAC y MRR y GrossMargin
  // CAC Payback = CAC / (ARPUgross) donde ARPUgross = MRR * gm/100 / N clientes
  // Sin número de clientes, usamos la heurística: payback ≈ CAC / (MRR * gm/100) si MRR es por cliente
  // Solo disponible si tenemos los 3
  if (cac !== null && mrr !== null && gm !== null && mrr > 0 && gm > 0) {
    const payback = cac / (mrr * (gm / 100));
    if (payback < 1000) { // sanity check — si mrr es total no por cliente, da millones
      ratios.push({
        name:   "CAC Payback",
        value:  `${payback.toFixed(0)} meses`,
        signal: payback <= 12 ? "good" : payback <= 24 ? "warn" : "bad",
        note:   payback <= 12
          ? "excelente (benchmark: <12 meses)"
          : payback <= 24
            ? "aceptable (benchmark VC: <18 meses)"
            : "alto — considera reducir CAC o mejorar margen",
      });
    }
  }

  // Churn implícito: si tenemos MRR pero no churn
  if (churn !== null && mrr !== null && mrr > 0) {
    const churnMrr = (churn / 100) * mrr;
    ratios.push({
      name:   "MRR en riesgo / mes",
      value:  fmt(churnMrr),
      signal: churn <= 3 ? "good" : churn <= 7 ? "warn" : "bad",
      note:   `${churn.toFixed(1)}% churn mensual · ${fmt(churnMrr)} de MRR en riesgo`,
    });
  }

  return ratios;
}

/** Detecta anomalías financieras cross-KPI. */
function detectAnomalies(grid: KpiGridRow[]): Anomaly[] {
  const out: Anomaly[] = [];
  const all = grid.filter((r) => r.value !== null);

  for (const row of all) {
    const val  = row.value!;
    const name = row.display_name ?? row.kpi_id;

    // Porcentaje fuera de rango físico
    if (row.unit === "%" && (val < -100 || val > 500)) {
      out.push({
        kpiId:    row.kpi_id,
        kpiName:  name,
        severity: "warning",
        message:  `${name} = ${val.toFixed(1)}% está fuera de rango. ¿Está en puntos base o como decimal (0.XX)?`,
      });
      continue;
    }

    // Revenue / Cash negativos
    if (["KPI-001", "KPI-026"].includes(row.kpi_id) && val < 0) {
      out.push({
        kpiId:    row.kpi_id,
        kpiName:  name,
        severity: "critical",
        message:  `${name} negativo (${fmt(val)}). Solo válido si es un ajuste contable explícito.`,
      });
      continue;
    }

    // Gross Margin negativo
    if (row.kpi_id === "KPI-003" && val < 0) {
      out.push({
        kpiId:    row.kpi_id,
        kpiName:  name,
        severity: "critical",
        message:  `Gross Margin negativo (${val.toFixed(1)}%) — la empresa está perdiendo dinero en cada venta. Revisa la estructura de COGS.`,
      });
    }

    // Churn extremo
    if (row.kpi_id === "KPI-100") {
      if (val > 100) {
        out.push({ kpiId: row.kpi_id, kpiName: name, severity: "critical",
          message: `Churn de ${val.toFixed(0)}% es imposible mensualmente. ¿Está expresado como % anual?` });
      } else if (val > 10) {
        out.push({ kpiId: row.kpi_id, kpiName: name, severity: "warning",
          message: `Churn mensual de ${val.toFixed(1)}% es muy alto. Benchmark SaaS saludable: <3% mensual. Verifica si es anual.` });
      }
    }
  }

  // Cross-KPI checks
  const rev    = getVal(grid, "KPI-001");
  const burn   = getVal(grid, "KPI-035");
  const ltvCac = getVal(grid, "KPI-056"); // LTV/CAC ratio
  const cac    = getVal(grid, "KPI-053");
  const cash   = getVal(grid, "KPI-026");
  const runway = getVal(grid, "KPI-036");

  if (burn !== null && rev !== null && burn > rev * 1.5) {
    out.push({
      kpiId:    "KPI-035",
      kpiName:  "Burn Rate",
      severity: "warning",
      message:  `Burn Rate (${fmt(burn)}) supera 1.5x el Revenue (${fmt(rev)}). Evalúa si la empresa está en fase pre-revenue intencionalmente.`,
    });
  }

  // LTV/CAC < 1 significa unidad económica negativa
  if (ltvCac !== null && ltvCac < 1) {
    out.push({
      kpiId:    "KPI-056",
      kpiName:  "LTV/CAC",
      severity: "critical",
      message:  `LTV/CAC = ${ltvCac.toFixed(1)}x — unidad económica invertida. La empresa pierde dinero en cada cliente adquirido. Benchmark mínimo: 1x, saludable: ≥3x.`,
    });
  }

  // Runway crítico — calculado o directo
  const runwayMonths = runway ?? (cash !== null && burn !== null && burn > 0 ? cash / burn : null);
  if (runwayMonths !== null && runwayMonths < 6) {
    out.push({
      kpiId:    "KPI-026",
      kpiName:  "Cash / Runway",
      severity: "critical",
      message:  `Runway < 6 meses (${runwayMonths.toFixed(1)}m). Zona de emergencia — el fundraising debe ser la prioridad número 1.`,
    });
  }

  return out;
}

/** Infiere tipo de documento por patrón de KPIs encontrados. */
function inferDocType(grid: KpiGridRow[]): string | null {
  const found = new Set(grid.filter((r) => r.status !== "MISSING").map((r) => r.kpi_id));
  const hasSaaS    = ["KPI-047","KPI-100"].every((k) => found.has(k)); // MRR + Churn son señal SaaS
  const hasFinance = ["KPI-001","KPI-004","KPI-026"].every((k) => found.has(k)); // Revenue + EBITDA + Cash
  const hasHR      = found.has("KPI-101") || grid.some((r) => r.category === "hr_metrics" && r.status !== "MISSING");

  if (hasSaaS && hasFinance) return "deck SaaS completo con métricas financieras";
  if (hasSaaS) return "dashboard de métricas SaaS";
  if (hasFinance && hasHR) return "reporte financiero + operativo";
  if (hasFinance) return "estados financieros";
  return null;
}

/** Recomienda qué documento subir para cerrar los gaps. */
function recommendNextDoc(missingIds: Set<string>): string | null {
  const hasSaaS  = ["KPI-047","KPI-100","KPI-053","KPI-056"].some((k) => missingIds.has(k));
  const hasBS    = ["KPI-026"].some((k) => missingIds.has(k));
  const hasIS    = ["KPI-001","KPI-002","KPI-003","KPI-004"].some((k) => missingIds.has(k));
  const hasCF    = ["KPI-035","KPI-036"].some((k) => missingIds.has(k));

  const docs: string[] = [];
  if (hasIS)   docs.push("Estado de Resultados");
  if (hasBS)   docs.push("Balance General");
  if (hasCF)   docs.push("Flujo de Efectivo");
  if (hasSaaS) docs.push("Dashboard de métricas SaaS / deck ejecutivo");

  return docs.length > 0 ? docs.join(" · ") : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// LED
// ══════════════════════════════════════════════════════════════════════════════

const LED_CFG: Record<LedColor, { color: string; glow: string; label: string }> = {
  blue:  { color: "#60a5fa", glow: "0 0 8px rgba(96,165,250,0.7)",  label: "Analizando" },
  green: { color: "#4ade80", glow: "0 0 8px rgba(74,222,128,0.7)",  label: "Listo"      },
  amber: { color: "#fbbf24", glow: "0 0 8px rgba(251,191,36,0.7)",  label: "Atención"   },
  red:   { color: "#f87171", glow: "0 0 8px rgba(248,113,113,0.7)", label: "Crítico"    },
};

// ══════════════════════════════════════════════════════════════════════════════
// SUBCOMPONENTES
// ══════════════════════════════════════════════════════════════════════════════

function TypingText({ text, active, speed = 12 }: { text: string; active: boolean; speed?: number }) {
  const [displayed, setDisplayed] = useState(active ? "" : text);
  const idxRef   = useRef(active ? 0 : text.length);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) { setDisplayed(text); return; }
    idxRef.current = 0;
    setDisplayed("");
    timerRef.current = setInterval(() => {
      idxRef.current++;
      setDisplayed(text.slice(0, idxRef.current));
      if (idxRef.current >= text.length) {
        clearInterval(timerRef.current!);
        timerRef.current = null;
      }
    }, speed);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active]);

  const done = displayed.length >= text.length;
  return (
    <span>
      {displayed}
      {active && !done && (
        <motion.span
          className="inline-block align-middle ml-[2px]"
          style={{ width: "5px", height: "11px", background: "currentColor" }}
          animate={{ opacity: [1, 0, 1] }}
          transition={{ repeat: Infinity, duration: 0.5 }}
        />
      )}
    </span>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-[3px] items-center">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block rounded-full"
          style={{ width: 4, height: 4, background: "#60a5fa" }}
          animate={{ opacity: [0.2, 1, 0.2], scale: [0.8, 1.1, 0.8] }}
          transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
        />
      ))}
    </span>
  );
}

function LedIndicator({ color, scanning }: { color: LedColor; scanning: boolean }) {
  const c = LED_CFG[color];
  return (
    <div className="relative flex items-center justify-center w-4 h-4 shrink-0">
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{ border: `1px solid ${c.color}` }}
        animate={scanning
          ? { opacity: [0.8, 0.1, 0.8], scale: [1, 1.9, 1] }
          : { opacity: [0.45, 0.12, 0.45] }
        }
        transition={{ repeat: Infinity, duration: scanning ? 1.0 : 2.8 }}
      />
      <motion.div
        className="w-2 h-2 rounded-full"
        style={{ background: c.color, boxShadow: c.glow }}
        animate={scanning ? { opacity: [1, 0.3, 1] } : {}}
        transition={{ repeat: Infinity, duration: 0.75 }}
      />
    </div>
  );
}

// ── Rich text renderer — soporta **bold** y saltos de línea ─────────────────
const CTA_TRIGGER = "¿Quieres que te lleve";

function renderRichText(text: string, color: string): React.ReactNode {
  // Separar el CTA del cuerpo si existe
  const ctaIdx = text.indexOf(CTA_TRIGGER);
  const body   = ctaIdx >= 0 ? text.slice(0, ctaIdx).trimEnd() : text;
  const cta    = ctaIdx >= 0 ? text.slice(ctaIdx) : null;

  const renderLine = (line: string, key: string): React.ReactNode => {
    const segments = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <span key={key}>
        {segments.map((seg, i) =>
          seg.startsWith("**") && seg.endsWith("**")
            ? <strong key={i} style={{ color, fontWeight: 600 }}>{seg.slice(2, -2)}</strong>
            : <span key={i}>{seg}</span>
        )}
      </span>
    );
  };

  const lines = body.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {renderLine(line, `l${i}`)}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
      {cta && (
        <span className="block mt-1 italic opacity-75" style={{ color }}>
          {renderLine(cta, "cta")}
        </span>
      )}
    </>
  );
}

// Estilos por tipo de mensaje
const KIND_STYLE: Record<MsgKind, { color: string; bg: string; border: string; prefix: string }> = {
  system:  { color: "#94a3b8", bg: "transparent",           border: "transparent",           prefix: "·  "  },
  success: { color: "#4ade80", bg: "rgba(74,222,128,0.05)", border: "rgba(74,222,128,0.18)", prefix: "✓  "  },
  warning: { color: "#fbbf24", bg: "rgba(251,191,36,0.05)", border: "rgba(251,191,36,0.18)", prefix: "⚠  "  },
  error:   { color: "#f87171", bg: "rgba(239,68,68,0.07)",  border: "rgba(239,68,68,0.22)",  prefix: "!  "  },
  info:    { color: "#60a5fa", bg: "rgba(96,165,250,0.04)", border: "rgba(96,165,250,0.14)", prefix: "→  "  },
  insight: { color: "#a78bfa", bg: "rgba(167,139,250,0.05)",border: "rgba(167,139,250,0.18)",prefix: "◈  "  },
};

function MsgBubble({
  entry,
  isLatest,
  onAction,
}: {
  entry:    LogEntry;
  isLatest: boolean;
  onAction: (kpiId: string | null) => void;
}) {
  // ── Burbuja del Founder (derecha) ───────────────────────────────────────────
  if (entry.isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex justify-end"
      >
        <div
          className="max-w-[80%] rounded-2xl rounded-tr-sm px-3 py-2 text-[12px] leading-relaxed"
          style={{
            background: "rgba(96,165,250,0.10)",
            border:     "1px solid rgba(96,165,250,0.18)",
            color:      "#94a3b8",
            fontFamily: "var(--font-sans, Inter, sans-serif)",
          }}
        >
          {entry.text}
        </div>
      </motion.div>
    );
  }

  // ── Burbuja de Cometa Assistant (izquierda) ──────────────────────────────────
  const s = KIND_STYLE[entry.kind];
  const hasAction   = !!entry.kpiId;
  const kpiName     = entry.alias ?? (entry.kpiId ? entry.kpiId : null);
  const actionLabel = kpiName ? `Ir a ${kpiName}` : "Revisar datos";

  // Detectar CTA de Cometa Assistant ("¿Quieres que te lleve...")
  const hasCta      = entry.text.includes(CTA_TRIGGER);
  // Usar rich text cuando el mensaje está completo (no animándose)
  const isTypingNow = isLatest && entry.typed;

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-lg px-3 py-2.5 space-y-2"
      style={{
        background: s.bg,
        border:     `1px solid ${s.border}`,
      }}
    >
      <div className="flex gap-1.5 items-start">
        <span
          className="text-[10px] font-bold shrink-0 mt-[1px] select-none"
          style={{ color: s.color, fontFamily: "var(--font-mono, monospace)" }}
        >
          {s.prefix}
        </span>
        <div className="text-[11px] leading-relaxed flex-1" style={{ color: s.color, opacity: 0.9 }}>
          {!entry.text
            ? <ThinkingDots />
            : isTypingNow
              ? <TypingText text={entry.text} active speed={13} />
              : renderRichText(entry.text, s.color)
          }
        </div>
      </div>

      {/* CTA: llevar a campos faltantes */}
      {hasCta && !isTypingNow && (
        <button
          onClick={() => onAction(null)}
          className="ml-3 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-medium
                     transition-all hover:brightness-125 active:scale-95"
          style={{
            background: "rgba(96,165,250,0.10)",
            color:      "#60a5fa",
            border:     "1px solid rgba(96,165,250,0.22)",
          }}
        >
          <Target size={9} style={{ flexShrink: 0 }} />
          Ir a los campos faltantes
        </button>
      )}

      {/* Quick action KPI */}
      {hasAction && !hasCta && entry.text && (
        <button
          onClick={() => onAction(entry.kpiId ?? null)}
          className="ml-3 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-medium
                     transition-all hover:brightness-125 active:scale-95"
          style={{
            background: `rgba(255,255,255,0.06)`,
            color:      s.color,
            border:     `1px solid ${s.border}`,
          }}
        >
          <Target size={9} style={{ flexShrink: 0 }} />
          {actionLabel}
        </button>
      )}
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PROPS
// ══════════════════════════════════════════════════════════════════════════════

export interface CometaCopilotPanelProps {
  kpiGrid:           KpiGridRow[];
  fileName?:         string | null;
  founderEmail?:     string | null;
  /** Nombre de empresa resuelto por company-resolver — fuente de verdad para el saludo. */
  companyName?:      string | null;
  isUploading?:      boolean;
  confidenceScores?: Record<string, number>;
  onFocusKpi?:       (kpiId: string) => void;
  onClose?:          () => void;
  className?:        string;
}

/** Construye un bloque de contexto financiero para inyectar en el prompt del chat. */
function buildFounderContext(grid: KpiGridRow[], company: string | null | undefined): string {
  if (grid.length === 0) return "";
  const found    = grid.filter((r) => r.status === "FOUND" || r.status === "MANUAL_FOUND");
  const critMiss = grid.filter((r) => r.status === "MISSING" && r.innegociable);
  const lines: string[] = [];
  if (company) lines.push(`Empresa: ${company}`);
  if (found.length > 0) {
    lines.push(`KPIs detectados (${found.length}):`);
    found.slice(0, 10).forEach((r) => {
      lines.push(`  - ${r.display_name ?? r.kpi_id}: ${r.value ?? "N/A"} ${r.unit ?? ""}`.trimEnd());
    });
  }
  if (critMiss.length > 0) {
    lines.push(`KPIs innegociables faltantes:`);
    critMiss.slice(0, 5).forEach((r) => {
      lines.push(`  - ${r.display_name ?? r.kpi_id} (${r.kpi_id})`);
    });
  }
  return lines.join("\n");
}

/** Extrae un nombre legible del nombre de archivo del reporte. */
function extractCompanyName(fileName: string | null | undefined): string {
  if (!fileName) return "tu empresa";
  const base = fileName.replace(/\.[^/.]+$/, "");
  const cleaned = base
    .replace(/[-_](reporte|financiero|balance|pnl|estados|deck|kpis?|q[1-4]|\d{4})/gi, "")
    .replace(/(reporte|financiero|balance|pnl|estados|deck|kpis?)[-_]/gi, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2) return "tu empresa";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

export default function CometaCopilotPanel({
  kpiGrid,
  fileName,
  founderEmail,
  companyName,
  isUploading = false,
  confidenceScores,
  onFocusKpi,
  onClose,
  className = "",
}: CometaCopilotPanelProps) {

  const [log,   setLog]   = useState<LogEntry[]>([]);
  const emitted            = useRef(new Set<string>());
  const prevGridRef        = useRef<KpiGridRow[]>([]);
  const scrollRef          = useRef<HTMLDivElement>(null);
  const gridLengthAtMount  = useRef(kpiGrid.length);
  const [isOpen,       setIsOpen]       = useState(false);
  const [unreadCount,  setUnreadCount]  = useState(0);
  const prevLogLenRef  = useRef(0);
  const [inputValue,   setInputValue]   = useState("");
  const [isSending,    setIsSending]    = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const maybeEmit = useCallback((entries: LogEntry[]) => {
    const fresh = entries.filter((e) => !emitted.current.has(e.id));
    if (!fresh.length) return;
    fresh.forEach((e) => emitted.current.add(e.id));
    setLog((prev) => [
      ...prev,
      ...fresh.map((e, i) => ({ ...e, typed: i === fresh.length - 1 ? e.typed : false })),
    ]);
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const found       = kpiGrid.filter((r) => r.status === "FOUND" || r.status === "MANUAL_FOUND");
  const missing     = kpiGrid.filter((r) => r.status === "MISSING");
  const missingCrit = missing.filter((r) => r.innegociable);
  const pct         = kpiGrid.length > 0
    ? Math.round((found.length / kpiGrid.length) * 100)
    : 0;

  const phase: Phase = useMemo(() => {
    if (isUploading)          return "scanning";
    if (kpiGrid.length === 0) return "welcome";
    if (missingCrit.length > 0) return "rescue";
    if (missing.length === 0)   return "complete";
    return "findings";
  }, [isUploading, kpiGrid.length, missingCrit.length, missing.length]);

  const ledColor: LedColor =
    phase === "scanning" ? "blue"  :
    phase === "complete" ? "green" :
    phase === "rescue"   ? "red"   :
    missing.length > 0 && missingCrit.length === 0 ? "amber" :
    "green";

  // ── Auto-open ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (isUploading) setIsOpen(true);
  }, [isUploading]);

  useEffect(() => {
    if (kpiGrid.length > 0 && gridLengthAtMount.current === 0) setIsOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpiGrid.length]);

  // ── Phase: welcome ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (gridLengthAtMount.current > 0) return;
    const company = companyName || "tu empresa";
    const ts = Date.now();
    maybeEmit([
      {
        id:    "welcome-connect",
        kind:  "system",
        text:  "Identidad verificada.",
        ts,
        typed: false,
      },
      {
        id:    "welcome",
        kind:  "system",
        text:  `Hola, soy Cometa Assistant. Estoy preparando la bóveda para ${company}. He configurado los 109 KPIs según tu sector. Sube tu reporte para comenzar.`,
        ts:    ts + 60,
        typed: true,
      },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Phase: scanning ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isUploading) return;
    const ts      = Date.now();
    // companyName (from email resolver) is the authoritative source; fileName is fallback
    const company = companyName || extractCompanyName(fileName) || "tu empresa";
    maybeEmit([
      {
        id:    `scan-1-${ts}`,
        kind:  "system",
        text:  `Hola, he detectado que estás cargando datos para ${company}. Voy a iniciar la auditoría de seguridad.`,
        ts,
        typed: true,
      },
      {
        id:    `scan-2-${ts}`,
        kind:  "info",
        text:  "Leyendo estructura del documento · identificando tablas financieras · cruzando contra los 109 indicadores del portafolio Cometa.",
        ts:    ts + 120,
        typed: false,
      },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUploading]);

  // ── Phase: findings ────────────────────────────────────────────────────────

  useEffect(() => {
    if (kpiGrid.length === 0) return;
    const ts = Date.now();

    // 1. Logros — achievements first para generar confianza
    const docType   = inferDocType(kpiGrid);
    const docHint   = docType ? ` El documento corresponde a un ${docType}.` : "";
    // Nombres de KPIs clave encontrados (máx 3 para no sobrecargar el mensaje)
    const keyFoundNames = found
      .filter((r) => r.innegociable)
      .slice(0, 3)
      .map((r) => r.display_name ?? r.kpi_id);

    const firstMissingCrit = missingCrit[0];
    const missingHint = firstMissingCrit
      ? ` Veo que falta el ${firstMissingCrit.display_name ?? firstMissingCrit.kpi_id} (${firstMissingCrit.kpi_id}). ¿Te parece si lo completamos ahora?`
      : "";

    const achievementText = keyFoundNames.length > 0
      ? `Escaneando... He mapeado con éxito ${keyFoundNames.join(", ")}.${docHint}${missingHint}`
      : `He procesado el documento. ${found.length} indicadores registrados de un total de ${kpiGrid.length}.${docHint}${missingHint}`;

    maybeEmit([{
      id:    `found-summary-${kpiGrid.length}`,
      kind:  "success",
      text:  achievementText,
      kpiId: firstMissingCrit?.kpi_id,
      alias: firstMissingCrit
        ? (KPI_ALIASES[firstMissingCrit.kpi_id]?.[0] ?? firstMissingCrit.display_name ?? firstMissingCrit.kpi_id)
        : undefined,
      ts,
      typed: true,
    }]);

    // 2. Calidad de extracción (si hay scores de confianza)
    if (confidenceScores && Object.keys(confidenceScores).length > 0) {
      const vals = Object.values(confidenceScores);
      const avg  = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      const low  = vals.filter((v) => v < 60).length;

      if (avg >= 75) {
        maybeEmit([{
          id:    `confidence-${kpiGrid.length}`,
          kind:  "success",
          text:  `La calidad de extracción es muy buena — ${avg}% de precisión promedio. Los números están listos para revisión.`,
          ts:    ts + 100,
          typed: false,
        }]);
      } else if (low > 0) {
        const lowNames = kpiGrid
          .filter((r) => r.status === "FOUND" && confidenceScores[r.kpi_id] < 60)
          .slice(0, 2)
          .map((r) => r.display_name ?? r.kpi_id)
          .join(" y ");
        maybeEmit([{
          id:    `low-conf-${kpiGrid.length}`,
          kind:  "warning",
          text:  `Te recomiendo verificar ${lowNames} — el documento presentó ambigüedad en esas líneas. Un vistazo rápido lo confirma.`,
          ts:    ts + 180,
          typed: false,
        }]);
      }
    }

    // 3. Ratios cross-KPI — insights financieros
    const ratios = computeRatios(kpiGrid);
    ratios.forEach((r, i) => {
      const signal = r.signal === "good" ? "insight" : r.signal === "warn" ? "warning" : r.signal === "bad" ? "error" : "info";
      maybeEmit([{
        id:    `ratio-${r.name}-${kpiGrid.length}`,
        kind:  signal as MsgKind,
        text:  `${r.name}: ${r.value} — ${r.note}`,
        ts:    ts + 260 + i * 90,
        typed: false,
      }]);
    });

    // 4. Recomendación de documento faltante
    const nextDocRec = recommendNextDoc(new Set(missing.map((r) => r.kpi_id)));
    if (pct < 50 && nextDocRec) {
      maybeEmit([{
        id:    `doc-rec-${kpiGrid.length}`,
        kind:  "info",
        text:  `Para completar el expediente al 100%, el siguiente documento que necesito es: ${nextDocRec}. ¿Lo tienes disponible?`,
        ts:    ts + 260 + ratios.length * 90 + 80,
        typed: false,
      }]);
    } else if (pct >= 80 && missingCrit.length === 0) {
      maybeEmit([{
        id:    `cov-high-${kpiGrid.length}`,
        kind:  "success",
        text:  `Expediente al ${pct}% — excelente cobertura. Solo quedan ${missing.length} indicadores opcionales que puedes complementar cuando quieras.`,
        ts:    ts + 260 + ratios.length * 90 + 80,
        typed: false,
      }]);
    }

    // 5. KPIs innegociables faltantes — friction amigable, ofrecer soluciones
    const rescueEntries: LogEntry[] = missingCrit.slice(0, 5).map((row, i) => {
      const aliases  = KPI_ALIASES[row.kpi_id] ?? [];
      const location = KPI_LOCATION[row.kpi_id];
      const kpiName  = row.display_name ?? aliases[0] ?? row.kpi_id;
      const alias    = aliases[0] ?? null;
      const locHint  = location ? ` Suele estar en el ${location}.` : "";
      return {
        id:    `rescue-${row.kpi_id}`,
        kind:  "error" as MsgKind,
        text:  `Analicé el documento pero no logré localizar el ${kpiName}. Es un indicador clave para cerrar el reporte.${locHint} ¿Podrías ingresarlo manualmente, o prefieres que lo busquemos en otro archivo?`,
        alias: alias ?? undefined,
        kpiId: row.kpi_id,
        ts:    ts + 450 + i * 160,
        typed: i === 0,
      };
    });
    if (rescueEntries.length > 0) maybeEmit(rescueEntries);

    if (missingCrit.length > 5) {
      maybeEmit([{
        id:    `rescue-extra-${kpiGrid.length}`,
        kind:  "error",
        text:  `Hay ${missingCrit.length - 5} indicadores adicionales que no pude encontrar. Si tienes un deck ejecutivo o dashboard SaaS, con eso podría cerrar el expediente.`,
        ts:    ts + 1100,
        typed: false,
      }]);
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpiGrid.length, missingCrit.length]);

  // ── Phase: complete ────────────────────────────────────────────────────────

  useEffect(() => {
    if (phase !== "complete") return;
    const ratios = computeRatios(kpiGrid);
    const topRatio = ratios.find((r) => r.signal === "good") ?? ratios[0];
    const ratioHighlight = topRatio
      ? ` Tu ${topRatio.name} está en ${topRatio.value}.`
      : "";
    const emailNote = founderEmail
      ? ` He enviado tu recibo de certificación a ${founderEmail}.`
      : " He enviado tu recibo de certificación al correo registrado.";
    maybeEmit([
      {
        id:    "complete-ratios",
        kind:  "insight",
        text:  `Todos los indicadores verificados.${ratioHighlight} El expediente financiero está completo.`,
        ts:    Date.now(),
        typed: false,
      },
      {
        id:    "complete",
        kind:  "success",
        text:  `Protocolo completado. Tu información ha sido cifrada y guardada en la bóveda de Cometa.${emailNote} ¡Buen trabajo hoy!`,
        ts:    Date.now() + 120,
        typed: true,
      },
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Anomaly detection: nuevos MANUAL_FOUND ────────────────────────────────

  useEffect(() => {
    const prev = prevGridRef.current;
    const newManual = kpiGrid.filter((row) => {
      if (row.status !== "MANUAL_FOUND" || row.value === null) return false;
      return prev.find((r) => r.kpi_id === row.kpi_id)?.status !== "MANUAL_FOUND";
    });

    if (newManual.length > 0) {
      const ts    = Date.now();
      const names = newManual.map((r) => r.display_name ?? r.kpi_id).join(" y ");
      maybeEmit([{
        id:    `manual-ack-${newManual.map((r) => r.kpi_id).join("-")}`,
        kind:  "success",
        text:  `Perfecto, ${names} ${newManual.length > 1 ? "han sido registrados" : "ha sido registrado"}. Estoy recalculando los ratios con el nuevo dato.`,
        ts,
        typed: true,
      }]);

      // Anomalías con los nuevos valores
      const anomalies     = detectAnomalies(kpiGrid);
      const freshAnomalies = anomalies.filter((a) => newManual.some((r) => r.kpi_id === a.kpiId));
      freshAnomalies.forEach((a, i) => {
        maybeEmit([{
          id:    `anomaly-${a.kpiId}-${ts}`,
          kind:  a.severity === "critical" ? "error" : "warning",
          text:  a.message,
          kpiId: a.kpiId,
          ts:    ts + 100 + i * 80,
          typed: i === 0,
        }]);
      });

      // Ratios actualizados
      const ratios = computeRatios(kpiGrid);
      const newRatioIds = ratios
        .filter((r) => newManual.some((m) =>
          ["KPI-056","KPI-053","KPI-026","KPI-035","KPI-003","KPI-047","KPI-100"].includes(m.kpi_id)
        ));
      newRatioIds.slice(0, 2).forEach((r, i) => {
        const signal = r.signal === "good" ? "insight" : r.signal === "warn" ? "warning" : "error";
        maybeEmit([{
          id:    `ratio-update-${r.name}-${ts}`,
          kind:  signal as MsgKind,
          text:  `${r.name} actualizado a ${r.value} — ${r.note}.`,
          ts:    ts + 300 + i * 90,
          typed: false,
        }]);
      });
    }

    prevGridRef.current = kpiGrid;
  }, [kpiGrid, maybeEmit]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [log.length]);

  // Unread badge: count critical messages while panel is closed
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
      prevLogLenRef.current = log.length;
      return;
    }
    const newEntries = log.slice(prevLogLenRef.current);
    const critCount  = newEntries.filter((e) => e.kind === "error" || e.kind === "warning").length;
    if (critCount > 0) setUnreadCount((c) => c + critCount);
    prevLogLenRef.current = log.length;
  }, [log.length, isOpen]);

  const sortedLog = useMemo(() => [...log].sort((a, b) => a.ts - b.ts), [log]);

  // ── Chat interactivo ────────────────────────────────────────────────────────

  async function handleSend() {
    const msg = inputValue.trim();
    if (!msg || isSending) return;
    setInputValue("");
    setIsSending(true);

    const ts        = Date.now();
    const userMsgId = `user-${ts}`;
    const aiMsgId   = `ai-${ts}`;

    // Burbuja del Founder
    setLog((prev) => [
      ...prev,
      { id: userMsgId, kind: "info" as const, text: msg, ts, typed: false, isUser: true },
    ]);
    emitted.current.add(userMsgId);

    // Burbuja de IA vacía — se rellena con tokens del stream
    setLog((prev) => [
      ...prev,
      { id: aiMsgId, kind: "system" as const, text: "", ts: ts + 1, typed: false },
    ]);
    emitted.current.add(aiMsgId);

    try {
      const ctx      = buildFounderContext(kpiGrid, companyName);
      const question = (
        ctx ? `${ctx}\n\nPregunta del Founder: ${msg}` : msg
      ).slice(0, 500);

      const reader  = await apiStream("/api/chat/stream", { question });
      const decoder = new TextDecoder();
      let accumulated = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        for (const line of raw.split("\n")) {
          const trimmed = line.replace(/^data:\s*/, "").trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed) as { token?: string; error?: string };
            if (parsed.token) {
              accumulated += parsed.token;
              setLog((prev) =>
                prev.map((e) => (e.id === aiMsgId ? { ...e, text: accumulated } : e)),
              );
            }
          } catch { /* línea SSE malformada — ignorar */ }
        }
      }

      if (!accumulated) {
        setLog((prev) =>
          prev.map((e) =>
            e.id === aiMsgId
              ? { ...e, text: "No pude obtener respuesta. Intenta de nuevo." }
              : e,
          ),
        );
      }
    } catch {
      setLog((prev) =>
        prev.map((e) =>
          e.id === aiMsgId
            ? { ...e, kind: "error" as const, text: "Error al conectar con Cometa Assistant. Verifica tu conexión e intenta de nuevo." }
            : e,
        ),
      );
    } finally {
      setIsSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">

      {/* ── Chat Panel ── */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            key="chat-panel"
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.95 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col overflow-hidden"
            style={{
              width:           "360px",
              height:          "580px",
              background:      "rgba(2,6,15,0.97)",
              backdropFilter:  "blur(24px)",
              borderRadius:    "18px",
              border:          "1px solid rgba(96,165,250,0.15)",
              boxShadow:       "0 25px 60px rgba(0,0,0,0.75), 0 0 0 1px rgba(96,165,250,0.08)",
            }}
          >
            {/* ── Header ── */}
            <div
              className="flex items-center gap-2.5 px-3.5 py-2.5 shrink-0"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
            >
              <LedIndicator color={ledColor} scanning={phase === "scanning"} />

              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-semibold tracking-tight" style={{ color: "#e2e8f0" }}>
                  Cometa Assistant
                  <span
                    className="ml-2 text-[9px] font-normal px-1.5 py-0.5 rounded"
                    style={{
                      color:      LED_CFG[ledColor].color,
                      background: `${LED_CFG[ledColor].color}18`,
                      border:     `1px solid ${LED_CFG[ledColor].color}30`,
                    }}
                  >
                    {LED_CFG[ledColor].label}
                  </span>
                </p>
                <p className="text-[9px] mt-[2px]" style={{ color: "#475569" }}>
                  {isUploading
                    ? "Auditando documento financiero..."
                    : kpiGrid.length > 0
                      ? `${pct}% completado · ${found.length} de ${kpiGrid.length} indicadores${missingCrit.length > 0 ? ` · ${missingCrit.length} requieren atención` : " · todo en orden"}`
                      : "En espera de tu reporte financiero"}
                </p>
              </div>

              {phase === "scanning" && <ThinkingDots />}

              <button
                onClick={() => setIsOpen(false)}
                className="rounded p-1 ml-1 transition-all hover:opacity-60"
                style={{ color: "rgba(255,255,255,0.25)" }}
              >
                <X size={11} />
              </button>
            </div>

            {/* ── Terminal body ── */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-3 space-y-1.5"
              style={{ scrollbarWidth: "none" }}
            >
              <AnimatePresence initial={false}>
                {sortedLog.map((entry, i) => (
                  <MsgBubble
                    key={entry.id}
                    entry={entry}
                    isLatest={i === sortedLog.length - 1}
                    onAction={(kpiId) => {
                      if (kpiId) {
                        onFocusKpi?.(kpiId);
                        setTimeout(() => {
                          document
                            .querySelector(`[data-kpi-id="${kpiId}"]`)
                            ?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }, 80);
                      } else {
                        setTimeout(() => {
                          document
                            .querySelector("[data-kpi-grid]")
                            ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }, 80);
                      }
                    }}
                  />
                ))}
              </AnimatePresence>

              {phase === "scanning" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 px-3 py-1.5"
                  style={{ fontFamily: "var(--font-mono, monospace)", color: "#60a5fa" }}
                >
                  <span className="text-[10px] opacity-50">&gt; </span>
                  <ThinkingDots />
                </motion.div>
              )}
            </div>

            {/* ── Footer: mini progress ── */}
            {kpiGrid.length > 0 && (
              <div
                className="px-3.5 py-2 shrink-0"
                style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="flex-1 h-[2px] rounded-full overflow-hidden"
                    style={{ background: "rgba(255,255,255,0.05)" }}
                  >
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        background: phase === "complete"
                          ? "#4ade80"
                          : `linear-gradient(90deg,${LED_CFG[ledColor].color}88,${LED_CFG[ledColor].color})`,
                        boxShadow: pct > 40 ? `0 0 4px ${LED_CFG[ledColor].color}55` : "none",
                      }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                  <span
                    className="text-[8px] tabular-nums shrink-0"
                    style={{
                      fontFamily: "var(--font-mono, monospace)",
                      color:      LED_CFG[ledColor].color,
                    }}
                  >
                    {pct}%
                  </span>
                </div>
              </div>
            )}

            {/* ── Input ── */}
            <div
              className="shrink-0 px-3 pb-3 pt-2"
              style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
            >
              <form
                onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
                className="flex items-center gap-2 rounded-xl px-3 py-2"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border:     "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  disabled={isSending}
                  placeholder={isSending ? "Analizando…" : "Pregunta algo sobre tus KPIs…"}
                  className="flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-35"
                  style={{
                    color:      "#e2e8f0",
                    fontFamily: "var(--font-sans, Inter, sans-serif)",
                  }}
                />
                <button
                  type="submit"
                  disabled={!inputValue.trim() || isSending}
                  className="flex shrink-0 items-center justify-center rounded-lg p-1.5 transition-all
                             disabled:opacity-30 hover:enabled:opacity-80 active:enabled:scale-95"
                  style={{
                    background: "rgba(96,165,250,0.15)",
                    color:      "#60a5fa",
                    minWidth:   "28px",
                    minHeight:  "28px",
                  }}
                  aria-label="Enviar"
                >
                  {isSending ? <ThinkingDots /> : <Send size={12} />}
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── FAB Button ── */}
      <button
        onClick={() => {
          setIsOpen((o) => !o);
          setUnreadCount(0);
        }}
        className="relative flex h-14 w-14 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95"
        style={{
          background: "linear-gradient(135deg, #1e3a8a 0%, #4c1d95 100%)",
          boxShadow:  unreadCount > 0
            ? "0 4px 20px rgba(248,113,113,0.4), 0 0 0 2px rgba(248,113,113,0.3)"
            : "0 4px 20px rgba(96,165,250,0.3)",
        }}
        aria-label="Abrir Cometa Assistant"
      >
        <img
          src="/COMETALOGO.png"
          alt="Cometa"
          className="h-7 w-auto object-contain"
          style={{ filter: "brightness(0) invert(1)" }}
        />

        {/* Notification badge */}
        <AnimatePresence>
          {!isOpen && unreadCount > 0 && (
            <motion.span
              key="badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ background: "#ef4444" }}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

    </div>
  );
}
