import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Converts a vault period ID or ISO date string into a human-readable label.
 *
 * - "P2024Q4"        → "Q4 2024"
 * - "P2023Q1M03"     → "Q1 2023"
 * - ISO / timestamp  → "15 de marzo de 2024"  (es-ES locale)
 * - anything else    → "período desconocido"
 */
export function formatVaultDate(raw: string | null | undefined): string {
  if (!raw) return "período desconocido";

  // BigQuery period IDs: P2024Q4 or P2023Q1M03
  const bq = raw.match(/P(20\d{2})Q([1-4])/);
  if (bq) return `Q${bq[2]} ${bq[1]}`;

  // ISO date or timestamp
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d.toLocaleDateString("es-ES", {
      day:   "numeric",
      month: "long",
      year:  "numeric",
    });
  }

  return "período desconocido";
}
