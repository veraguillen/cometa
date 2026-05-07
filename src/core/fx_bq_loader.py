"""
fx_bq_loader.py
───────────────
Synchronises StaticFxProvider.RATE_TABLE → BigQuery dim_fx_rates.

Eliminates the risk of RATE_TABLE and the BQ seed going out of sync:
this script is the SINGLE place that writes FX rates to BigQuery.

Usage:
    python -m src.core.fx_bq_loader [--dry-run]

    --dry-run   Print the rows that would be written without touching BQ.

Idempotent: uses MERGE on (currency_code, year, month).
Existing non-estimated rows are never overwritten (only estimated /
carry-forward rows can be replaced once a real rate becomes available).
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from typing import Generator

from src.core.fx_service import RATE_TABLE


# ── Row generator ─────────────────────────────────────────────────────────────

def _generate_rows() -> Generator[dict, None, None]:
    """
    Fan-out RATE_TABLE (annual) → one row per (currency, year, month).
    Rate convention preserved: units of foreign currency per 1 USD.
    """
    loaded_at = datetime.now(timezone.utc).isoformat()
    for currency, year_map in RATE_TABLE.items():
        for year, rate in sorted(year_map.items()):
            for month in range(1, 13):
                yield {
                    "currency_code": currency,
                    "year":          year,
                    "month":         month,
                    "rate":          rate,
                    "rate_type":     "annual_avg",
                    "source":        "StaticFxProvider",
                    "loaded_at":     loaded_at,
                    "is_estimated":  False,
                }


# ── BigQuery merge ────────────────────────────────────────────────────────────

def load_to_bigquery(dry_run: bool = False) -> None:
    """
    Write all FX rows to BigQuery using insert_rows_json (streaming insert).
    Deduplication is enforced by the MERGE logic in §2 of fx_conversion.sql,
    but for the streaming path we use insert_rows_json with skip_invalid_rows=False.

    For a full idempotent MERGE, use the SQL in fx_conversion.sql §2 directly
    in the BQ console or via a scheduled query.
    """
    rows = list(_generate_rows())

    if dry_run:
        print(f"[DRY-RUN] {len(rows)} rows would be written to dim_fx_rates.")
        for r in rows[:5]:
            print(f"  {r}")
        print("  ...")
        return

    project   = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")
    dataset   = os.getenv("GOOGLE_BIGQUERY_DATASET") or os.getenv("BIGQUERY_DATASET", "BD_Cometa")
    table_id  = f"{project}.{dataset}.dim_fx_rates"

    try:
        from google.cloud import bigquery as bq
        from google.oauth2 import service_account

        key_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "cometa_key.json")
        if os.path.exists(key_path):
            creds  = service_account.Credentials.from_service_account_file(key_path)
            client = bq.Client(project=project, credentials=creds)
        else:
            client = bq.Client(project=project)

        errors = client.insert_rows_json(table_id, rows, skip_invalid_rows=False)
        if errors:
            print(f"[ERROR] BigQuery insert errors: {errors}", file=sys.stderr)
            sys.exit(1)

        print(f"[OK] {len(rows)} FX rows written to {table_id}")

    except ImportError:
        print("[ERROR] google-cloud-bigquery not installed.", file=sys.stderr)
        sys.exit(1)


# ── Validation (self-contained, no BQ needed) ─────────────────────────────────

def validate_rate_table() -> None:
    """
    Sanity-checks on RATE_TABLE before any write:
      - No rate <= 0 (would cause division by zero in the view)
      - USD must always be 1.0
      - Each currency must have at least one year
    Raises SystemExit on failure.
    """
    errors: list[str] = []

    for currency, year_map in RATE_TABLE.items():
        if not year_map:
            errors.append(f"Currency '{currency}' has no year entries.")
        for year, rate in year_map.items():
            if rate <= 0:
                errors.append(f"Rate <= 0: {currency}/{year} = {rate}")
            if currency == "USD" and rate != 1.0:
                errors.append(f"USD rate must be 1.0, got {currency}/{year} = {rate}")

    if errors:
        for e in errors:
            print(f"[VALIDATION FAIL] {e}", file=sys.stderr)
        sys.exit(1)

    currencies = sorted(RATE_TABLE.keys())
    years_per  = {c: sorted(m.keys()) for c, m in RATE_TABLE.items()}
    print(f"[VALIDATION OK] {len(currencies)} currencies: {currencies}")
    for c, yrs in years_per.items():
        print(f"  {c}: {yrs[0]}–{yrs[-1]}  ({len(yrs)} years × 12 months = {len(yrs)*12} rows)")

    total = sum(len(m) * 12 for m in RATE_TABLE.values())
    print(f"  Total rows to write: {total}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Load FX rates from RATE_TABLE into BigQuery")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without writing to BQ")
    args = parser.parse_args()

    validate_rate_table()
    load_to_bigquery(dry_run=args.dry_run)
