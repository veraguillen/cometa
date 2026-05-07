"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Palette } from "lucide-react";
import {
  useTheme,
  themeLabels,
  themeVibes,
  themeSwatches,
  type ThemeName,
} from "@/contexts/ThemeContext";

const THEME_NAMES = Object.keys(themeLabels) as ThemeName[];

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center rounded-lg p-1.5 transition-opacity hover:opacity-70"
        style={{
          background: "var(--cometa-accent)",
          border:     "1px solid var(--cometa-accent)",
          color:      "var(--cometa-accent-fg)",
        }}
        title={themeLabels[theme]}
      >
        <Palette size={14} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Click-outside overlay */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0,  scale: 1 }}
              exit={{    opacity: 0, y: -4, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full mt-2 min-w-[210px] rounded-xl p-1.5 z-50"
              style={{
                background:     "color-mix(in srgb, var(--cometa-bg) 92%, transparent)",
                border:         "1px solid var(--cometa-card-border)",
                backdropFilter: "blur(24px)",
                boxShadow:      "0 8px 32px rgba(0,0,0,0.3)",
              }}
            >
              {THEME_NAMES.map((t) => (
                <button
                  key={t}
                  onClick={() => { setTheme(t); setOpen(false); }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 transition-all text-left"
                  style={{
                    background: theme === t ? "var(--cometa-accent)" : "transparent",
                    color:      theme === t ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
                  }}
                >
                  {/* Dual swatch */}
                  <div className="flex gap-1 shrink-0">
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: themeSwatches[t].a, border: "1px solid rgba(255,255,255,0.15)" }}
                    />
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: themeSwatches[t].b }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: "12px", fontWeight: 400 }}>{themeLabels[t]}</div>
                    <div style={{ fontSize: "10px", opacity: 0.55 }}>{themeVibes[t]}</div>
                  </div>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
