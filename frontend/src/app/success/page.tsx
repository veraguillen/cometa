"use client";

import { useEffect, useState, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { clearSession } from "@/services/api-client";
import ResetTheme from "@/components/ResetTheme";
import { CheckCircle2, Shield, Copy, Check, LogOut } from "lucide-react";

// ── Confetti particle ────────────────────────────────────────────────────────
const CONFETTI_COLORS = ["#64CAE4", "#00237F", "#FFFFFF", "#A8E6F0", "#34d399"];

interface Particle {
  id:    number;
  x:     number;
  color: string;
  size:  number;
  delay: number;
  duration: number;
  rotate: number;
}

function Confetti() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    const items: Particle[] = Array.from({ length: 55 }, (_, i) => ({
      id:       i,
      x:        Math.random() * 100,
      color:    CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      size:     Math.random() * 6 + 4,
      delay:    Math.random() * 1.2,
      duration: Math.random() * 2 + 2.5,
      rotate:   Math.random() * 720 - 360,
    }));
    setParticles(items);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-50">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          style={{
            position:        "absolute",
            left:            `${p.x}%`,
            top:             "-16px",
            width:           p.size,
            height:          p.size,
            borderRadius:    Math.random() > 0.5 ? "50%" : "2px",
            backgroundColor: p.color,
          }}
          initial={{ y: -20, opacity: 1, rotate: 0 }}
          animate={{
            y:       "110vh",
            opacity: [1, 1, 0],
            rotate:  p.rotate,
          }}
          transition={{
            duration: p.duration,
            delay:    p.delay,
            ease:     "easeIn",
          }}
        />
      ))}
    </div>
  );
}

// ── Giant animated checkmark — hero del éxito ────────────────────────────────
function GiantCheckmark() {
  return (
    <motion.div
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 20, delay: 0.05 }}
      className="relative flex items-center justify-center"
    >
      <svg width="140" height="140" viewBox="0 0 140 140" fill="none" aria-hidden>
        {/* Outer filled circle */}
        <motion.circle
          cx="70" cy="70" r="62"
          stroke="var(--cometa-accent)" strokeWidth="2"
          fill="rgba(100,202,228,0.06)"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.65, delay: 0.1, ease: "easeOut" }}
        />
        {/* Subtle inner glow ring */}
        <motion.circle
          cx="70" cy="70" r="50"
          stroke="var(--cometa-accent)" strokeWidth="1"
          fill="none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.18 }}
          transition={{ duration: 0.4, delay: 0.45 }}
        />
        {/* Checkmark — white for contrast on dark bg */}
        <motion.path
          d="M42 71 L61 90 L98 50"
          stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"
          fill="none"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.55, ease: "easeOut" }}
        />
      </svg>
    </motion.div>
  );
}

// ── Checklist items ──────────────────────────────────────────────────────────
const CHECKLIST_ITEMS = [
  "Documento recibido y autenticado",
  "KPIs extraídos con IA y validados",
  "Datos cifrados en la Bóveda Cometa",
  "Recibo digital generado y enviado",
];

function ChecklistRow({ label, delay }: { label: string; delay: number }) {
  return (
    <motion.div
      className="flex items-center justify-center gap-2.5"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: "easeOut" }}
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 28, delay: delay + 0.04 }}
      >
        <CheckCircle2 size={13} className="shrink-0" style={{ color: "#22c55e" }} />
      </motion.div>
      <span className="text-[12px] font-light tracking-wide" style={{ color: "rgba(255,255,255,0.55)" }}>
        {label}
      </span>
    </motion.div>
  );
}

// ── Vault Seal card ──────────────────────────────────────────────────────────
function VaultSealCard({ seal }: { seal: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(seal).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <motion.div
      className="w-full"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 1.1 }}
    >
      {/* Label */}
      <div className="flex items-center gap-1.5 mb-2 justify-center">
        <Shield size={11} style={{ color: "var(--cometa-accent)" }} />
        <p className="text-[9px] uppercase tracking-[0.22em]"
           style={{ color: "var(--cometa-accent)" }}>
          Hash de Auditoría · SHA-256
        </p>
      </div>

      {/* Hash row */}
      <div
        className="flex items-center gap-2 rounded-2xl px-4 py-3"
        style={{
          background: "rgba(255,255,255,0.04)",
          border:     "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <p className="flex-1 font-mono text-[10px] break-all leading-relaxed text-left"
           style={{ color: "rgba(255,255,255,0.65)" }}>
          {seal}
        </p>
        <button
          onClick={handleCopy}
          className="shrink-0 rounded-lg p-2 transition-all hover:opacity-80"
          style={{
            background: copied ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.06)",
            color: copied ? "#34d399" : "var(--cometa-accent)",
          }}
          title="Copiar hash"
        >
          <AnimatePresence mode="wait">
            {copied
              ? <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }}>
                  <Check size={13} />
                </motion.span>
              : <motion.span key="copy" initial={{ scale: 0 }} animate={{ scale: 1 }}>
                  <Copy size={13} />
                </motion.span>
            }
          </AnimatePresence>
        </button>
      </div>

      <p className="mt-2 text-center text-[10px]" style={{ color: "rgba(255,255,255,0.28)" }}>
        Guárdalo como comprobante de integridad de tu entrega
      </p>
    </motion.div>
  );
}

// ── Inner page (needs useSearchParams, must be inside Suspense) ──────────────
function SuccessContent() {
  const router      = useRouter();
  const params      = useSearchParams();
  const seal        = params.get("seal") ?? "";
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 60);
    return () => clearTimeout(t);
  }, []);

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "var(--cometa-bg)" }}
    >
      <ResetTheme theme="obsidian" />
      {ready && <Confetti />}

      {/* ── Header: logo izquierda · logout derecha ── */}
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex items-center justify-between px-6 h-14 shrink-0 border-b"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <img
          src="/COMETALOGO.png"
          alt="Cometa"
          className="h-6 w-auto object-contain"
          style={{ filter: "brightness(0) invert(1)", opacity: 0.8 }}
        />
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] transition-all hover:opacity-80"
          style={{
            border:  "1px solid rgba(255,255,255,0.14)",
            color:   "rgba(255,255,255,0.6)",
          }}
        >
          <LogOut size={12} className="shrink-0" />
          Cerrar sesión
        </button>
      </motion.header>

      {/* ── Contenido central ── */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <motion.div
          className="flex flex-col items-center gap-8 w-full max-w-xs text-center"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: ready ? 1 : 0, y: ready ? 0 : 24 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Checkmark hero */}
          <GiantCheckmark />

          {/* Heading */}
          <motion.div
            className="flex flex-col items-center gap-3"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.65 }}
          >
            <h1
              className="text-4xl"
              style={{ color: "#ffffff", fontWeight: 200, letterSpacing: "-0.02em" }}
            >
              ¡Carga Exitosa!
            </h1>
            <p
              className="text-[13px] leading-6"
              style={{ color: "rgba(255,255,255,0.42)", fontWeight: 300 }}
            >
              Tus métricas están en la Bóveda Cometa.<br />
              Tu recibo digital fue enviado al correo.
            </p>
          </motion.div>

          {/* Checklist items */}
          <motion.div
            className="w-full flex flex-col gap-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.85 }}
          >
            {CHECKLIST_ITEMS.map((label, i) => (
              <ChecklistRow key={label} label={label} delay={0.9 + i * 0.09} />
            ))}
          </motion.div>

          {/* Vault Seal */}
          {seal && <VaultSealCard seal={seal} />}

          {/* CTA */}
          <motion.button
            onClick={() => router.push("/founder/onboarding")}
            className="w-full rounded-xl px-6 py-3 text-sm tracking-wide transition-opacity hover:opacity-80"
            style={{ background: "var(--cometa-accent)", color: "var(--cometa-accent-fg)", fontWeight: 400 }}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: seal ? 1.5 : 1.3 }}
          >
            Subir otro documento
          </motion.button>
        </motion.div>
      </div>
    </div>
  );
}

// ── Page wrapper — required by Next.js for useSearchParams ──────────────────
export default function SuccessPage() {
  return (
    <Suspense>
      <SuccessContent />
    </Suspense>
  );
}
