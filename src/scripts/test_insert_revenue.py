"""
test_insert_revenue.py
──────────────────────
Prueba de inserción de una fila de Revenue en fact_kpi_staging (BD_Cometa_Dev).

Pasos:
  1. Resuelve el company_id real de QUINIO desde dim_company.
  2. Construye una fila de Revenue para P2026Q1M01 con valor de prueba.
  3. Llama a BQDataService.insert_to_staging_multiperiod() con esa fila.
  4. Imprime el resultado y la URL de BQ para inspección manual.

Uso:
    .\\venv\\Scripts\\python.exe -m src.scripts.test_insert_revenue
"""

from __future__ import annotations

import sys
import os

# Garantiza que el módulo raíz del proyecto esté en el path
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from src.core.bq_data_service import BQDataService, CompanyNotFoundError, BQInsertError


_COMPANY_IDENTIFIER = "QUINIO"   # se resolverá a su company_id real (ej. C013)
_PERIOD_ID          = "P2026Q1M01"
_REVENUE_VALUE      = 1_500_000.0   # MXN — valor de prueba


def main() -> None:
    bq = BQDataService()

    # ── 1. Resolver company_id canónico ────────────────────────────────────────
    print(f"[1/3] Resolviendo company_id para '{_COMPANY_IDENTIFIER}'...")
    try:
        company_id = bq.resolve_company_id(_COMPANY_IDENTIFIER)
    except CompanyNotFoundError as exc:
        print(f"  ERROR: {exc}")
        print("  Verifica que la empresa exista en dim_company y que el nombre coincida.")
        sys.exit(1)
    except BQInsertError as exc:
        print(f"  ERROR DE CONECTIVIDAD: {exc}")
        sys.exit(1)

    print(f"  OK → company_id = '{company_id}'")

    # ── 2. Obtener metadatos de la empresa (fund_id, bucket_name) ──────────────
    print(f"[2/3] Cargando metadatos de {company_id}...")
    try:
        meta = bq.get_company_metadata(company_id)
    except (CompanyNotFoundError, BQInsertError) as exc:
        print(f"  ERROR: {exc}")
        sys.exit(1)

    fund_id     = meta.get("fund_id", company_id)
    bucket_name = meta.get("bucket_name", "GENERAL")
    print(f"  fund_id={fund_id}  vertical={bucket_name}")

    # ── 3. Insertar fila de Revenue en staging ─────────────────────────────────
    import uuid as _uuid
    staging_id  = "TEST-" + _uuid.uuid4().hex[:8].upper()
    staging_row = {
        "metric_id":  "revenue",
        "period_id":  _PERIOD_ID,
        "value":      _REVENUE_VALUE,
        "currency":   "MXN",
        "source":     "TEST_SCRIPT",
        "confidence": 1.0,
    }

    print(f"[3/3] Insertando Revenue={_REVENUE_VALUE:,.0f} MXN para {company_id} / {_PERIOD_ID}...")
    print(f"  staging_id={staging_id}")
    try:
        result = bq.insert_to_staging_multiperiod(
            staging_id=staging_id,
            company_id=company_id,
            submitted_by="test-script@cometa.vc",
            source_file="test_insert_revenue.py",
            staging_rows=[staging_row],
            physics_ok=True,
        )
        print(f"  OK → staging_id={result.get('staging_id')}  rows_inserted={result.get('rows_inserted')}  status={result.get('status')}")
    except BQInsertError as exc:
        print(f"  ERROR DE INSERCIÓN: {exc}")
        sys.exit(1)

    print("\nInspección manual:")
    print(f"  https://console.cloud.google.com/bigquery?project=cometa-mvp&ws=!1m5!1m4!4m3!1scometa-mvp!2sBD_Cometa_Dev!3sfact_kpi_staging")


if __name__ == "__main__":
    main()
