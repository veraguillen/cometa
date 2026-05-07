import { useState, useEffect } from "react";
import { apiGet } from "@/services/api-client";
import { portfolioMetadataSchema, type PortfolioMetadata } from "@/lib/schemas";

const EMPTY: PortfolioMetadata = {
  vertical_map:   {},
  coverage_map:   {},
  last_month_map: {},
};

interface UsePortfolioMetadataResult {
  metadata:    PortfolioMetadata;
  metaLoading: boolean;
  metaError:   string | null;
}

/**
 * Obtiene los metadatos del portfolio desde GET /api/metadata.
 *
 * Mientras carga devuelve mapas vacíos ({}) para que los componentes
 * puedan renderizar con valores por defecto sin crashear.
 *
 * En caso de error (red, servidor caído, schema inesperado) mantiene
 * los mapas vacíos y expone el mensaje en `metaError`.
 */
export function usePortfolioMetadata(): UsePortfolioMetadataResult {
  const [metadata,    setMetadata]    = useState<PortfolioMetadata>(EMPTY);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError,   setMetaError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiGet("/api/metadata", portfolioMetadataSchema)
      .then((data) => {
        if (!cancelled) setMetadata(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Error cargando metadatos";
          console.warn("[usePortfolioMetadata]", msg);
          setMetaError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setMetaLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  return { metadata, metaLoading, metaError };
}
