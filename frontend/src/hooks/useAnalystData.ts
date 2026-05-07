"use client";

/**
 * useAnalystData — fetches KPI data whenever selectedCompanyId changes.
 *
 * Also maintains a deduplicated list of `recentCompanies` — companies that
 * have been successfully fetched — so the sidebar can show quick-access links.
 */

import { useState, useEffect, useCallback } from "react";
import { getAnalysisResults, extractKPIs } from "@/services/analyst";
import type { AnalysisResult } from "@/lib/schemas";

interface AnalystData {
  results:          AnalysisResult[];
  kpis:             Record<string, string>;
  recentCompanies:  string[];
  loading:          boolean;
  error:            string | null;
  refresh:          () => void;
}

export function useAnalystData(companyId: string | null): AnalystData {
  const [results,         setResults]         = useState<AnalysisResult[]>([]);
  const [kpis,            setKpis]            = useState<Record<string, string>>({});
  const [recentCompanies, setRecentCompanies] = useState<string[]>([]);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  const fetchResults = useCallback(async () => {
    if (!companyId) {
      setResults([]);
      setKpis({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getAnalysisResults(companyId);
      setResults(data);
      setKpis(extractKPIs(data));
      // Add to recents on success (deduplicated, most-recent first)
      if (data.length > 0) {
        setRecentCompanies((prev) =>
          [companyId, ...prev.filter((c) => c !== companyId)].slice(0, 8)
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando datos");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  return { results, kpis, recentCompanies, loading, error, refresh: fetchResults };
}
