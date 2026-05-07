"use client";

/**
 * ResetTheme — enforces a specific theme on any page outside the analyst cockpit.
 *
 * Next.js client-side navigation keeps the same <html> element between routes,
 * so a theme set by the analyst ThemeProvider persists when navigating away.
 * This component sets data-theme on mount and removes the dynamic <style> tag
 * injected by ThemeContext so CSS vars revert to the attribute-selector rules.
 *
 * Usage:
 *   <ResetTheme />              → obsidian (public routes: /login, landing)
 *   <ResetTheme theme="pearl" /> → pearl   (private post-login: /founder, /success)
 */

import { useEffect } from "react";
import type { ThemeName } from "@/contexts/ThemeContext";

interface ResetThemeProps {
  theme?: ThemeName;
}

export default function ResetTheme({ theme = "obsidian" }: ResetThemeProps) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // Remove any style tag injected by ThemeContext so CSS vars revert to
    // the [data-theme="..."] attribute-selector rules in globals.css.
    document.getElementById("cometa-theme-vars")?.remove();
  }, [theme]);

  return null;
}
