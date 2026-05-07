"""
seed_db.py — Poblar BD_Cometa_Dev con datos de prueba (mock data).

ADVERTENCIA: Este script está diseñado EXCLUSIVAMENTE para el entorno de desarrollo.
Contiene 3 candados de seguridad para prevenir escrituras accidentales en producción.

Uso:
    python src/scripts/seed_db.py

Dependencias:
    pip install google-cloud-bigquery pandas pyarrow
"""

import sys
from datetime import datetime, timezone

import pandas as pd
from google.cloud import bigquery
from google.cloud.bigquery import WriteDisposition, LoadJobConfig

# ==============================================================================
# CANDADO 1 — Definición explícita del dataset de destino
# Reemplaza "tu_proyecto" por tu GCP Project ID real antes de ejecutar.
# ==============================================================================
DATASET_ID = "cometa-mvp.BD_Cometa_Dev"

# ==============================================================================
# CANDADO 2 — Fail-safe: abortar si el dataset no termina en "_Dev"
# ==============================================================================
if not DATASET_ID.endswith("_Dev"):
    raise ValueError(
        "\n"
        "╔══════════════════════════════════════════════════════════════╗\n"
        "║  ¡ALERTA FATAL! El script está intentando apuntar a         ║\n"
        "║  producción. Abortando ejecución.                           ║\n"
        "║                                                              ║\n"
        f"║  DATASET_ID detectado: {DATASET_ID:<36}║\n"
        "║  El dataset de destino DEBE terminar en '_Dev'.             ║\n"
        "╚══════════════════════════════════════════════════════════════╝"
    )

# ==============================================================================
# CANDADO 3 — Confirmación humana obligatoria
# ==============================================================================
print("\n" + "=" * 64)
print("  SCRIPT DE SEED — ENTORNO DE DESARROLLO")
print("=" * 64)
print(f"  Dataset destino : {DATASET_ID}")
print(f"  Disposición     : WRITE_TRUNCATE (borra y reescribe cada tabla)")
print(f"  Tablas afectadas: 7 (dim_fund, dim_bucket, dim_period,")
print(f"                       dim_company, dim_metric,")
print(f"                       fact_kpi_values, submissions)")
print("=" * 64)
print("\n  ADVERTENCIA: Esta operación TRUNCARÁ todas las tablas listadas.")
print("  Escribe CONFIRMAR (en mayúsculas) para proceder, o cualquier")
print("  otra cosa para cancelar.\n")

confirmacion = input("  Tu respuesta: ").strip()
if confirmacion != "CONFIRMAR":
    print("\n  Operación cancelada. No se modificó ninguna tabla.")
    sys.exit(0)

print("\n  Confirmación recibida. Iniciando carga...\n")

# ==============================================================================
# Cliente de BigQuery
# Credenciales resueltas desde la variable de entorno GOOGLE_APPLICATION_CREDENTIALS
# ==============================================================================
client = bigquery.Client()

NOW = datetime.now(tz=timezone.utc)


# ==============================================================================
# Helper — carga un DataFrame a una tabla con WRITE_TRUNCATE
# ==============================================================================
def load_table(df: pd.DataFrame, table_name: str) -> None:
    """Carga un DataFrame a BigQuery usando WRITE_TRUNCATE."""
    destination = f"{DATASET_ID}.{table_name}"
    job_config = LoadJobConfig(write_disposition=WriteDisposition.WRITE_TRUNCATE)

    job = client.load_table_from_dataframe(df, destination, job_config=job_config)
    job.result()  # espera a que finalice

    rows = client.get_table(destination).num_rows
    print(f"  [OK] {destination:<50} -> {rows} fila(s) cargada(s)")


# ==============================================================================
# Mock data — 7 tablas
# ==============================================================================

# 1. dim_fund — 1 fondo
df_fund = pd.DataFrame([
    {
        "fund_id":          "F001",
        "fund_name":        "Cometa Fund I",
        "fund_description": "Fondo de venture capital enfocado en Latam early-stage",
        "vintage_year":     2022,
        "created_at":       NOW,
    }
])

# 2. dim_bucket — 2 sectores
df_bucket = pd.DataFrame([
    {
        "bucket_id":   "B01",
        "bucket_name": "SAAS",
        "fund_id":     "F001",
        "description": "Software as a Service B2B y B2C",
        "created_at":  NOW,
    },
    {
        "bucket_id":   "B02",
        "bucket_name": "FINTECH",
        "fund_id":     "F001",
        "description": "Servicios financieros y pagos digitales",
        "created_at":  NOW,
    },
])

# 3. dim_period — 2 períodos
df_period = pd.DataFrame([
    {
        "period_id":    "P2026Q1M01",
        "period_label": "Q1 2026 – Jan",
        "year":         2026,
        "quarter":      1,
        "month":        1,
        "period_start": pd.Timestamp("2026-01-01").date(),
        "period_end":   pd.Timestamp("2026-01-31").date(),
    },
    {
        "period_id":    "P2026Q1M02",
        "period_label": "Q1 2026 – Feb",
        "year":         2026,
        "quarter":      1,
        "month":        2,
        "period_start": pd.Timestamp("2026-02-01").date(),
        "period_end":   pd.Timestamp("2026-02-28").date(),
    },
])

# 4. dim_company — 2 empresas con coordenadas reales
df_company = pd.DataFrame([
    {
        "company_id":   "C001",
        "company_name": "DataFlow SaaS",
        "fund_id":      "F001",
        "bucket_id":    "B01",
        "country":      "Mexico",
        "city":         "Ciudad de Mexico",
        "latitude":     19.4326,
        "longitude":    -99.1332,
        "founded_year": 2020,
        "is_active":    True,
        "created_at":   NOW,
    },
    {
        "company_id":   "C002",
        "company_name": "PagoListo",
        "fund_id":      "F001",
        "bucket_id":    "B02",
        "country":      "Colombia",
        "city":         "Bogota",
        "latitude":     4.7110,
        "longitude":    -74.0721,
        "founded_year": 2021,
        "is_active":    True,
        "created_at":   NOW,
    },
])

# 5. dim_metric — 3 métricas
df_metric = pd.DataFrame([
    {
        "metric_id":   "K001",
        "metric_name": "Revenue",
        "description": "Ingresos netos del período en USD",
        "unit":        "USD",
        "category":    "Growth",
        "is_core":     True,   # aplica a todo el portfolio
        "created_at":  NOW,
    },
    {
        "metric_id":   "K002",
        "metric_name": "Churn Rate",
        "description": "Porcentaje de clientes perdidos en el período",
        "unit":        "%",
        "category":    "Retention",
        "is_core":     True,   # aplica a todo el portfolio
        "created_at":  NOW,
    },
    {
        "metric_id":   "K003",
        "metric_name": "CAC",
        "description": "Costo de adquisicion de cliente en USD",
        "unit":        "USD",
        "category":    "Efficiency",
        "is_core":     False,  # específico de algunos sectores
        "created_at":  NOW,
    },
])

# 6. fact_kpi_values — 4 filas; value_notes NULL en algunas
df_fact = pd.DataFrame([
    {
        "submission_id": "S000001",
        "company_id":    "C001",
        "metric_id":     "K001",
        "period_id":     "P2026Q1M01",
        "period_start":  pd.Timestamp("2026-01-01").date(),
        "value":         125_000.00,
        "value_notes":   None,                         # NULL intencional
        "inserted_at":   NOW,
    },
    {
        "submission_id": "S000001",
        "company_id":    "C001",
        "metric_id":     "K002",
        "period_id":     "P2026Q1M01",
        "period_start":  pd.Timestamp("2026-01-01").date(),
        "value":         3.5,
        "value_notes":   "Churn por cierre de ciclo fiscal de clientes enterprise",
        "inserted_at":   NOW,
    },
    {
        "submission_id": "S000002",
        "company_id":    "C002",
        "metric_id":     "K001",
        "period_id":     "P2026Q1M02",
        "period_start":  pd.Timestamp("2026-02-01").date(),
        "value":         87_400.00,
        "value_notes":   None,                         # NULL intencional
        "inserted_at":   NOW,
    },
    {
        "submission_id": "S000002",
        "company_id":    "C002",
        "metric_id":     "K003",
        "period_id":     "P2026Q1M02",
        "period_start":  pd.Timestamp("2026-02-01").date(),
        "value":         210.00,
        "value_notes":   "CAC elevado por campana de lanzamiento en Colombia",
        "inserted_at":   NOW,
    },
])

# 7. submissions — 2 envíos
df_submissions = pd.DataFrame([
    {
        "submission_id": "S000001",
        "company_id":    "C001",
        "fund_id":       "F001",
        "period_id":     "P2026Q1M01",
        "submitted_by":  "founder@dataflow.com",
        "submitted_at":  NOW,
        "status":        "VALIDATED",
        "source_file":   "gs://cometa-uploads/C001/2026-01/report.pdf",
        "review_notes":  "Datos verificados contra estado de cuenta bancario",
    },
    {
        "submission_id": "S000002",
        "company_id":    "C002",
        "fund_id":       "F001",
        "period_id":     "P2026Q1M02",
        "submitted_by":  "cfo@pagolisto.com",
        "submitted_at":  NOW,
        "status":        "PENDING",
        "source_file":   "gs://cometa-uploads/C002/2026-02/financials.xlsx",
        "review_notes":  None,
    },
])

# ==============================================================================
# Carga en orden respetando dependencias (dimensiones primero, hechos al final)
# ==============================================================================
print("  Cargando tablas...\n")

load_table(df_fund,        "dim_fund")
load_table(df_bucket,      "dim_bucket")
load_table(df_period,      "dim_period")
load_table(df_company,     "dim_company")
load_table(df_metric,      "dim_metric")
load_table(df_fact,        "fact_kpi_values")
load_table(df_submissions, "submissions")

print("\n" + "=" * 64)
print("  Seed completado exitosamente.")
print(f"  Dataset: {DATASET_ID}")
print("=" * 64 + "\n")
