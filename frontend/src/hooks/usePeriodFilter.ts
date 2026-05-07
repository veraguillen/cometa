import { useState, useCallback } from "react";

// ─── Ordinal system ───────────────────────────────────────────────────────────
// Escala unificada: year * 12 + (month - 1)
// Permite comparar quarters y meses individuales en la misma recta numérica.
//   Q1 2025 → ordinals [24300, 24302]  (ene–mar)
//   Q2 2025 → ordinals [24303, 24305]  (abr–jun)
//   Ene 2026 → ordinal  24312
//   Q1 2026 → ordinals [24312, 24314]

/**
 * Convierte cualquier representación de período a un entero ordinal.
 * Compatible con el formato canónico PYYYYQxMyy del backend.
 *
 * Retorna -1 cuando el string no es parseable → nunca se filtra ese registro.
 */
export function parseToOrdinal(raw: string): number {
  if (!raw) return -1;
  const s = raw.trim();

  // Canónico: P2025Q1M03
  const canonical = s.match(/^P(20\d{2})Q[1-4]M(\d{2})$/);
  if (canonical) {
    const year  = parseInt(canonical[1], 10);
    const month = parseInt(canonical[2], 10);
    return year * 12 + (month - 1);
  }

  // ISO parcial: 2025-01
  const iso = s.match(/^(20\d{2})-(\d{2})$/);
  if (iso) {
    const year  = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10);
    return year * 12 + (month - 1);
  }

  // Quarter explícito: "Q1 2025" | "2025 Q1" | "2025-Q1"
  const qMatch = s.match(/Q([1-4])[\s\-\/]*(20\d{2})|(20\d{2})[\s\-\/]*Q([1-4])/i);
  if (qMatch) {
    const q    = parseInt(qMatch[1] ?? qMatch[4], 10);
    const year = parseInt(qMatch[2] ?? qMatch[3], 10);
    return year * 12 + (q - 1) * 3; // inicio del quarter
  }

  // Semestre: "H1 2025" | "2025 H2"
  const hMatch = s.match(/H([12])[\s\-]*(20\d{2})|(20\d{2})[\s\-]*H([12])/i);
  if (hMatch) {
    const h    = parseInt(hMatch[1] ?? hMatch[4], 10);
    const year = parseInt(hMatch[2] ?? hMatch[3], 10);
    return year * 12 + (h === 1 ? 0 : 6); // H1 → ene, H2 → jul
  }

  // Mes textual: "March 2025" | "2025 March" | "Marzo 2025"
  const MONTH_NAMES: Record<string, number> = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12,
    enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12,
    jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
  };
  const lower = s.toLowerCase();
  for (const [name, month] of Object.entries(MONTH_NAMES)) {
    if (lower.includes(name)) {
      const yearMatch = s.match(/(20\d{2})/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1], 10);
        return year * 12 + (month - 1);
      }
    }
  }

  // FY2025 / año solo → mes 12 (cierre fiscal)
  const fyMatch = s.match(/(20\d{2})/);
  if (fyMatch) {
    return parseInt(fyMatch[1], 10) * 12 + 11;
  }

  return -1;
}

// ─── Conversión selección UI → rango ordinal ──────────────────────────────────

function selectionToRange(year: number, period: string | null): [number, number] {
  const base = year * 12;
  if (!period) return [base, base + 11]; // año completo

  if (period.startsWith("Q")) {
    const q     = parseInt(period[1], 10);
    const start = (q - 1) * 3;
    return [base + start, base + start + 2]; // 3 meses del quarter
  }

  // Mes "01"–"12" (formato alternativo)
  const m = parseInt(period, 10) - 1;
  return [base + m, base + m];
}

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface PeriodFilterState {
  selectedYear:   number | null;
  selectedPeriod: string | null; // "Q1"–"Q4" | "01"–"12" | null
}

export interface UsePeriodFilterReturn {
  filter:         PeriodFilterState;
  setYear:        (year: number | null) => void;
  setPeriod:      (period: string | null) => void;
  reset:          () => void;
  isActive:       boolean;
  filterByPeriod: <T>(items: T[], getPeriodStr: (item: T) => string | undefined) => T[];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePeriodFilter(): UsePeriodFilterReturn {
  const [filter, setFilter] = useState<PeriodFilterState>({
    selectedYear:   null,
    selectedPeriod: null,
  });

  const setYear = useCallback((year: number | null) => {
    // Resetear period siempre que cambia el año (las opciones cambian)
    setFilter({ selectedYear: year, selectedPeriod: null });
  }, []);

  const setPeriod = useCallback((period: string | null) => {
    setFilter((prev) => ({ ...prev, selectedPeriod: period }));
  }, []);

  const reset = useCallback(() => {
    setFilter({ selectedYear: null, selectedPeriod: null });
  }, []);

  const isActive = filter.selectedYear !== null;

  const filterByPeriod = useCallback(
    <T>(items: T[], getPeriodStr: (item: T) => string | undefined): T[] => {
      if (!isActive || filter.selectedYear === null) return items;

      const [fromOrd, toOrd] = selectionToRange(filter.selectedYear, filter.selectedPeriod);

      return items.filter((item) => {
        const raw = getPeriodStr(item);
        if (!raw) return true;   // sin período → siempre visible
        const ord = parseToOrdinal(raw);
        if (ord === -1) return true; // no parseable → nunca ocultar
        return ord >= fromOrd && ord <= toOrd;
      });
    },
    [isActive, filter.selectedYear, filter.selectedPeriod],
  );

  return { filter, setYear, setPeriod, reset, isActive, filterByPeriod };
}
