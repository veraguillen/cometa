#!/usr/bin/env python3
"""
migrate_bq.py — BigQuery schema evolution for cometa_vault.

Adds columns to ``fact_kpi_values`` if they do not already exist:

  confidence_score  FLOAT64    — Gemini extraction confidence (0.0–1.0)
  last_upload_at    TIMESTAMP  — When the source document was processed

Safe to run multiple times — skips columns that are already present.

Usage
-----
    # Dry-run (no changes — just shows what would happen)
    python src/scripts/migrate_bq.py --dry-run

    # Apply against the default dataset (cometa_vault)
    python src/scripts/migrate_bq.py

    # Override project / dataset
    python src/scripts/migrate_bq.py --project cometa-mvp --dataset cometa_vault

Prerequisites
-------------
    GOOGLE_APPLICATION_CREDENTIALS=./cometa_key.json  (local)
    GCP_SERVICE_ACCOUNT_JSON=<json string>             (Cloud Run / CI)
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_bq_client(project: str):
    """Return an authenticated BigQuery client."""
    from google.cloud import bigquery
    from google.oauth2 import service_account

    sa_json = os.getenv("GCP_SERVICE_ACCOUNT_JSON", "")
    if sa_json.strip().startswith("{"):
        info = json.loads(sa_json)
        creds = service_account.Credentials.from_service_account_info(
            info,
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        return bigquery.Client(project=project, credentials=creds)

    return bigquery.Client(project=project)


def _existing_columns(client, table_ref: str) -> set[str]:
    """Return the set of column names already present in *table_ref*."""
    from google.cloud.bigquery import TableReference
    table = client.get_table(table_ref)
    return {field.name for field in table.schema}


# ── Migration definition ──────────────────────────────────────────────────────

# Each entry: (column_name, bq_type, description)
MIGRATIONS: list[tuple[str, str, str]] = [
    (
        "confidence_score",
        "FLOAT64",
        "Gemini extraction confidence for this KPI field (0.0 = low, 1.0 = high).",
    ),
    (
        "last_upload_at",
        "TIMESTAMP",
        "UTC timestamp when the source PDF was processed and ingested.",
    ),
]

TABLE_NAME = "fact_kpi_values"


# ── Main ──────────────────────────────────────────────────────────────────────

def run(project: str, dataset: str, dry_run: bool) -> None:
    table_ref = f"{project}.{dataset}.{TABLE_NAME}"
    print(f"[migrate_bq] target table : {table_ref}")
    print(f"[migrate_bq] dry_run      : {dry_run}\n")

    client  = _get_bq_client(project)
    existing = _existing_columns(client, table_ref)
    print(f"[migrate_bq] existing columns ({len(existing)}): {sorted(existing)}\n")

    applied = 0
    skipped = 0

    for col_name, col_type, description in MIGRATIONS:
        if col_name in existing:
            print(f"  SKIP  {col_name} ({col_type}) — already exists")
            skipped += 1
            continue

        ddl = (
            f"ALTER TABLE `{table_ref}` "
            f"ADD COLUMN IF NOT EXISTS `{col_name}` {col_type} "
            f"OPTIONS(description='{description}')"
        )

        if dry_run:
            print(f"  DRY   {col_name} ({col_type}) — would run:\n        {ddl}")
        else:
            print(f"  ADD   {col_name} ({col_type}) …", end=" ", flush=True)
            job = client.query(ddl)
            job.result()  # wait for completion
            print("OK")

        applied += 1

    print(
        f"\n[migrate_bq] done — "
        f"{applied} column(s) {'would be ' if dry_run else ''}added, "
        f"{skipped} skipped."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Idempotent BigQuery schema migration for cometa_vault."
    )
    parser.add_argument(
        "--project",
        default=os.getenv("GOOGLE_CLOUD_PROJECT", "cometa-mvp"),
        help="GCP project ID (default: $GOOGLE_CLOUD_PROJECT or cometa-mvp)",
    )
    parser.add_argument(
        "--dataset",
        default=os.getenv("GOOGLE_BIGQUERY_DATASET") or os.getenv("BIGQUERY_DATASET", "BD_Cometa"),
        help="BigQuery dataset (default: $GOOGLE_BIGQUERY_DATASET or BD_Cometa)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print DDL statements without executing them.",
    )
    args = parser.parse_args()

    try:
        run(project=args.project, dataset=args.dataset, dry_run=args.dry_run)
    except Exception as exc:
        print(f"\n[migrate_bq] ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
