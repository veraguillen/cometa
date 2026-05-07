"use client";

/**
 * AITerminal — Collapsible AI chat panel with SSE token streaming.
 *
 * Transport:
 *   - POST /api/chat/stream  → text/event-stream (SSE)
 *   - Tokens arrive as:  data: {"token":"..."}
 *   - Stream end signal:  data: [DONE]
 *   - Error signal:       data: {"error":"..."}
 *   Auth injected by apiStream() — centralised in api-client.ts
 *
 * Invite mode:
 *   - Activated via `inviteMode` prop or by typing `/invite` in the input.
 *   - Guided wizard: email → company → POST /api/admin/invite → auto-close.
 *   - Amber visual accent to distinguish system command mode.
 *
 * UX architecture:
 *   - FAB (Sparkles) is a pure toggle — never morphs to X.
 *   - Close (X) lives in the panel header, top-right.
 *   - Send button inside the input bar, gap-4 from textarea.
 *   - Panel floats with 1rem margins — never touches viewport edges.
 *   - Enter sends, Shift+Enter inserts newline.
 *   - Spring physics for slide-up momentum.
 */

import { useState, useRef, useEffect, useCallback } from "react";

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
import { motion, AnimatePresence } from "framer-motion";
import { X, Send, Sparkles, Bot, User, Building2, UserPlus, Copy, Check, ExternalLink } from "lucide-react";
import { apiPost, apiStream } from "@/services/api-client";
import { z } from "zod";
import axios from "axios";
import { adminInviteResponseSchema, chatResponseSchema, type UiAction } from "@/lib/schemas";

// Local SSE-only schemas (not needed in schemas.ts)

// SSE payload shapes
const sseTokenSchema = z.object({ token: z.string() });
const sseErrorSchema = z.object({ error: z.string() });

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id:          string;
  role:        "user" | "assistant";
  content:     string;
  streaming?:  boolean;  // true while SSE stream is still open for this message
  isInvite?:   boolean;  // amber styling for invite-mode messages
  setupUrl?:   string;   // sandbox fallback: setup link to copy manually
}

// Invite wizard steps
type InviteStep = null | "email" | "company" | "sending" | "done";

// Regex to extract <!--ACTION:{...}--> from the assembled SSE stream
const ACTION_MARKER_RE = /<!--ACTION:(.*?)-->/s;

interface AITerminalProps {
  companyId?:        string | null;
  executiveSummary?: string | null;
  inviteMode?:       boolean;
  onInviteDone?:     () => void;
  /** Called when Gemini emits a SET_FILTER or other ui_action in its answer. */
  onUiAction?:       (action: UiAction) => void;
  /** Renders as a fixed-height inline panel (no FAB, no floating). */
  inline?:           boolean;
}

// ── Spring transition — momentum slide-up ────────────────────────────────────

const SPRING = {
  type:      "spring",
  stiffness: 300,
  damping:   28,
  mass:      0.85,
} as const;

// ── SSE line parser ───────────────────────────────────────────────────────────

function parseSseLine(line: string): { token?: string; error?: string; done?: true } | null {
  if (!line.startsWith("data: ")) return null;
  const raw = line.slice(6).trim();
  if (raw === "[DONE]") return { done: true };
  try {
    const json = JSON.parse(raw) as unknown;
    const token = sseTokenSchema.safeParse(json);
    if (token.success) return { token: token.data.token };
    const err = sseErrorSchema.safeParse(json);
    if (err.success)   return { error: err.data.error };
  } catch {
    // malformed line — ignore
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Inline copy box for sandbox setup links ───────────────────────────────────

function CopyBox({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — show the URL for manual copy
    }
  }

  return (
    <div
      className="mt-3 rounded-lg overflow-hidden"
      style={{
        border:     "1px solid color-mix(in srgb, var(--cometa-accent) 30%, transparent)",
        background: "color-mix(in srgb, #0A0A0A 90%, transparent)",
      }}
    >
      {/* URL display */}
      <div
        className="px-3 py-2 text-[11px] break-all font-mono leading-snug"
        style={{ color: "var(--cometa-accent)", opacity: 0.9 }}
      >
        {url}
      </div>
      {/* Action row */}
      <div
        className="flex items-center gap-2 border-t px-3 py-2"
        style={{ borderColor: "color-mix(in srgb, var(--cometa-accent) 20%, transparent)" }}
      >
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-opacity hover:opacity-80"
          style={{
            background: copied
              ? "color-mix(in srgb, #34d399 15%, transparent)"
              : "color-mix(in srgb, var(--cometa-accent) 12%, transparent)",
            border: copied
              ? "1px solid color-mix(in srgb, #34d399 30%, transparent)"
              : "1px solid color-mix(in srgb, var(--cometa-accent) 25%, transparent)",
            color: copied ? "#34d399" : "var(--cometa-accent)",
          }}
        >
          {copied
            ? <><Check size={10} /> Copiado</>
            : <><Copy size={10} /> Copiar al portapapeles</>}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] transition-opacity hover:opacity-70"
          style={{ color: "var(--cometa-fg-muted)" }}
        >
          <ExternalLink size={9} />
          Abrir
        </a>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AITerminal({
  companyId,
  executiveSummary,
  inviteMode = false,
  onInviteDone,
  onUiAction,
  inline = false,
}: AITerminalProps) {
  const [open,          setOpen]          = useState(false);
  const [messages,      setMessages]      = useState<ChatMessage[]>([]);
  const [input,         setInput]         = useState("");
  const [isLoading,     setIsLoading]     = useState(false);

  // Invite wizard state
  const [inviteStep,    setInviteStep]    = useState<InviteStep>(null);
  const [inviteEmail,   setInviteEmail]   = useState("");

  const scrollRef        = useRef<HTMLDivElement>(null);
  const textareaRef      = useRef<HTMLTextAreaElement>(null);
  const abortRef         = useRef<AbortController | null>(null);
  // Stable ref so sendMessage's closure never captures a stale onUiAction
  const onUiActionRef    = useRef(onUiAction);
  useEffect(() => { onUiActionRef.current = onUiAction; }, [onUiAction]);
  // Accumulates the extracted action outside of the setMessages updater
  const pendingActionRef = useRef<UiAction | null>(null);

  // ── Scroll to latest message ───────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // ── Focus textarea when panel opens ───────────────────────────────────────
  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 380);
  }, [open]);

  // ── Reset history when company context changes ─────────────────────────────
  useEffect(() => {
    if (inviteStep !== null) return; // don't interrupt active invite flow
    abortRef.current?.abort();
    setMessages([]);
    setIsLoading(false);
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-resize textarea (max ~5 lines) ───────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [input]);

  // ── Enter invite mode from parent prop ────────────────────────────────────
  useEffect(() => {
    if (!inviteMode || inviteStep !== null) return;
    setOpen(true);
    setMessages([{
      id:        uuid(),
      role:      "assistant",
      content:   "Modo Invitación. ¿Cuál es el correo del Founder?",
      isInvite:  true,
    }]);
    setInviteStep("email");
    setInviteEmail("");
  }, [inviteMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-close after successful invite ────────────────────────────────────
  useEffect(() => {
    if (inviteStep !== "done") return;
    const timer = setTimeout(() => {
      setOpen(false);
      setInviteStep(null);
      setInviteEmail("");
      setMessages([]);
      onInviteDone?.();
    }, 2000);
    return () => clearTimeout(timer);
  }, [inviteStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keep panel open when mounted as inline column ─────────────────────────
  useEffect(() => {
    if (inline) setOpen(true);
  }, [inline]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handle close (also exits invite mode) ─────────────────────────────────
  function handleClose() {
    setOpen(false);
    if (inviteStep !== null && inviteStep !== "done") {
      setInviteStep(null);
      setInviteEmail("");
      setMessages([]);
      onInviteDone?.();
    }
  }

  // ── Invite submit — calls backend ──────────────────────────────────────────
  const handleInviteSubmit = useCallback(async (email: string, company: string) => {
    const sendingId = uuid();
    setMessages((m) => [
      ...m,
      {
        id:       sendingId,
        role:     "assistant" as const,
        content:  `Enviando invitación a ${email}…`,
        isInvite: true,
        streaming: true,
      },
    ]);
    setInviteStep("sending");
    setIsLoading(true);

    try {
      const result = await apiPost("/api/admin/invite", { email, company_name: company }, adminInviteResponseSchema);

      if (result.email_sent) {
        // Email delivered — standard success flow
        setMessages((m) =>
          m.map((msg) =>
            msg.id === sendingId
              ? { ...msg, content: `Invitación enviada a ${email}. Cerrando terminal…`, streaming: false }
              : msg
          )
        );
        setInviteStep("done");
      } else {
        // Email failed — surface the exact error from Resend/SMTP
        const rawError = result.email_error || "Error de configuración del transporte de correo.";
        const isDns = /not verified|verify a domain|domain is not verified|recipient not verified|testing emails to your own|dns|spf|dkim/i.test(rawError);
        const displayError = isDns
          ? `Error de Dominio: verifica que los registros DNS en Resend estén activos.\n\nDetalle: ${rawError}`
          : rawError;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === sendingId
              ? {
                  ...msg,
                  content:   `Error al enviar correo a ${email}:\n${displayError}\n\nLink de configuración (comparte manualmente):`,
                  streaming: false,
                  setupUrl:  result.setup_url,
                }
              : msg
          )
        );
        setInviteStep(null);
        onInviteDone?.();
      }
    } catch (err: unknown) {
      let errMsg = "Error al enviar la invitación.";
      if (axios.isAxiosError(err)) {
        const d = err.response?.data?.detail;
        errMsg = typeof d === "string" ? d : errMsg;
      }
      setMessages((m) =>
        m.map((msg) =>
          msg.id === sendingId
            ? { ...msg, content: `Error: ${errMsg}`, streaming: false }
            : msg
        )
      );
      setInviteStep(null);
      onInviteDone?.();
    } finally {
      setIsLoading(false);
    }
  }, [onInviteDone]);

  // ── Streaming send (chat) + invite step router ─────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // ── /invite shortcut in normal mode ───────────────────────────────────
    if (inviteStep === null && text.startsWith("/invite")) {
      const rest  = text.slice(7).trim();
      const parts = rest.split(/\s+/);
      const email = parts[0] ?? "";
      const company = parts.slice(1).join(" ");

      setMessages((m) => [
        ...m,
        { id: uuid(), role: "user" as const, content: text },
      ]);
      setInput("");

      if (email && company) {
        // Full shortcut — go straight to sending
        setInviteEmail(email);
        await handleInviteSubmit(email, company);
      } else if (email && EMAIL_RE.test(email)) {
        // Email only — ask for company
        setInviteEmail(email);
        setInviteStep("company");
        setMessages((m) => [
          ...m,
          { id: uuid(), role: "assistant" as const, content: "¿Cuál es el nombre de la empresa?", isInvite: true },
        ]);
      } else {
        // No args — start wizard
        setInviteStep("email");
        setMessages((m) => [
          ...m,
          { id: uuid(), role: "assistant" as const, content: "Modo Invitación. ¿Cuál es el correo del Founder?", isInvite: true },
        ]);
      }
      return;
    }

    // ── Invite wizard steps ────────────────────────────────────────────────
    if (inviteStep === "email") {
      const emailVal = text.toLowerCase();
      setMessages((m) => [
        ...m,
        { id: uuid(), role: "user" as const, content: text },
      ]);
      setInput("");
      if (!EMAIL_RE.test(emailVal)) {
        setMessages((m) => [
          ...m,
          { id: uuid(), role: "assistant" as const, content: "Email inválido. Por favor ingresa un correo válido.", isInvite: true },
        ]);
        return;
      }
      setInviteEmail(emailVal);
      setInviteStep("company");
      setMessages((m) => [
        ...m,
        { id: uuid(), role: "assistant" as const, content: "¿Cuál es el nombre de la empresa?", isInvite: true },
      ]);
      return;
    }

    if (inviteStep === "company") {
      const company = text.trim();
      setMessages((m) => [
        ...m,
        { id: uuid(), role: "user" as const, content: company },
      ]);
      setInput("");
      await handleInviteSubmit(inviteEmail, company);
      return;
    }

    // ── Normal SSE chat ────────────────────────────────────────────────────
    const userMsg: ChatMessage = {
      id:      uuid(),
      role:    "user",
      content: text,
    };
    const assistantId = uuid();
    const assistantMsg: ChatMessage = {
      id:        assistantId,
      role:      "assistant",
      content:   "",
      streaming: true,
    };

    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
    setIsLoading(true);

    const body: Record<string, unknown> = { question: text };
    if (companyId)        body.company_id        = companyId;
    if (executiveSummary) body.executive_summary = executiveSummary;

    // Abort controller so switching company mid-stream cancels the fetch
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Flag: true when we already cleaned up (prevents double finally execution)
    let streamCompleted = false;

    try {
      const reader  = await apiStream("/api/chat/stream", body);
      const decoder = new TextDecoder();
      let   buffer  = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const parsed = parseSseLine(line);
          if (!parsed) continue;

          if (parsed.done) {
            // Extract action marker OUTSIDE the state updater to avoid
            // side effects in functional updates (React StrictMode calls them twice).
            pendingActionRef.current = null;
            setMessages((m) =>
              m.map((msg) => {
                if (msg.id !== assistantId) return msg;
                const match = ACTION_MARKER_RE.exec(msg.content);
                if (!match) return { ...msg, streaming: false };
                const clean = msg.content.replace(ACTION_MARKER_RE, "").trim();
                try {
                  pendingActionRef.current = JSON.parse(match[1]) as UiAction;
                } catch { /* malformed marker — ignore */ }
                return { ...msg, content: clean, streaming: false };
              })
            );
            // Dispatch after the state update batch — safe to call callback here
            if (pendingActionRef.current) {
              onUiActionRef.current?.(pendingActionRef.current);
              pendingActionRef.current = null;
            }
            setIsLoading(false);
            streamCompleted = true;
            return;
          }

          if (parsed.token) {
            const tok = parsed.token;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, content: msg.content + tok }
                  : msg
              )
            );
          }

          if (parsed.error) {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, content: `Error: ${parsed.error}`, streaming: false }
                  : msg
              )
            );
            setIsLoading(false);
            streamCompleted = true;
            return;
          }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") {
        streamCompleted = true;
        return;
      }

      // SSE failed — fall back to the blocking /api/chat endpoint
      let errorText = "Error de conexión con el servidor de IA.";
      try {
        const data = await apiPost("/api/chat", body, chatResponseSchema);
        errorText = data.answer;
        if (data.ui_action) onUiActionRef.current?.(data.ui_action);
      } catch (fallbackErr: unknown) {
        if (fallbackErr instanceof Error) errorText = fallbackErr.message;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { id: assistantId, role: "assistant" as const, content: errorText, streaming: false }
            : m
        )
      );
    } finally {
      // Only clean up if not already done by a successful [DONE] or error branch
      if (!streamCompleted) {
        setIsLoading(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m
          )
        );
      }
    }
  }, [input, isLoading, companyId, executiveSummary, inviteStep, inviteEmail, handleInviteSubmit]);

  // ── Input placeholder based on invite step ─────────────────────────────────
  const placeholder =
    inviteStep === "email"   ? "correo@empresa.com" :
    inviteStep === "company" ? "Nombre de la empresa" :
    "Pregúntale a Cometa…";

  return (
    <>
      {/* ── FAB — hidden in inline mode ── */}
      {!inline && <motion.button
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full"
        style={{
          background:     "var(--cometa-accent)",
          border:         "1px solid var(--cometa-accent)",
          color:          "var(--cometa-accent-fg)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          boxShadow:
            "0 4px 24px color-mix(in srgb, var(--cometa-accent) 30%, transparent)",
          transition: "background 500ms ease, border-color 500ms ease, color 500ms ease",
        }}
      >
        <Sparkles size={15} />
        <span
          className="hidden sm:inline text-[13px] font-light tracking-wide"
          style={{ fontWeight: 300 }}
        >
          Cometa AI
        </span>
        <span
          className="hidden sm:block h-3.5 w-px mx-0.5"
          style={{ background: "rgba(255,255,255,0.22)" }}
        />
        <span
          className="hidden sm:inline text-[9px] uppercase tracking-widest"
          style={{ fontWeight: 400, color: "rgba(255,255,255,0.55)" }}
        >
          Gemini
        </span>
      </motion.button>}

      {/* ── Panel — slide-up float OR inline column ── */}
      <AnimatePresence>
        {(inline || open) && (
          <motion.div
            initial={{ y: inline ? 0 : 32, opacity: 0, scale: inline ? 1 : 0.97 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{    y: inline ? 0 : 20, opacity: 0, scale: inline ? 1 : 0.97 }}
            transition={SPRING}
            className={inline
              ? "flex flex-col h-full overflow-hidden"
              : "fixed z-40 flex flex-col rounded-2xl overflow-hidden"}
            style={inline ? {
              border:     "1px solid var(--cometa-card-border)",
              background: "color-mix(in srgb, var(--cometa-bg) 90%, transparent)",
              transition: "background 500ms ease, border-color 300ms ease",
            } : {
              bottom:         "5.5rem",
              right:          "1.5rem",
              width:          "min(420px, calc(100vw - 3rem))",
              maxHeight:      "min(22rem, 55vh)",
              border:         inviteStep !== null
                ? "1px solid color-mix(in srgb, var(--cometa-accent) 30%, transparent)"
                : "1px solid var(--cometa-card-border)",
              background:     "color-mix(in srgb, var(--cometa-bg) 90%, transparent)",
              backdropFilter: "blur(28px)",
              WebkitBackdropFilter: "blur(28px)",
              boxShadow:
                inviteStep !== null
                  ? "0 -2px 40px rgba(251,191,36,0.10), inset 0 1px 0 rgba(255,255,255,0.04)"
                  : "0 -2px 40px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.04)",
              transition:
                "background 500ms ease, border-color 300ms ease",
            }}
          >
            {/* ── Header ── */}
            <div
              className="flex items-center gap-2.5 px-5 py-3 border-b shrink-0"
              style={{
                borderColor: inviteStep !== null
                  ? "color-mix(in srgb, var(--cometa-accent) 20%, transparent)"
                  : "var(--cometa-card-border)",
                transition:  "border-color 300ms ease",
              }}
            >
              <Sparkles size={13} style={{ color: "var(--cometa-accent)" }} />
              <span
                className="text-[13px] font-light tracking-wide"
                style={{ color: "var(--cometa-fg)", transition: "color 500ms ease" }}
              >
                Cometa AI
              </span>

              {/* Invite mode badge */}
              {inviteStep !== null ? (
                <span
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] uppercase tracking-widest"
                  style={{
                    background: "color-mix(in srgb, var(--cometa-accent) 12%, transparent)",
                    color:      "var(--cometa-accent)",
                    border:     "1px solid color-mix(in srgb, var(--cometa-accent) 25%, transparent)",
                  }}
                >
                  <UserPlus size={9} />
                  Invitar Founder
                </span>
              ) : (
                <>
                  <span
                    className="flex items-center rounded px-2 py-0.5 text-[9px] uppercase tracking-widest"
                    style={{
                      background: "rgba(96,165,250,0.08)",
                      color:      "#60a5fa",
                      border:     "1px solid rgba(96,165,250,0.18)",
                      transition: "background 300ms ease",
                    }}
                  >
                    Gemini
                  </span>
                  {companyId && (
                    <span
                      className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] uppercase tracking-widest"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        color:      "var(--cometa-fg-muted)",
                        border:     "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <Building2 size={9} />
                      {companyId}
                    </span>
                  )}
                </>
              )}

              {messages.length > 0 && inviteStep === null && (
                <span
                  className="rounded-full px-2 py-0.5 text-[9px]"
                  style={{
                    background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)",
                    color:      "var(--cometa-fg-muted)",
                  }}
                >
                  {messages.filter((m) => !m.streaming || m.content).length}
                </span>
              )}

              {/* Close button — hidden in inline mode */}
              {!inline && (
              <button
                onClick={handleClose}
                className="ml-auto flex items-center justify-center rounded-lg p-1.5 transition-opacity hover:opacity-60"
                style={{
                  color:  "var(--cometa-fg-muted)",
                  border: "1px solid var(--cometa-card-border)",
                }}
                title="Cerrar terminal"
              >
                <X size={13} />
              </button>
              )}
            </div>

            {/* ── Messages ── */}
            <div
              ref={scrollRef}
              className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4 space-y-3"
            >
              {messages.length === 0 ? (
                <p
                  className="pt-4 text-center text-[12px]"
                  style={{ color: "var(--cometa-fg-muted)", opacity: 0.55 }}
                >
                  {companyId
                    ? `Pregunta sobre ${companyId}, sus KPIs o métricas financieras.`
                    : "Selecciona una empresa en el sidebar y pregunta sobre sus métricas."}
                </p>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex gap-2.5 ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    {msg.role === "assistant" && (
                      msg.isInvite ? (
                        <UserPlus
                          size={13}
                          className="mt-0.5 shrink-0"
                          style={{ color: "var(--cometa-accent)" }}
                        />
                      ) : (
                        <Bot
                          size={13}
                          className="mt-0.5 shrink-0"
                          style={{ color: "var(--cometa-accent)" }}
                        />
                      )
                    )}
                    <div
                      className="max-w-[82%] rounded-xl px-3.5 py-2 text-[13px] leading-relaxed"
                      style={{
                        background:
                          msg.isInvite && msg.role === "assistant"
                            ? "color-mix(in srgb, var(--cometa-accent) 8%, transparent)"
                            : msg.role === "user"
                              ? "color-mix(in srgb, var(--cometa-accent) 10%, transparent)"
                              : "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
                        border: msg.isInvite && msg.role === "assistant"
                          ? "1px solid color-mix(in srgb, var(--cometa-accent) 18%, transparent)"
                          : `1px solid ${
                              msg.role === "user"
                                ? "color-mix(in srgb, var(--cometa-accent) 20%, transparent)"
                                : "var(--cometa-card-border)"
                            }`,
                        color:      msg.isInvite && msg.role === "assistant" ? "var(--cometa-accent)" : "var(--cometa-fg)",
                        fontWeight: msg.role === "assistant" ? 300 : 400,
                        fontFamily: "var(--font-sans)",
                        whiteSpace: "pre-wrap",
                        wordBreak:  "break-word",
                        transition: "color 500ms ease, background 500ms ease, border-color 500ms ease",
                      }}
                    >
                      {msg.content}
                      {/* Sandbox setup link — copy box */}
                      {msg.setupUrl && !msg.streaming && (
                        <CopyBox url={msg.setupUrl} />
                      )}
                      {/* Streaming cursor */}
                      {msg.streaming && msg.role === "assistant" && (
                        <motion.span
                          className="inline-block ml-0.5 align-middle"
                          style={{
                            width:        "1.5px",
                            height:       "0.9em",
                            background:   "var(--cometa-accent)",
                            borderRadius: "1px",
                            display:      "inline-block",
                          }}
                          animate={{ opacity: [1, 0, 1] }}
                          transition={{ duration: 0.9, repeat: Infinity }}
                        />
                      )}
                    </div>
                    {msg.role === "user" && (
                      <User
                        size={13}
                        className="mt-0.5 shrink-0"
                        style={{ color: "var(--cometa-fg-muted)" }}
                      />
                    )}
                  </div>
                ))
              )}

              {/* Loading indicator when stream hasn't started yet */}
              {isLoading && messages.at(-1)?.content === "" && (
                <div className="flex gap-2.5">
                  <Bot
                    size={13}
                    className="mt-0.5 shrink-0"
                    style={{ color: "var(--cometa-accent)" }}
                  />
                  <div
                    className="flex items-center gap-1.5 rounded-xl px-3.5 py-2.5"
                    style={{
                      background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
                      border:     "1px solid var(--cometa-card-border)",
                    }}
                  >
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="block h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--cometa-fg-muted)" }}
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── Input area — floating card ── */}
            <div className="shrink-0 px-4 pb-4 pt-2">
              <div
                className="flex items-end gap-4 rounded-xl px-5 py-3.5"
                style={{
                  background:
                    "color-mix(in srgb, var(--cometa-card-bg) 85%, transparent)",
                  border:         inviteStep !== null
                    ? "1px solid color-mix(in srgb, var(--cometa-accent) 20%, transparent)"
                    : "1px solid rgba(255, 255, 255, 0.10)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  transition: "background 500ms ease, border-color 300ms ease",
                }}
              >
                {/* Textarea — Enter sends, Shift+Enter newline */}
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                    // Shift+Enter: default textarea behaviour inserts \n
                  }}
                  placeholder={placeholder}
                  disabled={isLoading || inviteStep === "sending" || inviteStep === "done"}
                  className="flex-1 resize-none bg-transparent outline-none scrollbar-thin
                             placeholder:opacity-40"
                  style={{
                    color:      "var(--cometa-fg)",
                    fontFamily: "var(--font-sans)",
                    fontSize:   "13px",
                    fontWeight: 400,
                    lineHeight: "1.55",
                    maxHeight:  "7rem",
                    overflowY:  "auto",
                    transition: "color 500ms ease",
                  }}
                />

                {/* Send button */}
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={() => void sendMessage()}
                  disabled={!input.trim() || isLoading || inviteStep === "sending" || inviteStep === "done"}
                  className="shrink-0 flex items-center justify-center rounded-lg p-2
                             transition-opacity disabled:opacity-25 hover:opacity-80"
                  style={{
                    background: "var(--cometa-accent)",
                    color:      "var(--cometa-accent-fg)",
                    transition: "background 300ms ease",
                  }}
                  title="Enviar (Enter)"
                >
                  <Send size={14} />
                </motion.button>
              </div>

              {/* Keyboard hint */}
              <p
                className="mt-1.5 px-1 text-[10px] select-none"
                style={{ color: "var(--cometa-fg-muted)", opacity: 0.38 }}
              >
                {inviteStep !== null
                  ? "Escribe /invite correo@empresa.com Nombre para invitar directamente"
                  : "Enter para enviar\u00a0·\u00a0Shift+Enter para nueva línea"}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
