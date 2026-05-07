"""
src/core/buckets.py — Fuente única de verdad para los nombres de buckets GCS.

Arquitectura Medallion de Cometa:

  RAW_BUCKET   (cometa-vc-raw-prod)   — Archivos originales subidos por founders.
                                         NUNCA se borran. Auditoría permanente.
                                         Path: {company_slug}/{hash}_{filename}

  STAGE_BUCKET (cometa-vc-stage-prod) — JSONs de Gemini + vault/ de resultados.
                                         Datos en revisión, pendientes del analista.
                                         Paths: stage/{company}/…  vault/{company}/…
                                                pending_mapper/{company}/…

  GOLD_BUCKET  (cometa-vc-gold-prod)  — KPIs certificados por el analista.
                                         Sólo escribe finalize-analysis.

  HIST_BUCKET  (historicofund)        — CSV maestro del fondo (CIII).
                                         Sólo lectura desde el backend.

Regla de acceso:
  Importar SIEMPRE desde este módulo. No usar os.getenv("GCS_*") dispersos.
"""
from __future__ import annotations

import os

RAW_BUCKET: str   = os.getenv("GCS_INPUT_BUCKET",
                               os.getenv("GCS_RAW_BUCKET", "cometa-vc-raw-prod"))

STAGE_BUCKET: str = os.getenv("GCS_OUTPUT_BUCKET",
                               os.getenv("GCS_STAGE_BUCKET", "cometa-vc-stage-prod"))

GOLD_BUCKET: str  = os.getenv("BUCKET_GOLD", "cometa-vc-gold-prod")

HIST_BUCKET: str  = os.getenv("HISTORICOFUND_BUCKET", "historicofund")
