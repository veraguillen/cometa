/**
 * company-resolver.ts
 * ───────────────────
 * Resolución client-side de nombre de empresa a partir del email del Founder.
 * Se ejecuta de forma síncrona para que la UI nunca espere al backend.
 * El backend (/api/founder/config) provee company_display_name como fuente
 * autoritativa; este módulo actúa como fallback inmediato.
 */

export interface CompanyInfo {
  /** Slug lowercase para rutas GCS, ej. "kueski", "startup-demo" */
  slug: string;
  /** Nombre legible para UI, ej. "Kueski", "Startup Demo" */
  displayName: string;
  /** True si el email corresponde a una cuenta de prueba */
  isTest: boolean;
}

// ── Patrones de cuentas de prueba / demo ──────────────────────────────────────
// local-part: founder_test@, test@, demo@, prueba@, sandbox@
const TEST_LOCAL_RE = /^(founder_test|test|demo|prueba|sandbox)\b/i;
// dominio: test.com, demo.io, sandbox.co, example.com, localhost
const TEST_DOMAIN_RE = /^(test|demo|sandbox|example|localhost)\b/i;

// ── Empresas conocidas con nombre de display explícito ─────────────────────────
// Sólo los nombres que no se humanizan bien con simple capitalize.
const KNOWN_DISPLAY: Record<string, string> = {
  "demo-startup": "Startup Demo",
  demostartup:    "Startup Demo",
  kueski:         "Kueski",
  conekta:      "Conekta",
  simetrik:     "Simetrik",
  yotepresto:   "Yo Te Presto",
  skydropx:     "Skydropx",
  m1:           "M1 Insurtech",
  bnext:        "Bnext",
  clip:         "Clip",
  mienvio:      "Mienvío",
  bindcard:     "Bind Card",
  stori:        "Stori",
  treinta:      "Treinta",
  kushki:       "Kushki",
  pomelo:       "Pomelo",
  mentis:       "Mentis",
  cometa:       "Cometa",
};

/**
 * Convierte un domain-base o slug a nombre de display.
 * "mi-empresa" → "Mi Empresa", "simetrik" → "Simetrik"
 */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Resuelve nombre de empresa a partir del email del Founder.
 * Retorno inmediato, sin llamadas async.
 */
export function resolveCompanyFromEmail(email: string): CompanyInfo {
  if (!email || !email.includes("@")) {
    return { slug: "unknown", displayName: "tu empresa", isTest: false };
  }

  const [localPart, domain] = email.toLowerCase().split("@", 2);
  const domainBase = domain.split(".")[0];

  // ── Detección de cuenta de prueba ─────────────────────────────────────────
  const isTest = TEST_LOCAL_RE.test(localPart) || TEST_DOMAIN_RE.test(domainBase);
  if (isTest) {
    return { slug: "demo-startup", displayName: "Startup Demo", isTest: true };
  }

  // ── Lookup en mapa de nombres conocidos ───────────────────────────────────
  const normalizedSlug = domainBase.replace(/[-_]/g, "");
  const knownKey = Object.keys(KNOWN_DISPLAY).find(
    (k) => k.replace(/[-_]/g, "") === normalizedSlug,
  );
  if (knownKey) {
    return { slug: domainBase, displayName: KNOWN_DISPLAY[knownKey], isTest: false };
  }

  // ── Humanizar dominio para empresas no mapeadas ───────────────────────────
  const displayName = humanizeSlug(domainBase) || "tu empresa";
  return { slug: domainBase, displayName, isTest: false };
}

/**
 * Combina el resultado client-side con el company_display_name del backend.
 * El backend siempre gana cuando tiene un valor explícito.
 */
export function mergeWithBackendConfig(
  local: CompanyInfo,
  backendDisplayName?: string | null,
): CompanyInfo {
  if (backendDisplayName && backendDisplayName.trim()) {
    return { ...local, displayName: backendDisplayName.trim() };
  }
  return local;
}
