"""
auth_utils.py — JWT helpers for Cometa Pipeline.

Responsabilidades:
  - Generar Access Tokens HS256 con sub, role, name, user_id y exp.
  - Generar IDs Híbridos únicos (ANA-XXXXXX / FND-XXXXXX).
  - Proveer la clave secreta y algoritmo compartidos con _require_auth en api.py.
"""
from __future__ import annotations

import os
import re
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import jwt

# ── Configuración ──────────────────────────────────────────────────────────────
JWT_SECRET: str = os.getenv("JWT_SECRET", "cometa-dev-secret-change-in-prod")
JWT_ALGORITHM: str = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS: int = 24

_INTERNAL_DOMAINS = {"cometa.vc", "cometa.com", "cometa.fund", "cometavc.com"}

# Patrón de ID híbrido: ANA-XXXXXX  o  FND-XXXXXX  (6 alfanuméricos)
_HYBRID_ID_RE = re.compile(r"^(ANA|FND)-[A-Za-z0-9]{6}$")
_ID_ALPHABET   = string.ascii_letters + string.digits   # 62 chars


def generate_hybrid_id(email: str) -> str:
    """
    Genera un ID Híbrido único para auditoría.

    Formato:  <PREFIJO>-<6 chars aleatorios>
      ANA-3kL9pZ  →  usuario @cometa.*
      FND-X7mQr2  →  cualquier otro dominio

    Usa `secrets.choice` (CSPRNG) para garantizar imprevisibilidad.
    """
    domain = email.split("@", 1)[1].lower() if "@" in email else ""
    prefix = "ANA" if domain in _INTERNAL_DOMAINS else "FND"
    suffix = "".join(secrets.choice(_ID_ALPHABET) for _ in range(6))
    return f"{prefix}-{suffix}"


def is_hybrid_id(value: str) -> bool:
    """Retorna True si `value` ya tiene formato de ID híbrido válido."""
    return bool(_HYBRID_ID_RE.match(value or ""))


def create_access_token(
    email: str,
    role: str,
    name: str = "",
    user_id: str = "",
    extra_claims: dict[str, Any] | None = None,
) -> str:
    """
    Genera un JWT HS256 firmado con JWT_SECRET.

    Claims incluidos:
      sub     — email del usuario (identificador principal)
      email   — duplicado de sub para compatibilidad con _derive_tenant_from_token
      role    — ANALISTA | FOUNDER | SOCIO
      name    — nombre de display del usuario
      user_id — ID Híbrido para auditoría (ANA-XXXXXX / FND-XXXXXX)
      iat     — issued-at
      exp     — expiry (ACCESS_TOKEN_EXPIRE_HOURS a partir de ahora)
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub":     email,
        "email":   email,
        "role":    role,
        "name":    name,
        "user_id": user_id,
        "iat":     now,
        "exp":     now + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
    }
    if extra_claims:
        payload.update(extra_claims)

    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def enforce_internal_role(email: str, declared_role: str) -> str:
    """
    Si el dominio del email es @cometa.*, fuerza el rol a ANALISTA
    independientemente de lo que declare el users.json.
    """
    domain = email.split("@", 1)[1].lower() if "@" in email else ""
    if domain in _INTERNAL_DOMAINS:
        return "ANALISTA"
    return declared_role
