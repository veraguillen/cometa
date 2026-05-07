"""
bq_service.py
─────────────
Capa de acceso a datos contra BD_Cometa_Dev.

Responsabilidades únicas y acotadas:
  1. get_company_context()   → valida empresa y resuelve sector desde BQ.
  2. save_submission()       → escribe submissions + fact_kpi_values en BQ.

Diseño:
  - Fail-safe en importación: si _DATASET no termina en '_Dev', el módulo no carga.
  - Cliente singleton: una sola conexión BQ por proceso (thread-safe).
  - Cero diccionarios hardcodeados: todo se resuelve vía SQL dinámico.
  - Errores de dominio (CompanyNotFoundError) capturables como HTTPException en FastAPI.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime, timezone
from typing import Any, Optional

import pandas as pd
from google.api_core.exceptions import GoogleAPIError
from google.cloud import bigquery
from google.oauth2 import service_account

log = logging.getLogger(__name__)

# ── Dataset — fuente única de verdad ──────────────────────────────────────────
_DATASET = "cometa-mvp.BD_Cometa_Dev"

# Fail-safe: imposible apuntar a producción por error de configuración
if not _DATASET.endswith("_Dev"):
    raise RuntimeError(
        f"bq_service apuntando a dataset no-Dev: '{_DATASET}'. "
        "El sufijo '_Dev' es obligatorio en este módulo."
    )


# ── Excepción de dominio ──────────────────────────────────────────────────────

class CompanyNotFoundError(ValueError):
    """
    Empresa no encontrada en dim_company.
    Hereda de ValueError para que FastAPI la convierta en 404 con un solo
    bloque except en el router:
        except CompanyNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
    """
    def __init__(self, company_id: str) -> None:
        self.company_id = company_id
        super().__init__(
            f"Empresa '{company_id}' no encontrada en {_DATASET}.dim_company. "
            "Verifica que el company_id sea válido (formato: C001)."
        )


# ── Cliente singleton ─────────────────────────────────────────────────────────

_CLIENT: Optional[bigquery.Client] = None


def _get_client() -> bigquery.Client:
    """Singleton de cliente BQ. Inicializa en primer uso."""
    global _CLIENT
    if _CLIENT is None:
        key_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "cometa_key.json")
        if os.path.isfile(key_path):
            creds   = service_account.Credentials.from_service_account_file(key_path)
            _CLIENT = bigquery.Client(credentials=creds, project=creds.project_id)
            log.info("BQService: cliente inicializado con service account '%s'", key_path)
        else:
            # Application Default Credentials (Cloud Run / GKE)
            _CLIENT = bigquery.Client()
            log.info("BQService: cliente inicializado con Application Default Credentials")
    return _CLIENT


# ══════════════════════════════════════════════════════════════════════════════
# BQService
# ══════════════════════════════════════════════════════════════════════════════

class BQService:
    """
    Servicio de acceso a datos para BD_Cometa_Dev.

    Instanciar una vez a nivel de módulo en el router:
        bq = BQService()

    Todos los métodos son síncronos; en FastAPI async usar run_in_executor
    si se requiere no bloquear el event loop bajo alta carga.
    """

    # ── 1. get_company_context ────────────────────────────────────────────────

    def get_company_context(self, company_id: str) -> dict[str, Any]:
        """
        Valida que la empresa existe y resuelve su sector (bucket) dinámicamente.

        El sector se obtiene mediante JOIN con dim_bucket — nunca desde un
        diccionario hardcodeado en Python.

        Args:
            company_id: Identificador de empresa, ej. "C001".

        Returns:
            {
                "company_id":   "C001",
                "company_name": "DataFlow SaaS",
                "fund_id":      "F001",
                "bucket_id":    "B01",
                "bucket_name":  "SAAS",
                "is_active":    True,
            }

        Raises:
            CompanyNotFoundError: Si company_id no existe en dim_company.
            RuntimeError:         Si BigQuery devuelve un error de conectividad.
        """
        query = f"""
            SELECT
                c.company_id,
                c.company_name,
                c.fund_id,
                c.bucket_id,
                b.bucket_name,
                c.is_active
            FROM `{_DATASET}.dim_company` AS c
            JOIN `{_DATASET}.dim_bucket`  AS b
              ON c.bucket_id = b.bucket_id
            WHERE c.company_id = @company_id
            LIMIT 1
        """
        params = [bigquery.ScalarQueryParameter("company_id", "STRING", company_id)]

        try:
            rows = list(
                _get_client()
                .query(query, job_config=bigquery.QueryJobConfig(query_parameters=params))
                .result()
            )
        except GoogleAPIError as exc:
            log.error("BQService.get_company_context error: %s", exc)
            raise RuntimeError(f"Error de BigQuery al consultar empresa: {exc}") from exc

        if not rows:
            raise CompanyNotFoundError(company_id)

        r = rows[0]
        return {
            "company_id":   r.company_id,
            "company_name": r.company_name,
            "fund_id":      r.fund_id,
            "bucket_id":    r.bucket_id,
            "bucket_name":  r.bucket_name,
            "is_active":    r.is_active,
        }

    # ── 2. save_submission ────────────────────────────────────────────────────

    def save_submission(
        self,
        *,
        submission_id: str,
        company_id:    str,
        period_id:     str,
        fund_id:       str,
        period_start:  date,
        submitted_by:  str,
        source_file:   str = "",
        kpis:          list[dict[str, Any]],
    ) -> int:
        """
        Persiste una submission y sus KPIs en BigQuery.

        Paso 1 → inserta 1 fila en submissions con status='PENDING'.
        Paso 2 → inserta N filas en fact_kpi_values (una por KPI).

        La clave de partición `period_start` se incluye explícitamente en
        fact_kpi_values para que BigQuery aproveche el partition pruning.

        Args:
            submission_id: ID único (ej. "S-a1b2c3d4").
            company_id:    FK a dim_company.
            period_id:     FK a dim_period (ej. "P2026Q1M01").
            fund_id:       FK a dim_fund.
            period_start:  Fecha de inicio del período (clave de partición).
            submitted_by:  Email o user_id del remitente.
            source_file:   GCS URI del archivo fuente (opcional).
            kpis:          Lista de dicts con:
                             - metric_id  (str, requerido)
                             - value      (float | None)
                             - value_notes(str | None)

        Returns:
            Número de filas de KPI insertadas en fact_kpi_values.

        Raises:
            RuntimeError: Si cualquiera de los dos inserts falla en BQ.
        """
        now = datetime.now(tz=timezone.utc)

        # ── Paso 1: submissions ───────────────────────────────────────────────
        df_sub = pd.DataFrame([{
            "submission_id": submission_id,
            "company_id":    company_id,
            "fund_id":       fund_id,
            "period_id":     period_id,
            "submitted_by":  submitted_by,
            "submitted_at":  now,
            "status":        "PENDING",
            "source_file":   source_file or None,
            "review_notes":  None,
        }])

        try:
            self._append(df_sub, "submissions")
            log.info("Submission %s insertada para %s/%s", submission_id, company_id, period_id)
        except Exception as exc:
            raise RuntimeError(
                f"Error al insertar submission '{submission_id}' en BigQuery: {exc}"
            ) from exc

        # ── Paso 2: fact_kpi_values ───────────────────────────────────────────
        if not kpis:
            log.warning("save_submission: lista kpis vacía para %s", submission_id)
            return 0

        records = [
            {
                "submission_id": submission_id,
                "company_id":    company_id,
                "metric_id":     kpi["metric_id"],
                "period_id":     period_id,
                "period_start":  period_start,      # clave de partición
                "value":         kpi.get("value"),
                "value_notes":   kpi.get("value_notes"),
                "inserted_at":   now,
            }
            for kpi in kpis
        ]
        df_facts = pd.DataFrame(records)

        try:
            self._append(df_facts, "fact_kpi_values")
            log.info(
                "%d KPI(s) insertados en fact_kpi_values — submission=%s",
                len(records), submission_id,
            )
        except Exception as exc:
            # La fila de submission ya fue escrita. Logear para rollback manual.
            log.error(
                "INCONSISTENCIA: submission %s escrita pero fact_kpi_values falló — %s",
                submission_id, exc,
            )
            raise RuntimeError(
                f"Error al insertar KPIs para submission '{submission_id}': {exc}. "
                "La fila en submissions fue insertada — puede requerirse limpieza."
            ) from exc

        return len(records)

    # ── Helper interno ────────────────────────────────────────────────────────

    def _append(self, df: pd.DataFrame, table: str) -> None:
        """Escribe un DataFrame en BQ con WRITE_APPEND."""
        job = _get_client().load_table_from_dataframe(
            df,
            f"{_DATASET}.{table}",
            job_config=bigquery.LoadJobConfig(
                write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
                autodetect=False,
            ),
        )
        job.result()   # bloquea; lanza excepción si BQ falla
