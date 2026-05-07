"use client";

/**
 * ThemeContext — Cometa Pipeline brand-compliant theme switcher.
 *
 * Four themes:
 *   pearl    (default) — Pearl & Emerald:     bg #FFFFFF,  cards #F8F9FA,  accent #00A86B — Claridad Institucional
 *   obsidian           — Obsidiana & Steel:   bg #000000,  gradient navy,  accent #64CAE4 — Alto Rendimiento
 *   slate              — Ivory & Slate:       bg #F4F1EB,  panels #FFFFFF,  accent #ECE5BC — Banca Privada
 *   umber              — Deep Umber & Gold:   bg #1A0F07,  panels transl.,  accent #ECE5BC — Riqueza Estructurada
 *
 * Applies by:
 *   1. Setting data-theme on <html>
 *   2. Writing CSS overrides into a <style id="cometa-theme-vars"> tag
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";

export type ThemeName = "pearl" | "obsidian" | "slate" | "umber";

export const themeLabels: Record<ThemeName, string> = {
  pearl:    "Pearl & Emerald",
  obsidian: "Obsidiana & Steel",
  slate:    "Ivory & Slate",
  umber:    "Deep Umber & Gold",
};

export const themeVibes: Record<ThemeName, string> = {
  pearl:    "Claridad Institucional",
  obsidian: "Alto Rendimiento",
  slate:    "Banca Privada",
  umber:    "Riqueza Estructurada",
};

export const themeSwatches: Record<ThemeName, { a: string; b: string }> = {
  pearl:    { a: "#FFFFFF",  b: "#00A86B" },
  obsidian: { a: "#000000",  b: "#64CAE4" },
  slate:    { a: "#F4F1EB",  b: "#ECE5BC" },
  umber:    { a: "#1A0F07",  b: "#ECE5BC" },
};

export interface ThemeTokens {
  bg:         string;
  bgGradient: string;
  fg:         string;        // primary text
  fgMuted:    string;        // secondary text
  cardBg:     string;
  cardBorder: string;
  accent:     string;        // primary accent
  accentFg:   string;        // text on accent bg
}

export const THEMES: Record<ThemeName, ThemeTokens> = {
  // Pearl & Emerald — Fondo #FFFFFF · Acento #00A86B · Texto #212529
  pearl: {
    bg:         "#FFFFFF",
    bgGradient: "linear-gradient(160deg, #F8F9FA 0%, #FFFFFF 55%, #F0F4F2 100%)",
    fg:         "#212529",
    fgMuted:    "#6C757D",
    cardBg:     "#F8F9FA",
    cardBorder: "rgba(0,0,0,0.07)",
    accent:     "#00A86B",
    accentFg:   "#FFFFFF",
  },
  // Obsidian & Steel — Fondo #000000 · Acento #64CAE4 · Texto #FFFFFF
  obsidian: {
    bg:         "#000000",
    bgGradient: "linear-gradient(160deg, #00237F 0%, #000814 55%, #000000 100%)",
    fg:         "#FFFFFF",
    fgMuted:    "rgba(255,255,255,0.42)",
    cardBg:     "rgba(255,255,255,0.04)",
    cardBorder: "rgba(255,255,255,0.08)",
    accent:     "#64CAE4",
    accentFg:   "#000000",
  },
  // Ivory & Slate — Claridad de banca privada moderna
  slate: {
    bg:         "#F4F1EB",
    bgGradient: "linear-gradient(160deg, #FAFAF8 0%, #F4F1EB 55%, #EDE8DF 100%)",
    fg:         "#000000",
    fgMuted:    "rgba(0,0,0,0.52)",
    cardBg:     "rgba(255,255,255,0.88)",
    cardBorder: "rgba(100,116,139,0.18)",
    accent:     "#ECE5BC",
    accentFg:   "#000000",
  },
  // Deep Umber & Gold — Riqueza estructurada y madurez
  umber: {
    bg:         "#1A0F07",
    bgGradient: "linear-gradient(160deg, #3D2010 0%, #1A0F07 55%, #0D0500 100%)",
    fg:         "#F0EDE6",
    fgMuted:    "rgba(240,237,230,0.45)",
    cardBg:     "rgba(0,0,0,0.42)",
    cardBorder: "rgba(236,229,188,0.12)",
    accent:     "#ECE5BC",
    accentFg:   "#1A0F07",
  },
};

interface ThemeContextValue {
  theme:    ThemeName;
  setTheme: (t: ThemeName) => void;
  tokens:   ThemeTokens;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme:    "pearl",
  setTheme: () => {},
  tokens:   THEMES.pearl,
});

const STORAGE_KEY = "cometa_theme";

function injectVars(t: ThemeName) {
  const tk = THEMES[t];
  const id = "cometa-theme-vars";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = `
    :root {
      --cometa-bg:            ${tk.bg};
      --cometa-bg-gradient:   ${tk.bgGradient};
      --cometa-fg:            ${tk.fg};
      --cometa-fg-muted:      ${tk.fgMuted};
      --cometa-card-bg:       ${tk.cardBg};
      --cometa-card-border:   ${tk.cardBorder};
      --cometa-accent:        ${tk.accent};
      --cometa-accent-fg:     ${tk.accentFg};
      --cometa-dark-blue:     #00237F;
    }
  `;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>("pearl");

  useEffect(() => {
    const saved = (localStorage.getItem(STORAGE_KEY) as ThemeName) ?? "pearl";
    applyTheme(saved in THEMES ? saved : "pearl");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyTheme(t: ThemeName) {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    document.documentElement.setAttribute("data-theme", t);
    injectVars(t);
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme: applyTheme, tokens: THEMES[theme] }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
