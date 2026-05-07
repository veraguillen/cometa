import { ThemeProvider } from "@/contexts/ThemeContext";

/**
 * Analyst layout — wraps all /analyst/* routes with ThemeProvider.
 * Theme changes are scoped exclusively to the analyst view.
 * Founder and other routes use the default obsidian vars from globals.css.
 */
export default function AnalystLayout({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
