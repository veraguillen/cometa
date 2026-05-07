"""
hash_service.py — Vault Seal (SHA-256) for KPI submissions.

Generates a deterministic, tamper-evident fingerprint for each financial
submission.  The seal covers: company identity, file hash, all KPI key-value
pairs (sorted for determinism), and the processing timestamp.

Usage
-----
    from src.services.hash_service import generate_vault_seal

    seal = generate_vault_seal(
        company_id  = "solvento",
        file_hash   = "abc123…",
        kpi_rows    = contract["kpi_rows"],
        processed_at= datetime.now(timezone.utc).isoformat(),
    )
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def _canonical(obj: Any) -> str:
    """Deterministic JSON serialisation — sorted keys, no whitespace."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def generate_vault_seal(
    company_id:   str,
    file_hash:    str,
    kpi_rows:     list[dict],
    processed_at: str,
) -> str:
    """
    Return a 64-char hex SHA-256 'Vault Seal' for a complete submission.

    The hash is deterministic: identical inputs always produce the same seal,
    regardless of dict insertion order or Python version.

    Parameters
    ----------
    company_id   : Lowercase company slug (e.g. "solvento").
    file_hash    : SHA-256 of the original PDF bytes (already computed upstream).
    kpi_rows     : List of KPI dicts from the data contract.
    processed_at : ISO-8601 UTC timestamp string.

    Returns
    -------
    str — 64-character lowercase hex digest.
    """
    payload = {
        "company_id":   company_id,
        "file_hash":    file_hash,
        "processed_at": processed_at,
        "kpis": sorted(
            [
                {
                    "key":   row.get("kpi_key", ""),
                    "value": row.get("raw_value", ""),
                    "unit":  row.get("unit", ""),
                }
                for row in kpi_rows
                if row.get("is_valid", False)
            ],
            key=lambda x: x["key"],
        ),
    }
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def short_seal(seal: str, chars: int = 16) -> str:
    """Return a display-friendly prefix of the full seal (default: 16 chars)."""
    return seal[:chars]
