"""
schemas.py — Pydantic models for Cometa Pipeline.

Responsabilidades:
  - Fuente única de verdad para la forma de los datos en el backend.
  - Toda entidad que se persiste o se expone por API debe tener un modelo aquí.
  - UserSchema es la puerta obligatoria antes de cualquier escritura en users.json:
    _save_users() SOLO acepta list[UserSchema], lo que hace imposible persistir
    datos sin validar a nivel de firma de función.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, EmailStr, field_validator, model_validator
from typing import Optional

# ── Constantes de validación ───────────────────────────────────────────────────
HYBRID_ID_PATTERN: str   = r"^(ANA|FND)-[A-Za-z0-9]{6}$"
HYBRID_ID_RE: re.Pattern = re.compile(HYBRID_ID_PATTERN)

UserRole = Literal["ANALISTA", "FOUNDER", "SOCIO"]


# ── Modelos de persistencia (users.json) ──────────────────────────────────────

class StoredUser(BaseModel):
    """
    Representación permisiva de un usuario leído desde users.json.
    Acepta IDs legacy (e.g. 'U001') para no romper lecturas antes de la migración.
    Solo se usa en _load_users() — nunca para escritura.
    """
    id:            str
    email:         EmailStr
    password:      str
    name:          str  = ""
    role:          str  = "FOUNDER"
    company_id:    str  = ""
    status:        str  = "ACTIVE"   # ACTIVE | PENDING_INVITE
    auth_provider: str  = "password" # password | google


class UserSchema(BaseModel):
    """
    Contrato de escritura: única representación que _save_users() acepta.

    Invariantes garantizadas en construcción:
      - id       → formato ^(ANA|FND)-[A-Za-z0-9]{6}$ (ID Híbrido válido)
      - email    → dirección válida según RFC 5322, normalizada a minúscula
      - role     → uno de ANALISTA | FOUNDER | SOCIO
      - password → presente y no vacío
      - status   → ACTIVE | PENDING_INVITE (default ACTIVE)
      - auth_provider → password | google (default password)

    Al requerir list[UserSchema] como firma de _save_users(), es imposible
    llamar esa función con datos sin validar — el error ocurre en construcción,
    antes de que se abra cualquier archivo.
    """
    id:            str
    email:         EmailStr
    password:      str
    name:          str      = ""
    role:          UserRole = "FOUNDER"
    company_id:    str      = ""
    status:        str      = "ACTIVE"
    auth_provider: str      = "password"

    @field_validator("id")
    @classmethod
    def id_must_be_hybrid(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"user_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v

    @field_validator("email", mode="before")
    @classmethod
    def email_to_lowercase(cls, v: str) -> str:
        return str(v).strip().lower()

    @field_validator("password")
    @classmethod
    def password_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("password no puede estar vacío")
        return v


# Alias backward-compatible — código existente que importa UserOut sigue funcionando
UserOut = UserSchema


# ── Modelos de respuesta de API ───────────────────────────────────────────────

class UserPublic(BaseModel):
    """
    Datos del usuario que se exponen en /api/login y /api/me.
    No incluye password ni campos internos de almacenamiento.
    company_slug y company_name se resuelven al login y se inyectan en el JWT.
    """
    user_id:      str
    email:        EmailStr
    name:         str      = ""
    role:         UserRole
    company_id:   str      = ""
    company_slug: str      = ""   # ej. "solvento", "demo-startup"
    company_name: str      = ""   # ej. "Solvento", "Startup Demo"

    @field_validator("user_id")
    @classmethod
    def user_id_must_be_hybrid(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"user_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v


class LoginApiResponse(BaseModel):
    """Forma completa de la respuesta de POST /api/login."""
    access_token: str
    token_type:   str
    user:         UserPublic


class MeApiResponse(BaseModel):
    """Forma completa de la respuesta de GET /api/me."""
    user_id:      str
    email:        EmailStr
    name:         str      = ""
    role:         UserRole
    company_id:   str      = ""
    company_slug: str      = ""
    company_name: str      = ""

    @field_validator("user_id")
    @classmethod
    def user_id_must_be_hybrid(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"user_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v


# ── System Settings ────────────────────────────────────────────────────────────

class SystemSettings(BaseModel):
    """
    Configuración del sistema VC-OS — arquitectura GCP nativa.
    Persistida en src/settings.json (escritura atómica).
    Accesible solo por ANALISTA/SOCIO vía /api/admin/settings.
    """
    # Vertex AI / LLM
    llm_model:           str = "gemini-1.5-pro"
    gcp_region:          str = "us-central1"
    # GCP Infrastructure
    gcp_project_id:      str = ""
    bq_dataset:          str = ""
    service_account_key: str = ""   # JSON blob — nunca se expone en GET
    # Looker & Export
    looker_url:          str = ""
    gcs_bucket:          str = ""
    alert_webhook:       str = ""
    # Thresholds
    min_confidence:      int = 70
    irr_alert_below:     int = 12
    notification_email:  str = ""

    @field_validator("min_confidence", mode="before")
    @classmethod
    def coerce_confidence(cls, v: object) -> int:
        try:
            c = int(v)
        except (TypeError, ValueError):
            return 70
        if not (0 <= c <= 100):
            raise ValueError("min_confidence debe estar entre 0 y 100")
        return c

    @field_validator("irr_alert_below", mode="before")
    @classmethod
    def coerce_irr(cls, v: object) -> int:
        try:
            return int(v)
        except (TypeError, ValueError):
            return 12


class SystemSettingsResponse(BaseModel):
    """Respuesta de GET /api/admin/settings — nunca expone secrets en claro."""
    # Vertex AI / LLM
    llm_model:                str
    gcp_region:               str
    # GCP Infrastructure
    gcp_project_id:           str
    bq_dataset:               str
    service_account_key_set:  bool   # True si hay SA key guardada
    # Looker & Export
    looker_url:               str
    gcs_bucket:               str
    alert_webhook:            str
    # Thresholds
    min_confidence:           int
    irr_alert_below:          int
    notification_email:       str


# ── Analyst Review — Cerebro + Finalize ───────────────────────────────────────

class KpiReviewRow(BaseModel):
    """
    Fila de revision de KPI para la Vista de Analista.
    Combina el valor extraido por Gemini con la correccion del analista.
    """
    kpi_key:           str
    kpi_label:         str
    ai_value:          Optional[float] = None    # valor numerico de Gemini
    ai_raw:            Optional[str]   = None    # string original de Gemini
    unit:              Optional[str]   = None
    confidence:        Optional[float] = None    # 0.0 – 1.0
    is_valid:          bool            = False
    physics_violation: bool            = False
    cerebro_alert:     Optional[str]   = None    # mensaje de VIO-00x
    analyst_value:     Optional[float] = None    # correccion del analista
    analyst_note:      Optional[str]   = None    # justificacion escrita
    source:            str             = "gemini"  # "gemini"|"calculated"|"manual"


class FinalizeAnalysisRequest(BaseModel):
    """Body de POST /api/analyst/finalize-analysis."""
    load_id:         str
    slug:            str
    periodo:         str   # YYYY-MM
    source_file_uri: str   # gs://cometa-vc-raw-prod/...
    analyst_id:      str   # ANA-XXXXXX
    currency:        str   = "USD"
    kpi_rows:        list[KpiReviewRow]
    force_approve:   bool  = False   # bypass historicofund check for new companies

    @field_validator("periodo")
    @classmethod
    def periodo_format(cls, v: str) -> str:
        import re as _re
        if not _re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", v):
            raise ValueError("periodo debe tener formato YYYY-MM")
        return v

    @field_validator("analyst_id")
    @classmethod
    def analyst_id_format(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"analyst_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v


class BucketFile(BaseModel):
    """Un archivo en uno de los buckets del medallion pipeline."""
    uri:           str
    name:          str
    display_name:  str  = ""   # Nombre original del archivo (sin prefijo hash/load_id)
    layer:         Literal["raw", "stage", "vault", "gold", "historicofund", "pending"]
    company_slug:  str  = ""
    size_bytes:    int  = 0
    updated_at:    str  = ""
    load_id:       str  = ""
    company_found: bool = False
    official_name: str  = ""


class BucketListResponse(BaseModel):
    """Respuesta de GET /api/analyst/buckets."""
    layer:           str
    files:           list[BucketFile]
    next_page_token: str = ""
    total:           int = 0


class FinalizeAnalysisResponse(BaseModel):
    """Respuesta de POST /api/analyst/finalize-analysis."""
    gold_uri:         str
    pdf_gold_uri:     str
    bq_rows_upserted: int
    timestamp_gold:   str
    dashboard_url:    str = ""
    warnings:         list[str] = []


# ── Portfolio Metadata ─────────────────────────────────────────────────────────

class PortfolioMetadataResponse(BaseModel):
    """
    Respuesta de GET /api/metadata.

    Centraliza en el backend los mapas que antes vivían hardcodeados en el
    frontend. Fuente de verdad única: un cambio aquí se propaga a todos
    los clientes sin necesidad de un redeploy de Next.js.

    vertical_map   — company slug → vertical label (SaaS, Lending, …)
    coverage_map   — company slug → porcentaje de KPIs cubiertos (0-100)
    last_month_map — company slug → último período reportado (e.g. "Mar 2026")

    TODO (v2): derivar coverage_map y last_month_map desde BigQuery en lugar
    de constantes estáticas, usando query_coverage() de db_writer.py.
    """
    vertical_map:   dict[str, str] = {}
    coverage_map:   dict[str, int] = {}
    last_month_map: dict[str, str] = {}


# ── Unified KPI Contract — Embudo Universal ────────────────────────────────────
# Todo archivo ingerido (PDF o Excel) debe pasar por este contrato antes de
# ser escrito en BD_Cometa_Dev. Es la única forma que vc_validator y
# bq_data_service aceptan a partir de la fase de Unificación de Ingesta.

PERIOD_ID_RE: re.Pattern = re.compile(
    r"^(P20\d{2}Q[1-4]M\d{2}|FY20\d{2}|H[12]20\d{2})$"
)


class UnifiedKPIMetric(BaseModel):
    """
    Una métrica individual validada y mapeada al catálogo canónico de 109 KPIs.

    metric_id  — ID canónico del loading_brain (ej. "revenue", "mrr", "churn_customers")
    value      — Valor numérico en la moneda/unidad original del documento
    period_id  — Período canónico (ej. "P2026Q1M01", "FY2025")
    source     — Origen de la extracción: "PDF" o "EXCEL"
    """
    metric_id: str
    value:     float
    period_id: str
    source:    Literal["PDF", "EXCEL"]

    @field_validator("period_id")
    @classmethod
    def period_id_format(cls, v: str) -> str:
        if PERIOD_ID_RE.match(v):
            return v
        # Auto-normalizar formato corto que Gemini puede generar:
        # "P202603" → "P2026Q1M03"  (sin quarter)
        m_short = re.match(r"^P(20\d{2})(\d{2})$", v)
        if m_short:
            yr, mo = int(m_short.group(1)), int(m_short.group(2))
            if 1 <= mo <= 12:
                q = (mo - 1) // 3 + 1
                return f"P{yr}Q{q}M{mo:02d}"
        raise ValueError(
            f"period_id '{v}' no cumple el formato esperado "
            "(ej. P2026Q1M01, FY2025, H12025)"
        )


class UnifiedKPIContract(BaseModel):
    """
    Contrato universal de ingesta — única forma aceptada por vc_validator
    y bq_data_service.insert_submission_and_facts() a partir de la fase
    de Unificación de Ingesta.

    Ambos pipelines (PDF vía Gemini Vision y Excel vía Gemini Mapping)
    deben producir este objeto antes de cualquier escritura en BD_Cometa_Dev.
    Si la IA no puede producir este formato, la ingesta falla explícitamente.
    """
    metrics: list[UnifiedKPIMetric]

    @field_validator("metrics")
    @classmethod
    def metrics_not_empty(cls, v: list) -> list:
        if not v:
            raise ValueError("UnifiedKPIContract debe contener al menos una métrica")
        return v


class ProcessDocumentResponse(BaseModel):
    """
    Respuesta de POST /api/founder/process-document.

    cerebro — resultado completo de run_cerebro_unified():
      enriched_rows, derived_rows, violations, missing_required,
      has_physics_violations, cross_checks, approval_blocked.
    El frontend lo usa directamente para renderizar el panel de revisión
    sin necesidad de una segunda llamada al backend.

    Para Excel multi-período (Master Database):
      submission_id = staging_id del batch
      period_id     = primer período del batch (orden canónico)
      periods       = lista completa de períodos ingeridos
    """
    submission_id: str
    rows_inserted: int
    timestamp:     str
    period_id:     str
    company_id:    str
    metrics_count: int
    cerebro:       dict = {}        # CerebroResult — vacío si el cerebro no pudo ejecutarse
    periods:       list[str] = []   # Multi-período: lista de period_ids ingeridos
    audit:         dict = {}        # {company_name, year, raw_file_path, preview_url}
