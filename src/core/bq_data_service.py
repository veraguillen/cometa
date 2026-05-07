"""
bq_data_service.py
──────────────────
Capa de acceso a datos contra BigQuery (dataset BD_Cometa_Dev).

Responsabilidades:
  - get_company_metadata()          → resolución de empresa + sector desde BQ
  - insert_submission_and_facts()   → escritura secuencial: submissions → H
  - get_metrics_catalog()           → catálogo completo de dim_metric

Diseño:
  - Singleton de cliente BQ (una sola conexión por proceso).
  - Nunca hardcodea IDs ni diccionarios: toda resolución es dinámica vía SQL.
  - Levanta CompanyNotFoundError (capturble como HTTPException 404 en FastAPI).
  - Levanta BQInsertError (capturable como HTTPException 500 en FastAPI).
"""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
from datetime import date, datetime, timezone
from typing import Any, Optional

import pandas as pd
from google.api_core.exceptions import GoogleAPIError
from google.cloud import bigquery
from google.oauth2 import service_account

log = logging.getLogger(__name__)

# ── Constante de dataset — única fuente de verdad ─────────────────────────────
_DATASET = "cometa-mvp.BD_Cometa_Dev"
BQ_DATASET = _DATASET  # alias público para uso en routers externos

# TTL de la caché en memoria para get_portfolio_catalog().
# 5 min es suficiente para que los dashboards carguen rápido sin
# pegarle a BigQuery en cada render, y se actualice cuando cambie el portfolio.
_CATALOG_TTL_SECONDS: float = 300.0

# ── Diccionario de traducción bucket_id → nombre de vertical ──────────────────
# Fuente de verdad interna cuando dim_bucket no está disponible en el JOIN.
# Actualizar si se agregan nuevos buckets al portfolio.
_BUCKET_ID_TO_VERTICAL: dict[str, str] = {
    "B01": "SAAS",
    "B02": "FINTECH",
    "B03": "MARKETPLACE",
    "B04": "INSURTECH",
    "B05": "LENDING",
    "B06": "ECOMMERCE",
    "B07": "HEALTHTECH",
    "B08": "EDTECH",
    "B09": "PROPTECH",
    "B10": "GENERAL",
}

# Fail-safe: si alguien apunta a producción por error, el módulo no carga.
if not _DATASET.lower().endswith("_dev"):
    raise RuntimeError(
        f"bq_data_service apuntando a dataset no-Dev: '{_DATASET}'. "
        "Modifica _DATASET para que termine en '_dev'."
    )


# ── Excepciones de dominio ────────────────────────────────────────────────────

class CompanyNotFoundError(Exception):
    """La empresa consultada no existe en dim_company."""

    def __init__(self, company_id: str, detail: str | None = None) -> None:
        self.company_id = company_id
        msg = detail or f"No se encontró la empresa '{company_id}' en BigQuery ({_DATASET}.dim_company)."
        super().__init__(msg)


class BQInsertError(Exception):
    """Error irrecuperable durante la escritura en BigQuery."""


# ── Construcción del cliente (singleton) ──────────────────────────────────────

def _build_client() -> bigquery.Client:
    """
    Construye el cliente BQ.

    Orden de resolución de credenciales:
      1. Archivo explícito en GOOGLE_APPLICATION_CREDENTIALS (dev local).
      2. Application Default Credentials (Cloud Run / GKE).
    """
    key_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "cometa_key.json")
    if os.path.isfile(key_path):
        creds = service_account.Credentials.from_service_account_file(key_path)
        return bigquery.Client(credentials=creds, project=creds.project_id)
    # Fallback: ADC (entorno de nube)
    return bigquery.Client()


_CLIENT: Optional[bigquery.Client] = None


def _client() -> bigquery.Client:
    """Retorna el cliente singleton, inicializándolo en el primer uso."""
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = _build_client()
    return _CLIENT


# ── Helpers de período ────────────────────────────────────────────────────────

def _period_id_to_date(period_id: str) -> date:
    """Convierte un period_id canónico a la fecha de inicio del período."""
    m = re.match(r"P(20\d{2})Q[1-4]M(\d{2})", period_id)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    m2 = re.match(r"FY(20\d{2})", period_id)
    if m2:
        return date(int(m2.group(1)), 1, 1)
    m3 = re.match(r"H[12](20\d{2})", period_id)
    if m3:
        return date(int(m3.group(1)), 1, 1)
    return date.today()


# ── Helpers de sanitización de DataFrame ─────────────────────────────────────

# Columnas que SIEMPRE deben llegar a BigQuery como STRING puro.
# Si pandas las infiere como object/bytes (ej. uuid.UUID, bytes), el writer
# parquet falla con "Got bytestring of length 8 (expected 16)".
_STRING_ID_COLS: frozenset[str] = frozenset({
    "submission_id", "staging_id", "company_id", "fund_id",
    "metric_id", "period_id", "source_file", "submitted_by",
    "status", "scenario", "validated_by", "rejection_note",
    "physics_notes", "value_notes",
})

# Columnas de fecha/hora: NO deben convertirse a str.
# Pyarrow las necesita como datetime64[ns] (o pd.NaT para nulos).
_DATETIME_COLS: frozenset[str] = frozenset({
    "period_start", "submitted_at", "validated_at",
    "inserted_at", "created_at",
})


def _sanitize_df(df: pd.DataFrame) -> pd.DataFrame:
    """
    Prepara el DataFrame para el writer parquet de BigQuery.

    Problema 1 — bytestring (IDs):
      pandas infiere UUID / bytes como dtype=object; pyarrow los serializa
      como bytes y BQ rechaza con "Got bytestring of length 8 (expected 16)".
      Solución: cast explícito a str en _STRING_ID_COLS.

    Problema 2 — period_start (fechas):
      Python date / datetime almacenado como dtype=object tampoco lo convierte
      pyarrow correctamente a DATE/TIMESTAMP.
      Solución: forzar pd.to_datetime() en _DATETIME_COLS → dtype datetime64[ns].

    Reglas:
      - _STRING_ID_COLS → str, None/NaN → "".
      - _DATETIME_COLS  → pd.to_datetime(utc=True), NaT para nulos.
      - Resto object    → str (precaución genérica, excluye datetime cols).
      - Numéricas       → sin tocar.
    """
    df = df.copy()
    for col in df.columns:
        if col in _DATETIME_COLS:
            # Convertir Python date/datetime → datetime64[ns, UTC]
            # errors="coerce" convierte valores no parseables en NaT (no rompe)
            df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)
        elif col in _STRING_ID_COLS or df[col].dtype == object:
            df[col] = df[col].apply(
                lambda v: "" if (v is None or (isinstance(v, float) and pd.isna(v))) else str(v)
            )
    return df


# ══════════════════════════════════════════════════════════════════════════════
# BQDataService
# ══════════════════════════════════════════════════════════════════════════════

class BQDataService:
    """
    Servicio de acceso a datos contra BD_Cometa_Dev.

    Uso típico en FastAPI:
        bq = BQDataService()
        meta = bq.get_company_metadata("C001")

    Todos los métodos son síncronos — BigQuery SDK es bloqueante por diseño.
    En endpoints FastAPI, llamar desde un thread pool con run_in_executor si
    se necesita no bloquear el event loop.
    """

    def __init__(self) -> None:
        # Caché de get_portfolio_catalog() — comparte ciclo de vida con la instancia.
        self._catalog_cache: Optional[list[dict[str, Any]]] = None
        self._catalog_ts:    float = 0.0

    def get_bq_client(self) -> bigquery.Client:
        """Expone el cliente BQ singleton para uso en routers externos."""
        return _client()

    # ── 1. get_company_metadata ───────────────────────────────────────────────

    def get_company_metadata(self, company_id: str) -> dict[str, Any]:
        """
        Resuelve los metadatos de una empresa incluyendo su sector (bucket).

        Hace JOIN entre dim_company y dim_bucket para que el sector nunca
        esté hardcodeado en ninguna capa de la aplicación.

        Args:
            company_id: Identificador de empresa (formato C001).

        Returns:
            Diccionario con campos de dim_company + bucket_name.

        Raises:
            CompanyNotFoundError: Si company_id no existe en dim_company.
            BQInsertError: Si ocurre un error de conectividad con BigQuery.
        """
        # Intento 1: SELECT * + LEFT JOIN dim_bucket para resolver bucket_name.
        # Si el JOIN falla (columna bucket_id ausente), reintentamos sin JOIN.
        _join_query = f"""
            SELECT c.*, b.bucket_name
            FROM `{_DATASET}.dim_company` AS c
            LEFT JOIN `{_DATASET}.dim_bucket` AS b ON c.bucket_id = b.bucket_id
            WHERE c.company_id = @company_id
            LIMIT 1
        """
        _simple_query = f"""
            SELECT *
            FROM `{_DATASET}.dim_company`
            WHERE company_id = @company_id
            LIMIT 1
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("company_id", "STRING", company_id)
            ]
        )

        rows = None
        for _q in (_join_query, _simple_query):
            try:
                rows = list(_client().query(_q, job_config=job_config).result())
                break
            except GoogleAPIError as exc:
                log.warning("BQ query falló, reintentando sin JOIN: %s", exc)

        if rows is None:
            raise BQInsertError(f"No se pudo consultar dim_company para {company_id}")

        if not rows:
            # Build informative error listing available IDs
            try:
                _all = list(_client().query(
                    f"SELECT company_id, company_name FROM `{_DATASET}.dim_company` ORDER BY company_id"
                ).result())
                _available = ", ".join(
                    f"{dict(r.items()).get('company_id')}={dict(r.items()).get('company_name')}"
                    for r in _all
                ) or "(catálogo vacío)"
            except Exception:
                _available = "(no se pudo listar)"
            raise CompanyNotFoundError(
                company_id,
                detail=(
                    f"No se encontró la empresa '{company_id}' en BigQuery. "
                    f"IDs disponibles: {_available}"
                ),
            )

        # Convertir BigQuery Row a dict — acceso seguro independiente del esquema
        data: dict[str, Any] = dict(rows[0].items())
        log.debug("[BQ] dim_company columnas: %s", list(data.keys()))

        _cid       = data.get("company_id",   company_id)
        _name      = data.get("company_name", company_id)
        _bucket_id = data.get("bucket_id",    "")
        # bucket_name: preferir JOIN result, luego dict interno, luego bucket_id crudo
        _bname = (
            data.get("bucket_name")
            or _BUCKET_ID_TO_VERTICAL.get(_bucket_id, "")
            or _bucket_id
            or "GENERAL"
        )
        _fund  = data.get("fund_id", _cid)
        _country = data.get("country", None)

        return {
            "company_id":   _cid,
            "company_name": _name,
            "fund_id":      _fund,
            "bucket_id":    _bucket_id,
            "bucket_name":  _bname,
            "vertical":     _bname,
            "country":      _country,
        }

    # ── 2. resolve_company_id ─────────────────────────────────────────────────

    def resolve_company_id(self, identifier: str) -> str:
        """
        Normaliza cualquier identificador de empresa al company_id canónico
        almacenado en dim_company (ej. 'C013').

        Orden de resolución:
          1. Exact match on company_id (ej. 'C013')
          2. Case-insensitive exact match on company_name (ej. 'QUINIO' → 'Quinio')
          3. Alphanumeric-normalized match (ej. 'quinio-sa' → 'Quinio SA')
          4. Partial LIKE match — company_name CONTAINS identifier or vice-versa
          5. Python difflib fuzzy match on the full company catalog (handles typos
             like 'QUNIO' matching 'Quinio')

        Pass 1 (BQ) resolves steps 1-3 in a single query.
        Pass 2 (BQ + Python) resolves steps 4-5 if Pass 1 returns nothing.

        Args:
            identifier: company_id, nombre o slug de la empresa.

        Returns:
            El company_id canónico (ej. 'C013').

        Raises:
            CompanyNotFoundError: Si no se encuentra ninguna coincidencia.
                                  El mensaje incluye la lista de IDs disponibles.
            BQInsertError: Si ocurre un error de conectividad con BigQuery.
        """
        import difflib as _difflib

        ident = identifier.strip()

        # ── Emergency override table ────────────────────────────────────────────
        # Maps known-bad legacy slugs/IDs → canonical BQ company_id.
        # Used as a hard bypass while user sessions are migrating to the new ID format.
        # Extend this dict when new companies are onboarded and their old slug is known.
        _EMERGENCY_MAP: dict[str, str] = {
            "demo-startup":  "C010",   # founder@demo.com → Quinio
            "demostartup":   "C010",
            "quinio":        "C010",
        }
        _override = _EMERGENCY_MAP.get(ident.lower())
        if _override:
            log.info("[resolve_company_id] Emergency map '%s' → '%s'", ident, _override)
            return _override

        # ── Pre-pass: strip legacy COMP_XXX prefix ─────────────────────────────
        # founder_config generates "COMP_QUINIO", "COMP_DEMO_STARTUP" etc. from
        # PORTFOLIO_MAP keys. Strip the prefix and normalize to bare name before
        # running any BQ query so these synthetic IDs resolve to real C-prefixed IDs.
        if ident.upper().startswith("COMP_"):
            ident = ident[5:].replace("_", " ").strip()   # "COMP_QUINIO" → "QUINIO"
            log.debug("[resolve_company_id] COMP_ prefix stripped → '%s'", ident)

        # ── Pass 1: exact / case-insensitive / alphanumeric-normalized ────────
        _pass1 = f"""
            SELECT company_id, company_name
            FROM `{_DATASET}.dim_company`
            WHERE
                company_id = @ident
                OR LOWER(company_name) = LOWER(@ident)
                OR LOWER(REGEXP_REPLACE(company_name, r'[^a-zA-Z0-9]', ''))
                   = LOWER(REGEXP_REPLACE(@ident, r'[^a-zA-Z0-9]', ''))
            LIMIT 1
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("ident", "STRING", ident)]
        )
        try:
            rows = list(_client().query(_pass1, job_config=job_config).result())
        except GoogleAPIError as exc:
            log.error("[resolve_company_id] Pass-1 BQ error: %s", exc)
            raise BQInsertError(f"Error al resolver company_id para '{ident}': {exc}") from exc

        if rows:
            resolved = dict(rows[0].items()).get("company_id", ident)
            log.info("[resolve_company_id] Pass-1 '%s' → '%s'", ident, resolved)
            return resolved

        # ── Pass 2: fetch full catalog, try LIKE partial + Python fuzzy ───────
        _catalog_q = f"""
            SELECT company_id, company_name
            FROM `{_DATASET}.dim_company`
            ORDER BY company_id
        """
        try:
            catalog_rows = list(_client().query(_catalog_q).result())
        except GoogleAPIError as exc:
            log.error("[resolve_company_id] Pass-2 catalog fetch error: %s", exc)
            raise BQInsertError(f"Error al obtener catálogo de empresas: {exc}") from exc

        catalog: list[tuple[str, str]] = [
            (dict(r.items()).get("company_id", ""), dict(r.items()).get("company_name", ""))
            for r in catalog_rows
        ]

        available_str = ", ".join(
            f"{cid}={cname}" for cid, cname in catalog
        ) or "(catálogo vacío)"

        if not catalog:
            raise CompanyNotFoundError(
                f"No se encontró la empresa '{ident}' en BigQuery. "
                "El catálogo de dim_company está vacío."
            )

        # Partial LIKE: identifier is substring of company_name or vice-versa
        ident_lower = ident.lower()
        for cid, cname in catalog:
            cname_lower = cname.lower()
            if ident_lower in cname_lower or cname_lower in ident_lower:
                log.info(
                    "[resolve_company_id] Pass-2 partial '%s' → '%s' (%s)",
                    ident, cid, cname,
                )
                return cid

        # Python fuzzy match against company names (handles single-char typos)
        cnames = [cname for _, cname in catalog]
        matches = _difflib.get_close_matches(ident, cnames, n=1, cutoff=0.6)
        if matches:
            best_name = matches[0]
            cid = next(cid for cid, cname in catalog if cname == best_name)
            log.info(
                "[resolve_company_id] Pass-2 fuzzy '%s' → '%s' (%s, score≥0.6)",
                ident, cid, best_name,
            )
            return cid

        # ── No match found — raise with full diagnostic ────────────────────────
        raise CompanyNotFoundError(
            f"No se encontró la empresa '{ident}' en BigQuery. "
            f"IDs disponibles: {available_str}"
        )

    # ── 3. insert_submission_and_facts ────────────────────────────────────────

    def insert_submission_and_facts(
        self,
        *,
        company_id:    str,
        fund_id:       str,
        period_id:     str,
        period_start:  date,
        submitted_by:  str,
        source_file:   str,
        kpi_rows:      list[dict[str, Any]],
        submission_id: Optional[str] = None,
        review_notes:  Optional[str] = None,
        raw_file_path: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Inserta atómicamente (secuencial en BQ) una submission y sus KPIs.

        Paso 1 — submissions:
            Inserta una fila con status='PENDING'.

        Paso 2 — fact_kpi_values:
            Inserta cada KPI como una fila enlazada al submission_id del Paso 1.
            Aprovecha la partición por period_start para eficiencia en escritura.

        Args:
            company_id:    FK a dim_company (ej. "C001").
            fund_id:       FK a dim_fund (ej. "F001").
            period_id:     FK a dim_period (ej. "P2026Q1M01").
            period_start:  Fecha de inicio del período — clave de partición.
            submitted_by:  Email o user_id del remitente.
            source_file:   GCS URI del archivo fuente (gs://...).
            kpi_rows:      Lista de dicts con claves:
                             metric_id (str), value (float|None), value_notes (str|None).
            submission_id: Si se omite, se genera un UUID con prefijo S.
            review_notes:  Comentario inicial del analista (opcional).

        Returns:
            Dict con submission_id, rows_inserted y timestamp.

        Raises:
            CompanyNotFoundError: Si company_id no existe (validación previa).
            BQInsertError: Si cualquiera de los dos inserts falla.
        """
        # Validar que la empresa existe antes de escribir nada
        self.get_company_metadata(company_id)

        # Garantizar strings puros — uuid.UUID serializado como bytes rompe el writer parquet
        sub_id    = str(submission_id) if submission_id else f"S{uuid.uuid4().hex[:6].upper()}"
        company_id = str(company_id)
        fund_id    = str(fund_id)   if fund_id    else ""
        period_id  = str(period_id) if period_id  else ""
        submitted_by = str(submitted_by) if submitted_by else ""
        source_file  = str(source_file)  if source_file  else ""
        now       = datetime.now(tz=timezone.utc)
        inserted  = now.isoformat()

        # ── Paso 1: insertar en submissions (columnas mínimas seguras) ───────
        # Solo usamos columnas que sabemos que existen en la tabla.
        # Si falla (schema mismatch, tabla ausente, etc.) se registra warning
        # pero el proceso continúa — los KPIs son lo que importa.
        _sub_record: dict[str, Any] = {
            "submission_id": sub_id,
            "company_id":    company_id,
            "status":        "PENDING",
            "created_at":    now,
            "source_file":   source_file,
        }
        if raw_file_path:
            _sub_record["raw_file_path"] = raw_file_path
        df_sub = pd.DataFrame([_sub_record])

        try:
            self._append_dataframe(df_sub, "submissions")
            log.info("Submission %s insertada para empresa %s", sub_id, company_id)
        except Exception as exc:
            log.warning(
                "Submissions insert falló para %s (se continúa con KPIs): %s",
                sub_id, exc,
            )

        # ── Paso 2: insertar en H (tabla unificada) ──────────────────────────
        if not kpi_rows:
            log.warning("insert_submission_and_facts: kpi_rows vacío para %s", sub_id)
            return {"submission_id": sub_id, "rows_inserted": 0, "timestamp": inserted}

        ps_str = period_start.strftime("%Y-%m-%d") if hasattr(period_start, "strftime") else str(period_start)[:10]

        # Lookup bucket_id from dim_metric (single batch query, non-fatal)
        _metric_ids = list({str(r["metric_id"]) for r in kpi_rows if r.get("metric_id")})
        _bucket_map: dict[str, Optional[str]] = {}
        if _metric_ids:
            try:
                _bsql = f"SELECT metric_id, bucket_id FROM `{_DATASET}.dim_metric` WHERE metric_id IN UNNEST(@mids)"
                _brows = list(_client().query(
                    _bsql,
                    job_config=bigquery.QueryJobConfig(query_parameters=[
                        bigquery.ArrayQueryParameter("mids", "STRING", _metric_ids)
                    ]),
                ).result())
                _bucket_map = {r.metric_id: r.bucket_id for r in _brows}
            except Exception as _be:
                log.warning("bucket_id lookup falló (non-fatal): %s", _be)

        records = [
            {
                "submission_id": sub_id,
                "company_id":    company_id,
                "fund_id":       fund_id or None,
                "bucket_id":     _bucket_map.get(str(row["metric_id"])),
                "period_id":     period_id,
                "period_start":  ps_str,
                "metric_id":     str(row["metric_id"]),
                "value":         row.get("value"),
                "notes":         str(row["value_notes"]) if row.get("value_notes") else None,
                "value_status":  "VERIFIED",
                "created_at":    now,
            }
            for row in kpi_rows
            if row.get("metric_id") is not None
        ]
        df_facts = pd.DataFrame(records)

        try:
            self._append_dataframe(df_facts, "H")
            log.info(
                "%d KPI(s) insertados en H para submission %s",
                len(records), sub_id,
            )
        except Exception as exc:
            log.error(
                "H falló para submission %s: %s — intentando limpiar fila huérfana",
                sub_id, exc,
            )
            # Borrar la fila de submissions huérfana para que el founder pueda reintentar
            try:
                _client().query(
                    f"DELETE FROM `{_DATASET}.submissions` WHERE submission_id = @sid",
                    job_config=bigquery.QueryJobConfig(query_parameters=[
                        bigquery.ScalarQueryParameter("sid", "STRING", str(sub_id)),
                    ]),
                ).result()
                log.info("Fila huérfana de submissions %s eliminada.", sub_id)
            except Exception as clean_exc:
                log.warning("Limpieza de submission %s falló (no bloqueante): %s", sub_id, clean_exc)
            raise BQInsertError(
                f"Fallo al insertar KPIs para submission {sub_id}: {exc}."
            ) from exc

        return {
            "submission_id": sub_id,
            "rows_inserted": len(records),
            "timestamp":     inserted,
            "raw_file_path": raw_file_path or "",
        }

    # ── 3. get_metrics_catalog ────────────────────────────────────────────────

    def get_metrics_catalog(
        self, *, only_core: Optional[bool] = None
    ) -> list[dict[str, Any]]:
        """
        Retorna el catálogo de métricas desde dim_metric.

        Args:
            only_core: Si True, solo métricas is_core=TRUE.
                       Si False, solo las específicas de sector.
                       Si None, retorna todas.

        Returns:
            Lista de dicts con todos los campos de dim_metric.

        Raises:
            BQInsertError: Si ocurre un error de conectividad.
        """
        where_clause = ""
        params: list[bigquery.ScalarQueryParameter] = []

        if only_core is not None:
            where_clause = "WHERE is_core = @only_core"
            params.append(
                bigquery.ScalarQueryParameter("only_core", "BOOL", only_core)
            )

        query = f"""
            SELECT
                metric_id,
                metric_name,
                description,
                unit,
                category,
                is_core
            FROM `{_DATASET}.dim_metric`
            {where_clause}
            ORDER BY metric_id
        """
        job_config = bigquery.QueryJobConfig(query_parameters=params)

        try:
            rows = list(_client().query(query, job_config=job_config).result())
        except GoogleAPIError as exc:
            log.error("BQ error en get_metrics_catalog: %s", exc)
            raise BQInsertError(f"Error al consultar dim_metric: {exc}") from exc

        return [
            {
                "metric_id":   r.metric_id,
                "metric_name": r.metric_name,
                "description": r.description,
                "unit":        r.unit,
                "category":    r.category,
                "is_core":     r.is_core,
            }
            for r in rows
        ]

    # ── 4a. get_company_catalog_for_scanner ──────────────────────────────────

    def get_company_catalog_for_scanner(self) -> list[dict[str, Any]]:
        """
        Retorna la lista mínima de empresas para el scanner de identidad de Excel.

        Delega en get_portfolio_catalog() (con caché de 5 min) y devuelve solo
        los campos que necesita detect_company_and_year_from_df():
          company_id, company_name, bucket_id.

        En caso de error devuelve lista vacía — la carga puede continuar aunque
        el scanner no tenga catálogo (el bloqueo lo gestiona el endpoint).
        """
        try:
            catalog = self.get_portfolio_catalog()
            return [
                {
                    "company_id":   str(c.get("company_id", "")),
                    "company_name": str(c.get("company_name", "")),
                    "bucket_id":    str(c.get("bucket_id", "")),
                }
                for c in catalog
                if c.get("company_id") and c.get("company_name")
            ]
        except Exception as exc:
            log.warning("get_company_catalog_for_scanner falló (no-fatal): %s", exc)
            return []

    # ── 4. get_portfolio_catalog ─────────────────────────────────────────────

    def get_portfolio_catalog(
        self,
    ) -> list[dict[str, Any]]:
        """
        Retorna la lista completa de empresas del portfolio desde dim_company.

        Hace LEFT JOIN con dim_bucket para incluir el nombre del sector sin
        hardcodear ningún diccionario.  El resultado se guarda en memoria
        durante _CATALOG_TTL_SECONDS (5 min) para que los dashboards carguen
        rápido sin golpear BigQuery en cada render.

        Returns:
            Lista de dicts con los campos:
                company_id, company_name, fund_id,
                bucket_id, bucket_name,
                country, founded_year, is_active (siempre True)

        Raises:
            BQInsertError: Si ocurre un error de conectividad con BigQuery.
        """
        now = time.monotonic()
        if (
            self._catalog_cache is not None
            and (now - self._catalog_ts) < _CATALOG_TTL_SECONDS
        ):
            return self._catalog_cache

        query = f"""
            SELECT c.*, b.bucket_name
            FROM `{_DATASET}.dim_company` AS c
            LEFT JOIN `{_DATASET}.dim_bucket` AS b ON c.bucket_id = b.bucket_id
            ORDER BY c.company_name
        """
        _fallback_query = f"""
            SELECT *
            FROM `{_DATASET}.dim_company`
            ORDER BY company_name
        """

        rows = None
        for _q in (query, _fallback_query):
            try:
                rows = list(_client().query(_q).result())
                break
            except GoogleAPIError as exc:
                log.warning("get_portfolio_catalog query falló, reintentando sin JOIN: %s", exc)

        if rows is None:
            raise BQInsertError("Error al consultar catálogo del portfolio: ambas queries fallaron")

        result: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r.items())
            _bucket_id = d.get("bucket_id") or ""
            _bname = (
                d.get("bucket_name")
                or _BUCKET_ID_TO_VERTICAL.get(_bucket_id, "")
                or _bucket_id
                or None
            )
            result.append({
                "company_id":   d.get("company_id", ""),
                "company_name": d.get("company_name", ""),
                "fund_id":      d.get("fund_id", ""),
                "bucket_id":    _bucket_id or None,
                "bucket_name":  _bname,
                "country":      d.get("country", None),
                "is_active":    True,
            })

        self._catalog_cache = result
        self._catalog_ts    = now
        log.info("get_portfolio_catalog: %d empresas cargadas (TTL %ss)", len(result), int(_CATALOG_TTL_SECONDS))
        return result

    def invalidate_catalog_cache(self) -> None:
        """
        Fuerza que la próxima llamada a get_portfolio_catalog() re-consulte BQ.
        Útil después de una operación de escritura que modifique dim_company.
        """
        self._catalog_cache = None
        self._catalog_ts    = 0.0

    # ── 5. get_kpi_metadata ───────────────────────────────────────────────────

    def get_kpi_metadata(
        self, *, vertical: Optional[str] = None
    ) -> list[dict[str, Any]]:
        """
        Retorna el catálogo de métricas desde dim_metric con shape
        retrocompatible con los callers de query_kpi_metadata().

        Mapping de campos:
          metric_id   → kpi_key
          metric_name → display_name
          category    → vertical
          is_core     → is_required

        Args:
            vertical: Si se pasa, filtra por category = 'GENERAL' OR category = vertical.
                      Si None, retorna todo el catálogo.

        Returns:
            Lista de dicts con claves: kpi_key, display_name, vertical,
            description, unit, is_required.
        """
        # Schema real de dim_metric (verificado vía BQ introspection):
        #   metric_id, metric_name_display, metric_name_std, metric_description,
        #   formula_text, unit_type, data_source, is_core, is_active
        query = f"""
            SELECT
                metric_id,
                metric_name_display,
                metric_description,
                unit_type,
                is_core
            FROM `{_DATASET}.dim_metric`
            WHERE is_active = TRUE
            ORDER BY is_core DESC, metric_id
        """

        try:
            rows = list(_client().query(query).result())
        except GoogleAPIError as exc:
            log.error("BQ error en get_kpi_metadata — query=%r error=%s", query, exc)
            raise BQInsertError(f"Error al consultar dim_metric: {exc}") from exc

        return [
            {
                "kpi_key":             r.metric_id,
                "display_name":        r.metric_name_display,
                "description":         r.metric_description,
                "unit":                r.unit_type,
                "vertical":            None,
                "is_required":         r.is_core,
                "min_historical_year": None,
                "example_value":       None,
            }
            for r in rows
        ]

    # ── 6. get_portfolio_analytics ────────────────────────────────────────────

    def get_portfolio_analytics(
        self,
        *,
        fund_id:    Optional[str] = None,
        company_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Analítica agregada de KPIs del portfolio desde fact_kpi_values + submissions.

        Pivota 6 KPIs core por (mes, empresa). Shape retrocompatible con
        query_portfolio_analytics() de db_writer para no romper el frontend.

        Args:
            fund_id:    Filtra por submissions.fund_id (equivalente al antiguo portfolio_id).
            company_id: Filtra por submissions.company_id.

        Returns:
            {
              "series":  [{month, company_id, portfolio_id, submission_count,
                           revenue_growth, gross_profit_margin, ebitda_margin,
                           cash_in_bank_end_of_year, annual_cash_flow, working_capital_debt}],
              "summary": {total_submissions, companies_count, companies, date_range}
            }
        """
        filters = ["1=1"]
        params: list[bigquery.ScalarQueryParameter] = []

        if fund_id:
            filters.append("fund_id = @fund_id")
            params.append(bigquery.ScalarQueryParameter("fund_id", "STRING", fund_id))
        if company_id:
            filters.append("LOWER(company_id) = LOWER(@company_id)")
            params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_id))

        where = " AND ".join(filters)

        query = f"""
            SELECT
                FORMAT_DATE('%Y-%m', fecha_periodo)                                              AS month,
                company_id,
                fund_id                                                                          AS portfolio_id,
                COUNT(DISTINCT submission_id)                                                    AS submission_count,
                AVG(CASE WHEN metric_name_std = 'revenue_growth'       THEN value END)          AS revenue_growth,
                AVG(CASE WHEN metric_name_std = 'gross_profit_margin'  THEN value END)          AS gross_profit_margin,
                AVG(CASE WHEN metric_name_std = 'ebitda_margin'        THEN value END)          AS ebitda_margin,
                AVG(CASE WHEN metric_name_std = 'cash'                 THEN value END)          AS cash_in_bank_end_of_year,
                AVG(CASE WHEN metric_name_std = 'annual_cash_flow'     THEN value END)          AS annual_cash_flow,
                AVG(CASE WHEN metric_name_std = 'working_capital_debt' THEN value END)          AS working_capital_debt
            FROM `{_DATASET}.Vista_valores_H`
            WHERE {where}
              AND value IS NOT NULL
            GROUP BY 1, 2, 3
            ORDER BY 1 ASC, 2 ASC
        """
        job_config = bigquery.QueryJobConfig(query_parameters=params)

        try:
            rows = list(_client().query(query, job_config=job_config).result())
        except GoogleAPIError as exc:
            log.error("BQ error en get_portfolio_analytics: %s", exc)
            raise BQInsertError(f"Error al consultar analytics: {exc}") from exc

        series = [
            {
                "month":                    r.month,
                "company_id":               r.company_id,
                "portfolio_id":             r.portfolio_id,
                "submission_count":         r.submission_count,
                "revenue_growth":           r.revenue_growth,
                "gross_profit_margin":      r.gross_profit_margin,
                "ebitda_margin":            r.ebitda_margin,
                "cash_in_bank_end_of_year": r.cash_in_bank_end_of_year,
                "annual_cash_flow":         r.annual_cash_flow,
                "working_capital_debt":     r.working_capital_debt,
            }
            for r in rows
        ]

        companies = sorted({r["company_id"] for r in series if r.get("company_id")})
        months    = [r["month"] for r in series if r.get("month")]

        return {
            "series": series,
            "summary": {
                "total_submissions": sum(r["submission_count"] for r in series),
                "companies_count":   len(companies),
                "companies":         companies,
                "date_range": {
                    "min": min(months) if months else None,
                    "max": max(months) if months else None,
                },
            },
        }

    # ── 7. get_rag_context ────────────────────────────────────────────────────

    def get_rag_context(
        self,
        *,
        company_id:   Optional[str] = None,
        fund_id:      Optional[str] = None,
        limit:        int = 400,
    ) -> list[dict[str, Any]]:
        """
        Extrae el contexto RAG desde la vista unificada v_rag_context_dev.

        La vista consolida datos históricos (fact_kpi_values) y cargas recientes
        en una sola tabla, marcando el origen con la columna ``fuente``.

        Columnas de la vista:
          company_id, company_name, metric_name, value, period_id, fuente

        Devuelve rows con shape compatible con build_rag_prompt():
          company_id, company_name, period_id, kpi_label, raw_value, fuente
          (más campos legacy con defaults para no romper callers existentes).

        Args:
            company_id: Filtra por empresa — acepta company_id exacto o
                        substring del company_name (multi-tenant isolation).
            fund_id:    Ignorado — la vista no expone fund_id. Reservado para
                        compatibilidad de firma con callers existentes.
            limit:      Número máximo de filas (default 400).

        Returns:
            Lista de dicts listos para pasar a build_rag_prompt().

        Raises:
            BQInsertError: Si ocurre un error de conectividad irrecuperable.
        """
        filters: list[str] = ["value IS NOT NULL"]
        params:  list[bigquery.ScalarQueryParameter] = []

        if company_id:
            filters.append(
                "(LOWER(company_id) = @company_id OR LOWER(company_name) LIKE @company_name)"
            )
            params.append(bigquery.ScalarQueryParameter("company_id",   "STRING", company_id.lower()))
            params.append(bigquery.ScalarQueryParameter("company_name", "STRING", f"%{company_id.lower()}%"))

        where_clause = "WHERE " + " AND ".join(filters)

        query = f"""
            SELECT
                company_id,
                company_name,
                metric_name,
                CAST(value AS STRING) AS raw_value,
                period_id,
                fuente
            FROM `{_DATASET}.v_rag_context_dev`
            {where_clause}
            ORDER BY period_id DESC, company_id, metric_name
            LIMIT {limit}
        """
        job_config = bigquery.QueryJobConfig(query_parameters=params)

        try:
            rows = list(_client().query(query, job_config=job_config).result())
        except GoogleAPIError as exc:
            log.error("BQ error en get_rag_context — query=%r error=%s", query, exc)
            raise BQInsertError(f"Error al consultar contexto RAG: {exc}") from exc

        empresas = list({r.company_name for r in rows if r.company_name})
        log.info("[RAG] Empresas en contexto: %s — total filas: %d", empresas, len(rows))

        return [
            {
                "company_id":        r.company_id,
                "company_name":      r.company_name,
                "kpi_label":         r.metric_name,   # alias esperado por build_rag_prompt
                "raw_value":         r.raw_value,
                "period_id":         r.period_id,
                "fuente":            r.fuente,
                # Campos legacy — defaults para no romper callers y resolve_context_conflicts
                "portfolio_id":      None,
                "unit":              "",
                "is_manually_edited": False,
                "analyst_note":      None,
            }
            for r in rows
        ]

    # ── 8. update_submission_status ───────────────────────────────────────────

    def update_submission_status(
        self,
        *,
        submission_id: str,
        status:        str,
        review_notes:  Optional[str] = None,
    ) -> None:
        """
        Actualiza el campo status (y opcionalmente review_notes) de una submission.

        Usa DML UPDATE — el único punto de escritura para cambios de estado.
        Raise BQInsertError si la query falla; sin excepción = éxito.

        Args:
            submission_id: ID canónico de la submission (ej. "S1A2B3").
            status:        Nuevo estado: "PENDING" | "VALIDATED" | "REJECTED".
            review_notes:  Comentario del analista (opcional, se sobreescribe si se pasa).
        """
        notes_val = review_notes if review_notes is not None else ""
        params = [
            bigquery.ScalarQueryParameter("submission_id", "STRING", submission_id),
            bigquery.ScalarQueryParameter("status",        "STRING", status),
            bigquery.ScalarQueryParameter("review_notes",  "STRING", notes_val),
        ]
        query = f"""
            UPDATE `{_DATASET}.submissions`
            SET
                status       = @status,
                review_notes = CASE
                    WHEN @review_notes = '' THEN review_notes
                    ELSE @review_notes
                END
            WHERE submission_id = @submission_id
        """
        job_config = bigquery.QueryJobConfig(query_parameters=params)

        try:
            job = _client().query(query, job_config=job_config)
            job.result()
            log.info("Submission %s → status='%s'", submission_id, status)
        except GoogleAPIError as exc:
            log.error("BQ error en update_submission_status(%s): %s", submission_id, exc)
            raise BQInsertError(
                f"Error actualizando submission {submission_id}: {exc}"
            ) from exc

    # ── 9. update_single_kpi ─────────────────────────────────────────────────

    def update_single_kpi(
        self,
        *,
        submission_id: str,
        metric_id:     str,
        new_value:     float | None,
        value_notes:   Optional[str] = None,
    ) -> None:
        """
        Corrige el valor de un KPI en la tabla H.

        Hace un DML UPDATE sobre la fila identificada por (submission_id, metric_id).
        Si la fila no existe, lanza ValueError para que el endpoint devuelva 404.

        Args:
            submission_id: ID de la submission (ej. "S1A2B3").
            metric_id:     Clave del KPI (ej. "revenue_growth").
            new_value:     Nuevo valor numérico. None limpia el campo.
            value_notes:   Nota del analista (opcional; si None, no se sobreescribe).

        Raises:
            ValueError:    Si la fila no existe en H.
            BQInsertError: Si el UPDATE falla por error de conectividad.
        """
        # Verificar que la fila existe antes de actualizar
        check_sql = f"""
            SELECT submission_id
            FROM `{_DATASET}.H`
            WHERE submission_id = @submission_id
              AND metric_id     = @metric_id
            LIMIT 1
        """
        check_cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("submission_id", "STRING", submission_id),
            bigquery.ScalarQueryParameter("metric_id",     "STRING", metric_id),
        ])
        try:
            rows = list(_client().query(check_sql, job_config=check_cfg).result())
        except GoogleAPIError as exc:
            raise BQInsertError(f"Error verificando fila: {exc}") from exc

        if not rows:
            raise ValueError(
                f"KPI '{metric_id}' no encontrado para submission '{submission_id}'"
            )

        # UPDATE — notes_clause solo sobreescribe si se pasó un valor explícito
        notes_clause = (
            ", notes = @value_notes" if value_notes is not None else ""
        )
        params: list[bigquery.ScalarQueryParameter] = [
            bigquery.ScalarQueryParameter("submission_id", "STRING", submission_id),
            bigquery.ScalarQueryParameter("metric_id",     "STRING", metric_id),
            bigquery.ScalarQueryParameter("value",         "FLOAT64", new_value),
        ]
        if value_notes is not None:
            params.append(
                bigquery.ScalarQueryParameter("value_notes", "STRING", value_notes)
            )

        update_sql = f"""
            UPDATE `{_DATASET}.H`
            SET
                value      = @value,
                created_at = CURRENT_TIMESTAMP(){notes_clause}
            WHERE submission_id = @submission_id
              AND metric_id     = @metric_id
        """
        job_config = bigquery.QueryJobConfig(query_parameters=params)
        try:
            job = _client().query(update_sql, job_config=job_config)
            job.result()
            log.info(
                "update_single_kpi: submission=%r metric=%r → %s",
                submission_id, metric_id, new_value,
            )
        except GoogleAPIError as exc:
            log.error("BQ error en update_single_kpi(%s, %s): %s", submission_id, metric_id, exc)
            raise BQInsertError(f"Error actualizando KPI: {exc}") from exc

    # ── 10. insert_to_staging ─────────────────────────────────────────────────

    def insert_to_staging(
        self,
        *,
        staging_id:   str,
        company_id:   str,
        period_id:    str,
        period_start: date,
        submitted_by: str,
        source_file:  str,
        kpi_rows:     list[dict[str, Any]],
        physics_ok:   bool = True,
        physics_notes: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Persiste KPIs extraídos por Document AI en fact_kpi_staging con
        status='PENDING'. Los datos NO son visibles para el RAG hasta que
        un analista los valide con promote_staging_to_fact().

        Args:
            staging_id:    UUID del batch (de kpi_dispatcher.load_id).
            company_id:    FK a dim_company.
            period_id:     FK a dim_period (ej. "P2026Q1M01").
            period_start:  Fecha de inicio del período — clave de partición.
            submitted_by:  Email del founder.
            source_file:   GCS URI del archivo original (gs://...).
            kpi_rows:      Lista de dicts con metric_id, value.
            physics_ok:    False si validate_financial_physics detectó violaciones.
            physics_notes: JSON serializado de las violations (opcional).

        Returns:
            Dict con staging_id, rows_inserted, status='PENDING'.

        Raises:
            BQInsertError: Si la inserción falla.
        """
        now = datetime.now(tz=timezone.utc)
        now_ts = int(now.timestamp())   # BQ INTEGER — Unix timestamp en segundos
        # Garantizar que los IDs sean strings puros — nunca uuid.UUID / bytes
        staging_id  = str(staging_id)
        company_id  = str(company_id)
        period_id   = str(period_id)
        submitted_by = str(submitted_by) if submitted_by else ""
        source_file  = str(source_file)  if source_file  else ""

        # ── Upsert: borrar datos previos del mismo año antes de insertar ──────
        year = period_start.year
        self._delete_staging_for_company_years(company_id, {year})

        # period_start como string YYYY-MM-DD — BQ DATE espera exactamente ese formato
        ps_str = period_start.strftime("%Y-%m-%d") if hasattr(period_start, "strftime") else str(period_start)[:10]

        records = [
            {
                "staging_id":    staging_id,
                "company_id":    company_id,
                "metric_id":     str(row["metric_id"]),
                "value":         row.get("value"),
                "period_id":     period_id,
                "period_start":  ps_str,
                "source_file":   source_file,
                "submitted_by":  submitted_by,
                "submitted_at":  now_ts,
                "status":        "PENDING",
                "scenario":      "ACTUAL",
                "physics_ok":    physics_ok,
                "physics_notes": str(physics_notes) if physics_notes else None,
                "validated_by":  None,
                "validated_at":  None,
                "rejection_note": None,
            }
            for row in kpi_rows
            if row.get("value") is not None and row.get("metric_id") is not None
        ]

        if not records:
            return {"staging_id": staging_id, "rows_inserted": 0, "status": "PENDING"}

        try:
            self._insert_rows_json_safe(records, "fact_kpi_staging")
            log.info(
                "insert_to_staging: %d KPI(s) en PENDING para staging_id=%s empresa=%s",
                len(records), staging_id, company_id,
            )
        except Exception as exc:
            raise BQInsertError(
                f"Fallo al insertar en fact_kpi_staging (staging_id={staging_id}): {exc}"
            ) from exc

        return {"staging_id": staging_id, "rows_inserted": len(records), "status": "PENDING"}

    # ── 10b. insert_to_staging_multiperiod ────────────────────────────────────

    def insert_to_staging_multiperiod(
        self,
        *,
        staging_id:    str,
        company_id:    str,
        submitted_by:  str,
        source_file:   str,
        staging_rows:  list[dict],
        physics_ok:    bool = True,
        physics_notes: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Persiste lotes multi-período en fact_kpi_staging con status='PENDING'.

        Diferencia con insert_to_staging(): cada fila lleva su propio period_id,
        permitiendo ingestar un Excel Master Database completo (N meses × M KPIs)
        en una sola llamada con un único staging_id de referencia para el analista.

        Args:
            staging_id:    Identificador del batch (ej. "STG1A2B3C4D").
            company_id:    FK a dim_company.
            submitted_by:  Email del founder que subió el archivo.
            source_file:   Nombre o URI del archivo fuente.
            staging_rows:  Resultado de extract_master_db_to_staging_rows().
                           Cada dict debe tener: metric_id, period_id, value.
            physics_ok:    False si se detectaron violaciones físicas previas.
            physics_notes: JSON de violations (opcional).

        Returns:
            Dict con staging_id, rows_inserted, status, periods y timestamp.

        Raises:
            BQInsertError: Si la inserción en fact_kpi_staging falla.
        """
        now = datetime.now(tz=timezone.utc)
        now_ts = int(now.timestamp())   # BQ INTEGER — Unix timestamp en segundos
        # Garantizar que los IDs sean strings puros — nunca uuid.UUID / bytes
        staging_id   = str(staging_id)
        company_id   = str(company_id)
        submitted_by = str(submitted_by) if submitted_by else ""
        source_file  = str(source_file)  if source_file  else ""

        # ── Upsert: extraer años únicos del lote y borrar previos ─────────────
        years_in_batch: set[int] = set()
        for row in staging_rows:
            if row.get("value") is not None and row.get("period_id"):
                years_in_batch.add(_period_id_to_date(row["period_id"]).year)
        if years_in_batch:
            self._delete_staging_for_company_years(company_id, years_in_batch)

        records = [
            {
                "staging_id":     staging_id,
                "company_id":     company_id,
                "metric_id":      str(row["metric_id"]),
                "value":          row.get("value"),
                "period_id":      str(row["period_id"]),
                "period_start":   _period_id_to_date(str(row["period_id"])).strftime("%Y-%m-%d"),
                "source_file":    source_file,
                "submitted_by":   submitted_by,
                "submitted_at":   now_ts,
                "status":         "PENDING",
                "scenario":       "ACTUAL",
                "physics_ok":     physics_ok,
                "physics_notes":  str(physics_notes) if physics_notes else None,
                "validated_by":   None,
                "validated_at":   None,
                "rejection_note": None,
            }
            for row in staging_rows
            if row.get("value") is not None and row.get("metric_id") is not None
        ]

        if not records:
            return {
                "staging_id":    staging_id,
                "rows_inserted": 0,
                "status":        "PENDING",
                "periods":       [],
                "timestamp":     now.isoformat(),
            }

        try:
            self._insert_rows_json_safe(records, "fact_kpi_staging")
            unique_periods = sorted({r["period_id"] for r in records})
            log.info(
                "insert_to_staging_multiperiod: %d KPI(s) PENDING staging_id=%s empresa=%s períodos=%s",
                len(records), staging_id, company_id, unique_periods,
            )
        except Exception as exc:
            raise BQInsertError(
                f"Fallo al insertar en fact_kpi_staging (staging_id={staging_id}): {exc}"
            ) from exc

        return {
            "staging_id":    staging_id,
            "rows_inserted": len(records),
            "status":        "PENDING",
            "periods":       sorted({r["period_id"] for r in records}),
            "timestamp":     now.isoformat(),
        }

    # ── 11. get_staging_pending ───────────────────────────────────────────────

    def get_staging_pending(
        self,
        *,
        company_id: Optional[str] = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """
        Retorna los KPIs en fact_kpi_staging con status='PENDING'.

        Usado por el panel del analista para mostrar la cola de revisión.
        Agrupa por staging_id para que el analista apruebe o rechace batches
        completos (una carga de archivo = un staging_id).

        Args:
            company_id: Filtra por empresa (opcional).
            limit:      Máximo de filas (default 200).

        Returns:
            Lista de dicts con todos los campos de fact_kpi_staging.
        """
        filters = ["status = 'PENDING'"]
        params: list[bigquery.ScalarQueryParameter] = []

        if company_id:
            filters.append("LOWER(company_id) = @company_id")
            params.append(bigquery.ScalarQueryParameter("company_id", "STRING", company_id.lower()))

        where = "WHERE " + " AND ".join(filters)

        query = f"""
            SELECT
                staging_id,
                company_id,
                metric_id,
                value,
                period_id,
                period_start,
                source_file,
                submitted_by,
                submitted_at,
                status,
                physics_ok,
                physics_notes
            FROM `{_DATASET}.fact_kpi_staging`
            {where}
            ORDER BY submitted_at DESC, staging_id, metric_id
            LIMIT {limit}
        """
        job_config = bigquery.QueryJobConfig(query_parameters=params)

        try:
            rows = list(_client().query(query, job_config=job_config).result())
        except GoogleAPIError as exc:
            log.error("BQ error en get_staging_pending: %s", exc)
            raise BQInsertError(f"Error al consultar staging: {exc}") from exc

        return [dict(r) for r in rows]

    # ── 12. promote_staging_to_fact ───────────────────────────────────────────

    def promote_staging_to_fact(
        self,
        *,
        staging_id:   str,
        validated_by: str,
        action:       str,       # "VALIDATED" | "REJECTED"
        rejection_note: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Human-in-the-loop gate: promueve un batch de staging a fact_kpi_values
        o lo rechaza. Esta es la única puerta de entrada al RAG/Chat.

        Flujo cuando action='VALIDATED':
          1. Lee las filas del staging_id de fact_kpi_staging.
          2. Inserta en fact_kpi_values (con submission_id = staging_id).
          3. Actualiza status → 'VALIDATED' en fact_kpi_staging.

        Flujo cuando action='REJECTED':
          1. Actualiza status → 'REJECTED' en fact_kpi_staging.
          2. No escribe nada en fact_kpi_values.

        La vista v_rag_context_dev lee de fact_kpi_values — por diseño
        NUNCA lee de fact_kpi_staging, garantizando que el chat solo
        ve datos aprobados por un analista.

        Args:
            staging_id:     UUID del batch a promover (de insert_to_staging).
            validated_by:   Email del analista que ejecuta la acción.
            action:         "VALIDATED" → promover; "REJECTED" → rechazar.
            rejection_note: Motivo del rechazo (obligatorio si action='REJECTED').

        Returns:
            Dict con staging_id, action, rows_promoted y timestamp.

        Raises:
            ValueError:    Si staging_id no existe o ya fue procesado.
            BQInsertError: Si cualquier escritura en BQ falla.
        """
        if action not in ("VALIDATED", "REJECTED"):
            raise ValueError(f"action debe ser 'VALIDATED' o 'REJECTED', got: {action!r}")

        # ── Leer filas pendientes del batch ───────────────────────────────────
        check_query = f"""
            SELECT
                staging_id, company_id, metric_id, value,
                period_id, period_start, submitted_by, status
            FROM `{_DATASET}.fact_kpi_staging`
            WHERE staging_id = @staging_id
        """
        check_cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("staging_id", "STRING", staging_id)
        ])
        try:
            rows = list(_client().query(check_query, job_config=check_cfg).result())
        except GoogleAPIError as exc:
            raise BQInsertError(f"Error leyendo staging_id={staging_id}: {exc}") from exc

        if not rows:
            raise ValueError(f"staging_id '{staging_id}' no encontrado en fact_kpi_staging")

        current_status = rows[0]["status"]
        if current_status != "PENDING":
            raise ValueError(
                f"staging_id '{staging_id}' ya fue procesado (status='{current_status}'). "
                "No se puede volver a validar o rechazar."
            )

        now = datetime.now(tz=timezone.utc)
        rows_promoted = 0

        # ── Si VALIDATED: promover a fact_kpi_values ──────────────────────────
        if action == "VALIDATED":
            first = rows[0]
            # Crear submission en la tabla de submissions primero
            df_sub = pd.DataFrame([{
                "submission_id": staging_id,
                "company_id":    first["company_id"],
                "fund_id":       None,
                "period_id":     first["period_id"],
                "submitted_by":  first["submitted_by"],
                "submitted_at":  now,
                "status":        "VALIDATED",
                "source_file":   None,
                "review_notes":  f"Validado por {validated_by}",
            }])
            try:
                self._append_dataframe(df_sub, "submissions")
            except Exception as exc:
                raise BQInsertError(
                    f"Fallo al crear submission en promote_staging ({staging_id}): {exc}"
                ) from exc

            # Insertar los KPIs en H (tabla unificada)
            first_fund = first.get("fund_id") or None
            kpi_records = [
                {
                    "submission_id": staging_id,
                    "company_id":    r["company_id"],
                    "fund_id":       first_fund,
                    "bucket_id":     None,   # enriquecido por Vista_valores_H via dim_metric
                    "period_id":     r["period_id"],
                    "period_start":  r["period_start"],
                    "metric_id":     r["metric_id"],
                    "value":         r["value"],
                    "notes":         f"Validado por {validated_by}",
                    "value_status":  "VALIDATED",
                    "created_at":    now,
                }
                for r in rows
                if r.get("value") is not None
            ]
            if kpi_records:
                df_facts = pd.DataFrame(kpi_records)
                try:
                    self._append_dataframe(df_facts, "H")
                    rows_promoted = len(kpi_records)
                    log.info(
                        "promote_staging_to_fact: %d KPI(s) promovidos a H — staging_id=%s by %s",
                        rows_promoted, staging_id, validated_by,
                    )
                except Exception as exc:
                    raise BQInsertError(
                        f"Fallo al insertar KPIs en H (staging_id={staging_id}): {exc}"
                    ) from exc

        # ── Actualizar status en fact_kpi_staging ─────────────────────────────
        note_val = rejection_note or ""
        update_params = [
            bigquery.ScalarQueryParameter("staging_id",    "STRING",    staging_id),
            bigquery.ScalarQueryParameter("status",        "STRING",    action),
            bigquery.ScalarQueryParameter("validated_by",  "STRING",    validated_by),
            bigquery.ScalarQueryParameter("validated_at",  "TIMESTAMP", now.isoformat()),
            bigquery.ScalarQueryParameter("rejection_note","STRING",    note_val),
        ]
        update_query = f"""
            UPDATE `{_DATASET}.fact_kpi_staging`
            SET
                status         = @status,
                validated_by   = @validated_by,
                validated_at   = @validated_at,
                rejection_note = CASE
                    WHEN @rejection_note = '' THEN rejection_note
                    ELSE @rejection_note
                END
            WHERE staging_id = @staging_id
        """
        try:
            job = _client().query(
                update_query,
                job_config=bigquery.QueryJobConfig(query_parameters=update_params),
            )
            job.result()
        except GoogleAPIError as exc:
            log.error(
                "BQ error actualizando staging status (staging_id=%s): %s", staging_id, exc
            )
            raise BQInsertError(f"Error actualizando staging: {exc}") from exc

        return {
            "staging_id":    staging_id,
            "action":        action,
            "rows_promoted": rows_promoted,
            "validated_by":  validated_by,
            "timestamp":     now.isoformat(),
        }

    # ── Helper de limpieza — upsert semántico ─────────────────────────────────

    # ── 13. get_portfolio_coverage ───────────────────────────────────────────

    def get_portfolio_coverage(
        self,
        *,
        fund_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Retorna la matriz de cobertura del portafolio: empresas × períodos × estado.

        Estado de cada celda:
          verified → KPIs promovidos a fact_kpi_values (validados por analista).
          legacy   → KPIs en fact_kpi_staging con status='PENDING' (en cola).
          missing  → empresa que reportó alguna vez pero sin datos en el período
                     más reciente.

        Args:
            fund_id: Filtra por fondo (fund_id en dim_company / submissions).
                     Si None, devuelve todas las empresas.

        Returns:
            {
                "status":    "ok",
                "companies": [{"key": str, "display": str, "portfolio_id": str}],
                "periods":   [str],   # P2025Q1M01 … ordenados cronológicamente
                "cells":     [
                    {
                        "company":        str,
                        "period":         str,
                        "status":         "verified" | "legacy" | "missing",
                        "kpi_count":      int,
                        "verified_count": int,
                        "legacy_count":   int,
                    }
                ]
            }

        Raises:
            BQInsertError: Si la consulta a dim_company falla (error fatal).
            Las consultas a fact_kpi_values y fact_kpi_staging son no-fatales:
            si fallan, se devuelve cobertura parcial en lugar de un 500.
        """
        _log = log

        # ── 1. Empresas del portfolio ──────────────────────────────────────────
        co_filters = ["1=1"]
        co_params: list[bigquery.ScalarQueryParameter] = []
        if fund_id:
            co_filters.append("fund_id = @fund_id_co")
            co_params.append(bigquery.ScalarQueryParameter("fund_id_co", "STRING", fund_id))

        co_query = f"""
            SELECT company_id, company_name, fund_id
            FROM `{_DATASET}.dim_company`
            WHERE {' AND '.join(co_filters)}
            ORDER BY company_name
        """
        co_cfg = bigquery.QueryJobConfig(query_parameters=co_params) if co_params else None
        try:
            co_rows = list(_client().query(co_query, job_config=co_cfg).result())
        except GoogleAPIError as exc:
            _log.error("get_portfolio_coverage: error en dim_company — %s", exc)
            raise BQInsertError(f"Error al consultar empresas del portfolio: {exc}") from exc

        if not co_rows:
            return {"status": "ok", "companies": [], "periods": [], "cells": []}

        companies = [
            {
                "key":          str(r.company_id),
                "display":      str(r.company_name),
                "portfolio_id": str(r.fund_id or ""),
            }
            for r in co_rows
        ]
        company_ids: set[str] = {c["key"] for c in companies}

        # ── 2 + 3. KPIs desde Vista_valores_H (unifica verified + staging) ───────
        cov_filters = ["company_id IS NOT NULL", "period_id IS NOT NULL"]
        cov_params: list[bigquery.ScalarQueryParameter] = []
        if fund_id:
            cov_filters.append("fund_id = @fund_id_v")
            cov_params.append(bigquery.ScalarQueryParameter("fund_id_v", "STRING", fund_id))

        cov_query = f"""
            SELECT
                company_id,
                period_id,
                value_status,
                COUNT(DISTINCT metric_name_std) AS kpi_count
            FROM `{_DATASET}.Vista_valores_H`
            WHERE {' AND '.join(cov_filters)}
            GROUP BY company_id, period_id, value_status
        """
        cov_cfg = bigquery.QueryJobConfig(query_parameters=cov_params) if cov_params else None
        try:
            cov_rows = list(_client().query(cov_query, job_config=cov_cfg).result())
        except GoogleAPIError as exc:
            _log.error("get_portfolio_coverage: error en Vista_valores_H — %s", exc)
            cov_rows = []  # no-fatal

        # Agregar filas de Vista_valores_H a verified / staging según value_status
        _VALIDATED = {"VERIFIED", "VALIDATED", "verified", "validated"}
        verified: dict[tuple[str, str], int] = {}
        staging:  dict[tuple[str, str], int] = {}
        for r in cov_rows:
            key = (str(r.company_id), str(r.period_id))
            count = int(r.kpi_count or 0)
            if str(r.value_status) in _VALIDATED:
                verified[key] = verified.get(key, 0) + count
            else:
                staging[key] = staging.get(key, 0) + count

        # ── 4. Construir períodos y celdas ────────────────────────────────────
        all_periods: set[str] = set()
        for (_, period) in verified:
            all_periods.add(period)
        for (_, period) in staging:
            all_periods.add(period)

        periods_sorted: list[str] = sorted(all_periods)
        cells: list[dict[str, Any]] = []
        companies_with_data: set[str] = set()

        # Celdas verificadas
        for (co_id, period), v_count in verified.items():
            if co_id not in company_ids:
                continue
            companies_with_data.add(co_id)
            s_count = staging.get((co_id, period), 0)
            cells.append({
                "company":        co_id,
                "period":         period,
                "status":         "verified",
                "kpi_count":      v_count + s_count,
                "verified_count": v_count,
                "legacy_count":   s_count,
            })

        # Celdas solo-staging (no promovidas aún)
        for (co_id, period), s_count in staging.items():
            if co_id not in company_ids:
                continue
            if (co_id, period) in verified:
                continue  # ya incluida arriba
            companies_with_data.add(co_id)
            cells.append({
                "company":        co_id,
                "period":         period,
                "status":         "legacy",
                "kpi_count":      s_count,
                "verified_count": 0,
                "legacy_count":   s_count,
            })

        # Celdas "missing" — empresa activa sin datos en el período más reciente
        if periods_sorted:
            latest = periods_sorted[-1]
            in_latest: set[str] = {c["company"] for c in cells if c["period"] == latest}
            for co_id in companies_with_data:
                if co_id not in in_latest:
                    cells.append({
                        "company":        co_id,
                        "period":         latest,
                        "status":         "missing",
                        "kpi_count":      0,
                        "verified_count": 0,
                        "legacy_count":   0,
                    })

        _log.info(
            "get_portfolio_coverage: %d empresas · %d períodos · %d celdas",
            len(companies), len(periods_sorted), len(cells),
        )
        return {
            "status":    "ok",
            "companies": companies,
            "periods":   periods_sorted,
            "cells":     cells,
        }

    def _delete_staging_for_company_years(
        self, company_id: str, years: set[int]
    ) -> int:
        """
        Elimina de fact_kpi_staging todos los registros PENDING de una empresa
        para los años indicados, antes de insertar datos nuevos.

        Estrategia upsert:
          DELETE donde company_id = X AND EXTRACT(YEAR FROM period_start) IN (años)
          AND status IN ('PENDING', 'REJECTED')

        Solo se borran registros PENDING o REJECTED — los VALIDATED permanecen
        intactos para preservar el historial auditado.

        Returns:
            Número estimado de filas eliminadas (puede ser 0 si no había datos previos).
        """
        if not years:
            return 0

        year_list = ", ".join(str(y) for y in sorted(years))
        dml = f"""
            DELETE FROM `{_DATASET}.fact_kpi_staging`
            WHERE company_id = @company_id
              AND EXTRACT(YEAR FROM period_start) IN ({year_list})
              AND status IN ('PENDING', 'REJECTED')
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("company_id", "STRING", company_id),
            ]
        )
        try:
            job = _client().query(dml, job_config=job_config)
            job.result()  # esperar a que termine
            deleted = job.num_dml_affected_rows or 0
            log.info(
                "_delete_staging: %d filas eliminadas para company=%s años=%s",
                deleted, company_id, year_list,
            )
            return deleted
        except Exception as exc:
            # No bloquear la carga si el DELETE falla — solo advertir
            log.warning(
                "_delete_staging: DELETE no-fatal para company=%s años=%s: %s",
                company_id, year_list, exc,
            )
            return 0

    # ── Helper de insert sin pyarrow (streaming JSON) ────────────────────────

    def _insert_rows_json_safe(self, records: list[dict[str, Any]], table_name: str) -> None:
        """
        Inserta filas en BigQuery usando la API de streaming (insert_rows_json).

        Ventaja clave: NO usa pyarrow ni parquet, por lo que elimina todos los
        errores de tipo "Got bytestring of length N (expected M)".

        Restricciones del streaming API:
          - Máximo 10 MB por llamada y 1 000 filas por llamada.
          - Los datos son visibles para SELECT de forma casi inmediata.
          - Los DELETE/UPDATE en el streaming buffer pueden tardar ~1 min en
            reflejarse (suficiente para el upsert que ejecuta DELETE primero).

        Los valores se convierten a tipos JSON-seguros antes de enviar:
          datetime / pd.Timestamp → ISO string
          date                    → "YYYY-MM-DD"
          None / float('nan')     → None (omitido por BQ → NULL)
          bool                    → bool
          int / float             → número
          todo lo demás           → str()
        """
        destination = f"{_DATASET}.{table_name}"
        table_ref   = _client().get_table(destination)
        known_cols  = {f.name for f in table_ref.schema}
        # Mapa col → tipo BQ para formatear fechas correctamente
        col_type    = {f.name: f.field_type for f in table_ref.schema}

        def _to_json(col: str, v: Any) -> Any:
            """Convierte v al tipo que BQ espera para la columna col."""
            if v is None:
                return None
            # NaN numérico
            if isinstance(v, float) and (v != v):
                return None
            # Bytes — nunca enviar como bytes raw
            if isinstance(v, (bytes, bytearray)):
                return None
            bq_type = col_type.get(col, "")
            # Columnas DATE → solo YYYY-MM-DD (sin hora, sin zona horaria)
            if bq_type == "DATE":
                if isinstance(v, pd.Timestamp):
                    return None if pd.isnull(v) else v.strftime("%Y-%m-%d")
                if isinstance(v, (datetime, date)):
                    return v.strftime("%Y-%m-%d")
                # String que ya tiene hora → tomar solo los primeros 10 chars
                s = str(v)
                return s[:10] if len(s) >= 10 else s
            # Columnas TIMESTAMP / DATETIME → ISO completo
            if bq_type in ("TIMESTAMP", "DATETIME"):
                if isinstance(v, pd.Timestamp):
                    return None if pd.isnull(v) else v.isoformat()
                if isinstance(v, (datetime, date)):
                    return v.isoformat()
                return str(v)
            # Columnas INTEGER — si llega un datetime, convertir a Unix timestamp
            if bq_type == "INTEGER":
                if isinstance(v, pd.Timestamp):
                    return None if pd.isnull(v) else int(v.timestamp())
                if isinstance(v, datetime):
                    return int(v.timestamp())
                if isinstance(v, bool):
                    return int(v)
                if isinstance(v, (int, float)):
                    return int(v)
                return None
            # Columnas STRING → str() obligatorio (elimina uuid.UUID, bytes, etc.)
            if bq_type == "STRING" or col in _STRING_ID_COLS:
                if isinstance(v, bool):   # bool antes de int (bool es subclase de int)
                    return str(v)
                return str(v)
            # Booleanos
            if isinstance(v, bool):
                return v
            # Numéricos
            if isinstance(v, (int, float)):
                return v
            # Timestamps sin tipo BQ conocido → str seguro
            if isinstance(v, pd.Timestamp):
                return None if pd.isnull(v) else v.isoformat()
            if isinstance(v, (datetime, date)):
                return v.isoformat()
            return str(v)

        safe_rows: list[dict[str, Any]] = []
        skipped = 0
        for row in records:
            # Guard: saltar filas sin identificadores mínimos
            mid = row.get("metric_id") or row.get("submission_id") or row.get("staging_id")
            if not mid or str(mid).strip() in ("", "nan", "None"):
                skipped += 1
                continue
            safe_row: dict[str, Any] = {}
            for k, v in row.items():
                if k not in known_cols:
                    continue
                converted = _to_json(k, v)
                if converted is not None:
                    safe_row[k] = converted
            safe_rows.append(safe_row)
        if skipped:
            log.warning("_insert_rows_json_safe: %d filas ignoradas en %s", skipped, table_name)

        # Enviar en lotes de 500 para estar bajo el límite de 10 MB
        batch_size = 500
        for i in range(0, len(safe_rows), batch_size):
            batch  = safe_rows[i : i + batch_size]
            errors = _client().insert_rows_json(table_ref, batch)
            if errors:
                raise BQInsertError(
                    f"Streaming insert errors en {table_name}: {errors[:3]}"
                )

    # ── Helper interno ────────────────────────────────────────────────────────

    def _append_dataframe(self, df: pd.DataFrame, table_name: str) -> None:
        """
        Escribe un DataFrame en BigQuery con WRITE_APPEND.

        Si la tabla tiene un schema estricto (autodetect=False) y el DataFrame
        contiene columnas no presentes en la tabla (ej. 'scenario' antes de
        una migración), el job fallará y se reintenta eliminando las columnas
        extra automáticamente.

        Args:
            df:         DataFrame a insertar.
            table_name: Nombre de la tabla (sin dataset prefix).

        Raises:
            Exception: re-levanta cualquier error de BQ para que el llamador decida.
        """
        # Garantizar tipos correctos antes de serializar a parquet
        df = _sanitize_df(df)

        destination = f"{_DATASET}.{table_name}"
        job_config  = bigquery.LoadJobConfig(
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
            autodetect=False,
        )
        try:
            job = _client().load_table_from_dataframe(df, destination, job_config=job_config)
            job.result()
        except Exception as first_exc:
            # Si el error parece ser por columnas desconocidas, obtener el schema
            # real de la tabla y reintentar solo con las columnas que existen.
            err_str = str(first_exc).lower()
            if "no such field" in err_str or "unknown" in err_str or "schema" in err_str:
                try:
                    table_ref = _client().get_table(destination)
                    known_cols = {f.name for f in table_ref.schema}
                    extra_cols = [c for c in df.columns if c not in known_cols]
                    if extra_cols:
                        log.warning(
                            "_append_dataframe: columnas %s no existen en %s — reintentando sin ellas",
                            extra_cols, table_name,
                        )
                        df_slim = df.drop(columns=extra_cols)
                        job2 = _client().load_table_from_dataframe(df_slim, destination, job_config=job_config)
                        job2.result()
                        return
                except Exception:
                    pass  # si el retry falla, levanta el error original
            raise
