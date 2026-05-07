/**
 * schemas.ts — Zod schemas for Cometa Pipeline API responses.
 *
 * Fuente única de verdad para la forma de los datos en el frontend.
 * Espeja exactamente los modelos Pydantic del backend (src/schemas.py).
 *
 * Reglas:
 *  - Toda entidad recibida del backend se valida con .parse() antes de usarla.
 *  - Los tipos TypeScript se derivan con z.infer<> — nunca declarados a mano.
 *  - Cada nueva entidad de API necesita su schema aquí antes de ser consumida.
 *
 * Mapa de espejo Backend → Frontend:
 *   UserPublic        → userInfoSchema
 *   LoginApiResponse  → loginResponseSchema
 *   MeApiResponse     → meResponseSchema
 *   LoginRequest      → loginRequestSchema   (validación del formulario)
 */

import { z } from "zod";

// ── Primitivos reutilizables ──────────────────────────────────────────────────

/**
 * ID Híbrido: ANA-XXXXXX (analista @cometa.*) o FND-XXXXXX (founder externo).
 * Espeja: HYBRID_ID_PATTERN en src/schemas.py
 */
export const hybridIdSchema = z
  .string()
  .regex(
    /^(ANA|FND)-[A-Za-z0-9]{6}$/,
    "user_id debe tener formato ANA-XXXXXX o FND-XXXXXX"
  );

/**
 * Roles de usuario.
 * Espeja: UserRole = Literal["ANALISTA", "FOUNDER", "SOCIO"] en src/schemas.py
 */
export const userRoleSchema = z.enum(["ANALISTA", "FOUNDER", "SOCIO"]);

// ── UserInfo — datos públicos del usuario autenticado ─────────────────────────
// Espeja: class UserPublic(BaseModel) en src/schemas.py

export const userInfoSchema = z.object({
  user_id:      hybridIdSchema,
  email:        z.string().email("email inválido"),
  name:         z.string().default(""),
  role:         userRoleSchema,
  company_id:   z.string().default(""),
  /** Slug canónico de la empresa — resuelto en el backend desde el dominio del email. */
  company_slug: z.string().default(""),
  /** Nombre de display — ej. "Solvento", "Startup Demo". */
  company_name: z.string().default(""),
});

export type UserInfo = z.infer<typeof userInfoSchema>;

// ── LoginRequest — body de POST /api/login ────────────────────────────────────
// Espeja: class LoginRequest(BaseModel) en src/api.py
// Uso: validación del formulario en LoginScreen antes de enviar al servidor.

export const loginRequestSchema = z.object({
  email:    z.string().email("Introduce un email válido"),
  password: z.string().min(1, "La contraseña no puede estar vacía"),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ── LoginResponse — respuesta de POST /api/login ──────────────────────────────
// Espeja: class LoginApiResponse(BaseModel) en src/schemas.py

export const loginResponseSchema = z.object({
  access_token: z.string().min(1, "access_token no puede estar vacío"),
  token_type:   z.string(),
  user:         userInfoSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

// ── MeResponse — respuesta de GET /api/me ─────────────────────────────────────
// Espeja: class MeApiResponse(BaseModel) en src/schemas.py

export const meResponseSchema = z.object({
  user_id:      hybridIdSchema,
  email:        z.string().email("email inválido"),
  name:         z.string().default(""),
  role:         userRoleSchema,
  company_id:   z.string().default(""),
  company_slug: z.string().default(""),
  company_name: z.string().default(""),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

// ── ValidationError — respuesta de error 422 del backend ─────────────────────
// Espeja: _format_validation_errors() en src/api.py

export const validationErrorItemSchema = z.object({
  loc:  z.array(z.union([z.string(), z.number()])),
  msg:  z.string(),
  type: z.string(),
});

export const validationErrorSchema = z.object({
  detail: z.array(validationErrorItemSchema),
});

export type ValidationErrorResponse = z.infer<typeof validationErrorSchema>;

// ── Analyst Review — Cerebro + Finalize ──────────────────────────────────────
// Espeja: KpiReviewRow, FinalizeAnalysisRequest, FinalizeAnalysisResponse en src/schemas.py

export const kpiReviewRowSchema = z.object({
  kpi_key:           z.string(),
  kpi_label:         z.string(),
  ai_value:          z.number().nullable().optional(),
  ai_raw:            z.string().nullable().optional(),
  unit:              z.string().nullable().optional(),
  /** Confidence de Gemini — 0.0 a 1.0. Umbral de alerta: < 0.80 */
  confidence:        z.number().min(0).max(1).nullable().optional(),
  is_valid:          z.boolean().default(false),
  physics_violation: z.boolean().default(false),
  /** Mensaje VIO-001..004 del Cerebro */
  cerebro_alert:     z.string().nullable().optional(),
  analyst_value:     z.number().nullable().optional(),
  analyst_note:      z.string().nullable().optional(),
  /** "gemini" | "calculated" | "manual" | "analyst_approved" */
  source:            z.string().default("gemini"),
});

export type KpiReviewRow = z.infer<typeof kpiReviewRowSchema>;

export const cerebroResultSchema = z.object({
  enriched_rows:          z.array(kpiReviewRowSchema),
  derived_rows:           z.array(kpiReviewRowSchema),
  violations:             z.array(z.string()),
  missing_required:       z.array(z.string()),
  has_physics_violations: z.boolean(),
  cross_checks:           z.object({
    net_burn_computed: z.boolean(),
    net_burn_monthly:  z.number().nullable(),
    runway_computed:   z.boolean(),
    runway_months:     z.number().nullable(),
  }),
  approval_blocked: z.boolean(),
});

export type CerebroResult = z.infer<typeof cerebroResultSchema>;

export const finalizeAnalysisRequestSchema = z.object({
  load_id:         z.string().uuid(),
  slug:            z.string().min(2).max(64),
  periodo:         z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, "formato YYYY-MM"),
  source_file_uri: z.string().startsWith("gs://"),
  analyst_id:      hybridIdSchema,
  currency:        z.string().default("USD"),
  kpi_rows:        z.array(kpiReviewRowSchema),
  force_approve:   z.boolean().default(false),
});

export type FinalizeAnalysisRequest = z.infer<typeof finalizeAnalysisRequestSchema>;

export const finalizeAnalysisResponseSchema = z.object({
  gold_uri:         z.string(),
  pdf_gold_uri:     z.string(),
  bq_rows_upserted: z.number(),
  timestamp_gold:   z.string(),
  dashboard_url:    z.string().default(""),
  warnings:         z.array(z.string()),
});

export type FinalizeAnalysisResponse = z.infer<typeof finalizeAnalysisResponseSchema>;

// ── BucketFile — GET /api/analyst/buckets ─────────────────────────────────────
// Espeja: BucketFile + BucketListResponse en src/schemas.py

export const bucketFileSchema = z.object({
  uri:           z.string(),
  name:          z.string(),
  layer:         z.enum(["raw", "stage", "vault", "gold", "historicofund", "pending"]),
  company_slug:  z.string().default(""),
  size_bytes:    z.number().default(0),
  updated_at:    z.string().default(""),
  load_id:       z.string().default(""),
  company_found: z.boolean().default(false),
  official_name: z.string().default(""),
});

export type BucketFile = z.infer<typeof bucketFileSchema>;

export const bucketListResponseSchema = z.object({
  layer:           z.string(),
  files:           z.array(bucketFileSchema),
  next_page_token: z.string().default(""),
  total:           z.number().default(0),
  warning:         z.string().optional(),
});

export type BucketListResponse = z.infer<typeof bucketListResponseSchema>;

// ── ChecklistStatus — sector KPI validation from POST /upload ─────────────────
// Espeja: build_checklist_status() en src/core/data_contract.py

export const checklistStatusSchema = z.object({
  bucket:                z.string(),
  is_complete:           z.boolean(),
  present_kpis:          z.array(z.string()),
  missing_critical_kpis: z.array(z.string()),
  display_message:       z.string(),
  // Per-KPI confidence scores extracted from Gemini (0–100 integer scale)
  confidence_scores:     z.record(z.string(), z.number()).optional(),
});

export type ChecklistStatus = z.infer<typeof checklistStatusSchema>;

// ── KpiGridRow — fila de la grilla de 109 KPIs (audit.kpi_grid) ──────────────
// Espeja build_kpi_status_grid() en src/core/local_db.py

export const kpiGridRowSchema = z.object({
  kpi_id:          z.string(),
  status:          z.enum(["FOUND", "MISSING", "MANUAL_FOUND"]),
  value:           z.number().nullable(),
  display_name:    z.string().optional(),
  category:        z.string().nullable().optional(),
  innegociable:    z.boolean().optional(),
  given_or_silver: z.string().optional(),
  unit:            z.string().nullable().optional(),
  severity:        z.string().optional(),
});

export type KpiGridRow = z.infer<typeof kpiGridRowSchema>;

export const kpiGridSummarySchema = z.object({
  total:   z.number(),
  found:   z.number(),
  missing: z.number(),
  source:  z.string().optional(),
});

export type KpiGridSummary = z.infer<typeof kpiGridSummarySchema>;

// ── UploadResponse — respuesta de POST /upload ────────────────────────────────
// Espeja: la respuesta del endpoint de ingesta de documentos en api.py

export const uploadResponseSchema = z.object({
  duplicate:             z.boolean().optional(),
  file_hash:             z.string().optional(),
  result:                z.unknown().optional(),
  error:                 z.string().optional(),
  message:               z.string().optional(),
  checklist_status:      checklistStatusSchema.optional(),
  company_domain:        z.string().optional(),
  // Per-KPI confidence scores extracted from Gemini (0–100 integer scale)
  kpi_confidence_scores: z.record(z.string(), z.number()).optional(),
  // 109-KPI audit grid — present when backend runs commitment gate
  audit: z.object({
    kpi_grid:         z.array(kpiGridRowSchema).optional(),
    kpi_grid_summary: kpiGridSummarySchema.optional(),
  }).optional(),
  // Commitment gate top-level (pending_kpis responses)
  commitment_gate: z.object({
    counter:           z.string().optional(),
    gate_passed:       z.boolean().optional(),
    coverage_pct:      z.number().optional(),
    missing_required:  z.array(z.unknown()).optional(),
    ui_hint:           z.string().optional(),
  }).optional(),
  status: z.string().optional(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;

// ── AnalysisResult — item en GET /api/results ────────────────────────────────
// Espeja: el modelo de resultado de análisis financiero

export const analysisMetadataSchema = z.object({
  file_hash:         z.string().default(""),
  original_filename: z.string().default(""),
  founder_email:     z.string().default(""),
  processed_at:      z.string().default(""),
  gcs_path:          z.string().default(""),
  // BQ-sourced results include these extra fields
  company_domain:    z.string().optional(),
  portfolio_id:      z.string().optional(),
});

export const analysisResultSchema = z.object({
  id:           z.string(),
  data:         z.record(z.string(), z.unknown()),
  date:         z.string().default(""),
  metadata:     analysisMetadataSchema,
  value_status: z.string().optional(),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const resultsResponseSchema = z.object({
  status:  z.string(),
  results: z.array(analysisResultSchema),
});

export type ResultsResponse = z.infer<typeof resultsResponseSchema>;

// ── Company — item en GET /api/companies ──────────────────────────────────────
export const companySchema = z.object({
  id:     z.string(),
  name:   z.string(),
  domain: z.string().optional(),
  sector: z.string().optional(),
});

export type Company = z.infer<typeof companySchema>;

export const companiesResponseSchema = z.object({
  companies: z.array(companySchema),
});

export type CompaniesResponse = z.infer<typeof companiesResponseSchema>;

// ── PortfolioCompanies — GET /api/portfolio-companies ─────────────────────────
// Espeja la respuesta real del backend (no requiere auth)

export const portfolioCompanyEntrySchema = z.object({
  key:         z.string(),
  /** Canonical company_id — mirrors the `key` field, added for explicit navigation. */
  id:          z.string().optional(),
  company_id:  z.string().optional(),
  slug:        z.string().optional(),
  label:       z.string(),
  is_overview: z.boolean().default(false),
  has_data:    z.boolean().default(false),
});

export type PortfolioCompanyEntry = z.infer<typeof portfolioCompanyEntrySchema>;

export const portfolioEntrySchema = z.object({
  portfolio_id:   z.string(),
  portfolio_name: z.string(),
  companies:      z.array(portfolioCompanyEntrySchema),
});

export const portfolioCompaniesResponseSchema = z.object({
  status:     z.string(),
  portfolios: z.array(portfolioEntrySchema),
});

export type PortfolioEntry            = z.infer<typeof portfolioEntrySchema>;
export type PortfolioCompaniesResponse = z.infer<typeof portfolioCompaniesResponseSchema>;

// ── ManualUpdateResponse — respuesta de POST /api/founder/manual-update ───────
// Espeja: el endpoint de corrección manual de KPIs en api.py

export const manualUpdateResponseSchema = z.object({
  status:         z.string(),
  updated_fields: z.array(z.string()),
});

export type ManualUpdateResponse = z.infer<typeof manualUpdateResponseSchema>;

// ── SetupPasswordResponse — respuesta de POST /api/auth/setup-password ──────────
// Espeja la misma forma que loginResponseSchema (auto-login tras activación)

export const setupPasswordResponseSchema = loginResponseSchema;
export type SetupPasswordResponse = LoginResponse;

// ── InvitationsResponse — respuesta de GET /api/admin/invitations ─────────────
// Espeja: admin_invitations() en api.py

export const invitationSchema = z.object({
  email:      z.string(),
  name:       z.string().default(""),
  company_id: z.string().default(""),
  status:     z.string(),   // "ACTIVE" | "PENDING_INVITE"
});

export const invitationsResponseSchema = z.object({
  invitations: z.array(invitationSchema),
});

export type Invitation = z.infer<typeof invitationSchema>;
export type InvitationsResponse = z.infer<typeof invitationsResponseSchema>;

// ── KpiUpdateResponse — respuesta de PUT /api/kpi-update ─────────────────────
// Espeja: kpi_update() en api.py → update_kpi_value() en db_writer.py

export const kpiUpdateResponseSchema = z.object({
  status:        z.string(),
  message:       z.string(),
  submission_id: z.string().optional(),
  kpi_key:       z.string().optional(),
  raw_value:     z.string().optional(),
  numeric_value: z.number().nullable().optional(),
  unit:          z.string().optional(),
  is_valid:      z.boolean().optional(),
});

export type KpiUpdateResponse = z.infer<typeof kpiUpdateResponseSchema>;

// ── AdminInviteResponse — respuesta de POST /api/admin/invite ─────────────────
// Espeja: admin_invite() en api.py

export const adminInviteResponseSchema = z.object({
  status:       z.string(),
  email:        z.string(),
  company_name: z.string(),
  setup_url:    z.string(),
  email_sent:   z.boolean(),
  email_error:  z.string().default(""),
});

export type AdminInviteResponse = z.infer<typeof adminInviteResponseSchema>;

// ── KpiMetadata — respuesta de GET /api/kpi-metadata ─────────────────────────
// Espeja: dim_kpi_metadata en BigQuery + query_kpi_metadata() en db_writer.py

export const kpiMetadataItemSchema = z.object({
  kpi_key:             z.string(),
  display_name:        z.string(),
  vertical:            z.string(),  // 'GENERAL' | 'SAAS' | 'FINTECH' | 'MARKETPLACE' | 'INSURTECH'
  description:         z.string().nullable().optional(),
  unit:                z.string().nullable().optional(),
  min_historical_year: z.number().nullable().optional(),
  is_required:         z.boolean().default(false),
  example_value:       z.string().nullable().optional(),
});

export type KpiMetadataItem = z.infer<typeof kpiMetadataItemSchema>;

export const kpiMetadataResponseSchema = z.object({
  status:   z.string(),
  kpis:     z.array(kpiMetadataItemSchema),
  vertical: z.string().nullable().optional(),
});

export type KpiMetadataResponse = z.infer<typeof kpiMetadataResponseSchema>;

// ── CoverageHeatmap — respuesta de GET /api/analyst/coverage ─────────────────
// Espeja: query_coverage() en src/core/db_writer.py

export const coverageCellSchema = z.object({
  company:        z.string(),
  period:         z.string(),
  status:         z.enum(["verified", "legacy", "missing"]),
  kpi_count:      z.number(),
  verified_count: z.number(),
  legacy_count:   z.number(),
});

export const coverageCompanySchema = z.object({
  key:          z.string(),
  display:      z.string(),
  portfolio_id: z.string().optional(),
});

export const coverageResponseSchema = z.object({
  status:    z.string(),
  companies: z.array(coverageCompanySchema),
  periods:   z.array(z.string()),
  cells:     z.array(coverageCellSchema),
});

export type CoverageCell     = z.infer<typeof coverageCellSchema>;
export type CoverageCompany  = z.infer<typeof coverageCompanySchema>;
export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

// ── FinalizeResponse — respuesta de POST /api/founder/finalize ────────────────
// Espeja: founder_finalize() en api.py

export const finalizeResponseSchema = z.object({
  status:     z.string(),
  message:    z.string(),
  sent_to:    z.string().optional(),
  // SHA-256 Vault Seal — ID de transacción de integridad del expediente
  vault_seal: z.string().optional(),
});

export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;

// ── FounderConfig — respuesta de GET /api/founder/config ─────────────────────
// Espeja: founder_config() en api.py — auto-detección de empresa y vertical.

export const founderConfigSchema = z.object({
  company_id:           z.string(),
  vertical:             z.enum(["SAAS", "FINTECH", "MARKETPLACE", "INSURTECH", "GENERAL"]),
  is_known:             z.boolean(),
  domain:               z.string(),
  company_display_name: z.string().optional(), // Nombre legible para UI — puede faltar en respuestas antiguas
});

export type FounderConfig = z.infer<typeof founderConfigSchema>;

// ── SubmissionBlocked — respuesta 400 del gate de validación ─────────────────
// Espeja: validate_founder_submission() en src/core/data_contract.py
// Retornado cuando faltan KPIs obligatorios o hay violaciones de sanidad.
// El archivo YA fue escrito en GCS/BQ — sólo se bloquea la respuesta 200.

export const sanityViolationSchema = z.object({
  kpi_key:               z.string(),
  label:                 z.string(),
  value:                 z.number(),
  rule_description:      z.string(),
  requires_justification: z.literal(true),
});

export const missingMandatoryFieldSchema = z.object({
  kpi_key: z.string(),
  label:   z.string(),
});

export const submissionBlockedSchema = z.object({
  status:                   z.literal("blocked"),
  error:                    z.literal("submission_incomplete"),
  missing_mandatory_fields: z.array(missingMandatoryFieldSchema),
  sanity_violations:        z.array(sanityViolationSchema),
  file_hash:                z.string().optional(),
  company_domain:           z.string().optional(),
  checklist_status:         checklistStatusSchema.optional(),
  kpi_confidence_scores:    z.record(z.string(), z.number()).optional(),
});

export type SanityViolation    = z.infer<typeof sanityViolationSchema>;
export type MissingField       = z.infer<typeof missingMandatoryFieldSchema>;
export type SubmissionBlocked  = z.infer<typeof submissionBlockedSchema>;

// ── UiAction — control visual emitido por Gemini vía <!--ACTION:{...}--> ─────
// Backend extrae el marcador del texto y lo incluye en chatResponseSchema.
// Frontend (AITerminal) también lo escanea al final del stream SSE.

export const uiActionParamsSchema = z.record(z.string(), z.string());

export const uiActionSchema = z.object({
  action: z.string(),          // e.g. "SET_FILTER"
  params: uiActionParamsSchema, // e.g. { company: "rintin", kpi: "mrr" }
});

export type UiActionParams = z.infer<typeof uiActionParamsSchema>;
export type UiAction       = z.infer<typeof uiActionSchema>;

// ── ChatResponse — respuesta de POST /api/chat ────────────────────────────────
// Espeja la respuesta del endpoint de chat en api.py

export const chatResponseSchema = z.object({
  status:          z.string(),
  answer:          z.string(),
  sources_count:   z.number().optional(),
  has_legacy_data: z.boolean().optional(),
  portfolio_id:    z.string().nullable().optional(),
  company_id:      z.string().nullable().optional(),
  ui_action:       uiActionSchema.optional(),
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;

// ── SystemSettings — GET /api/admin/settings  ────────────────────────────────
// Espeja: SystemSettingsResponse en src/schemas.py (arquitectura GCP nativa)
// service_account_key nunca viaja en claro — solo flag booleano.

export const LLM_MODELS = ["gemini-1.5-pro", "gemini-1.5-flash", "claude-3-opus"] as const;
export const GCP_REGIONS = ["us-central1", "us-east4", "us-west1", "europe-west1", "europe-west4"] as const;
export type LlmModel  = typeof LLM_MODELS[number];
export type GcpRegion = typeof GCP_REGIONS[number];

export const systemSettingsResponseSchema = z.object({
  // Vertex AI / LLM
  llm_model:               z.string(),
  gcp_region:              z.string(),
  // GCP Infrastructure
  gcp_project_id:          z.string(),
  bq_dataset:              z.string(),
  service_account_key_set: z.boolean(),
  // Looker & Export
  looker_url:              z.string(),
  gcs_bucket:              z.string(),
  alert_webhook:           z.string(),
  // Thresholds
  min_confidence:          z.number().int(),
  irr_alert_below:         z.number().int(),
  notification_email:      z.string(),
});

export type SystemSettingsResponse = z.infer<typeof systemSettingsResponseSchema>;

// ── SettingsUpdateRequest — body de POST /api/admin/settings ─────────────────
// Espeja: SettingsUpdateRequest en src/api.py

export const settingsUpdateRequestSchema = z.object({
  llm_model:           z.string(),
  gcp_region:          z.string(),
  gcp_project_id:      z.string(),
  bq_dataset:          z.string(),
  service_account_key: z.string(),   // vacío = conservar anterior
  looker_url:          z.string(),
  gcs_bucket:          z.string(),
  alert_webhook:       z.string(),
  min_confidence:      z.number().int(),
  irr_alert_below:     z.number().int(),
  notification_email:  z.string(),
});

export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;

// ── ConfirmGoldResponse — respuesta de POST /api/analyst/confirm-gold ─────────
// Espeja: analyst_confirm_gold() en src/api.py

export const confirmGoldResponseSchema = z.object({
  status:          z.string(),
  load_id:         z.string(),
  rows_inserted:   z.number(),
  rows_updated:    z.number(),
  rows_error:      z.number(),
  quality_summary: z.record(z.string(), z.unknown()).optional(),
  warnings:        z.array(z.string()),
  gold_uri:        z.string(),
  approved_by:     z.string(),
});

export type ConfirmGoldResponse = z.infer<typeof confirmGoldResponseSchema>;

// ── AnalystEditResponse — respuesta de POST /api/analyst/audit-edit ──────────
// Espeja: analyst_audit_edit() en api.py — batch edit con hash de auditoría.

export const analystEditResponseSchema = z.object({
  status:        z.string(),
  audit_hash:    z.string(),
  updated_kpis:  z.array(z.string()),
  failed_kpis:   z.array(z.object({ kpi_key: z.string(), error: z.string() })).default([]),
  submission_id: z.string(),
  processed_at:  z.string(),
});

export type AnalystEditResponse = z.infer<typeof analystEditResponseSchema>;

// ── UnifiedKPIContract — Patrón Adaptador Unificado ───────────────────────────
// Espeja: UnifiedKPIMetric + ProcessDocumentResponse en src/schemas.py
// Usado por POST /api/founder/process-document

export const unifiedKPIMetricSchema = z.object({
  metric_id: z.string(),
  value:     z.number(),
  period_id: z.string(),
  source:    z.enum(["PDF", "EXCEL"]),
});

export type UnifiedKPIMetric = z.infer<typeof unifiedKPIMetricSchema>;

/**
 * Respuesta de POST /api/founder/process-document.
 * cerebro contiene el resultado completo de run_cerebro_unified():
 *   enriched_rows, derived_rows, violations, missing_required,
 *   has_physics_violations, cross_checks, approval_blocked.
 */
const processDocumentAuditSchema = z.object({
  company_name:  z.string().default(""),
  year:          z.string().default(""),
  raw_file_path: z.string().default(""),
  preview_url:   z.string().default(""),
});

export type ProcessDocumentAudit = z.infer<typeof processDocumentAuditSchema>;

export const processDocumentResponseSchema = z.object({
  submission_id: z.string(),
  rows_inserted: z.number().int(),
  timestamp:     z.string(),
  period_id:     z.string(),
  company_id:    z.string(),
  metrics_count: z.number().int(),
  // cerebro puede llegar vacío ({}) en uploads multi-período donde el Cerebro no corre.
  // z.record acepta cualquier objeto, incluyendo {}. El componente sigue haciendo
  // "as CerebroResult" cuando necesita los campos específicos.
  cerebro:       z.record(z.unknown()).default({}),
  periods:       z.array(z.string()).default([]),
  audit:         processDocumentAuditSchema.optional().default({}),
});

export type ProcessDocumentApiResponse = z.infer<typeof processDocumentResponseSchema>;

// ── Founder Staging — respuesta de GET /api/founder/staging ───────────────────
// Espeja: get_founder_staging() en src/routers/founder.py
// Muestra los KPIs en fact_kpi_staging con status='PENDING' para el founder.

const stagingRowSchema = z.object({
  metric_id: z.string(),
  value:     z.number().nullable(),
  period_id: z.string(),
});

const stagingBatchSchema = z.object({
  staging_id:   z.string(),
  company_id:   z.string(),
  submitted_at: z.string(),
  source_file:  z.string(),
  status:       z.string(),
  rows:         z.array(stagingRowSchema),
});

export const founderStagingSchema = z.object({
  company_id: z.string(),
  total_rows: z.number().int(),
  batches:    z.array(stagingBatchSchema),
});

export type FounderStaging = z.infer<typeof founderStagingSchema>;
export type StagingBatch   = z.infer<typeof stagingBatchSchema>;

// ── Analyst Staging Queue — GET /api/analyst/staging/pending ──────────────────
// Espeja: get_pending_staging() en src/routers/analyst.py

const analystStagingRowSchema = z.object({
  metric_id: z.string(),
  value:     z.number().nullable(),
  period_id: z.string(),
});

export const analystStagingBatchSchema = z.object({
  staging_id:       z.string(),
  company_id:       z.string(),
  company_name:     z.string().default(""),
  submitted_by:     z.string().default(""),
  submitted_at:     z.string().nullable().optional(),
  physics_ok:       z.boolean().default(true),
  physics_notes:    z.string().nullable().optional(),
  source_file:      z.string().nullable().optional(),
  filename:         z.string().default(""),
  company_mismatch: z.boolean().default(false),
  kpi_count:        z.number().int(),
  rows:             z.array(analystStagingRowSchema),
});

export const analystStagingQueueSchema = z.object({
  pending_count: z.number().int(),
  batches:       z.array(analystStagingBatchSchema),
});

export type AnalystStagingBatch = z.infer<typeof analystStagingBatchSchema>;
export type AnalystStagingQueue = z.infer<typeof analystStagingQueueSchema>;

// ── Validate Staging Response — POST /api/analyst/staging/validate ────────────
export const validateStagingResponseSchema = z.object({
  staging_id:    z.string(),
  action:        z.string(),
  rows_promoted: z.number().int(),
  validated_by:  z.string(),
  timestamp:     z.string(),
});

export type ValidateStagingResponse = z.infer<typeof validateStagingResponseSchema>;

// ── Raw URL Response — GET /api/analyst/staging/raw-url ──────────────────────
// Accepts staging_id OR gcs_uri on the backend — both produce the same response shape.
export const stagingRawUrlSchema = z.object({
  signed_url: z.string(),
  expires_in: z.number().int(),
  filename:   z.string(),
  gcs_path:   z.string().optional(),
});

export type StagingRawUrl = z.infer<typeof stagingRawUrlSchema>;

// ── Portfolio Metadata — respuesta de GET /api/metadata ───────────────────────
// Espeja: class PortfolioMetadataResponse(BaseModel) en src/schemas.py
//
// Centraliza en el backend los mapas que antes estaban hardcodeados en el
// dashboard del analista. Un cambio en el backend se propaga sin redeploy.

export const portfolioMetadataSchema = z.object({
  /** company slug → vertical label: "SaaS" | "Lending" | "eCommerce" | "InsurTech" | "Other" */
  vertical_map:   z.record(z.string(), z.string()).default({}),
  /** company slug → porcentaje de KPIs cubiertos (0–100) */
  coverage_map:   z.record(z.string(), z.number().int().min(0).max(100)).default({}),
  /** company slug → último período reportado (e.g. "Mar 2026") */
  last_month_map: z.record(z.string(), z.string()).default({}),
});

export type PortfolioMetadata = z.infer<typeof portfolioMetadataSchema>;
