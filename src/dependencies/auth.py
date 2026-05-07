"""
src/dependencies/auth.py — Dependencias de autenticación y seguridad.

Exporta los callables de Depends() y las funciones helpers que todos los
routers necesitan importar.  Ningún símbolo de este módulo importa desde
src.api, lo que garantiza que no hay ciclos de importación cuando los
routers lo importan a su vez.

Jerarquía de importación (sin ciclos):
  src.auth_utils           (JWT helpers puros)
      └── src.dependencies.auth  (FastAPI wrappers + security utils)
              └── src.routers.*  (handlers HTTP)
                      └── src.api  (core: init app + include_router)
"""
from __future__ import annotations

import os
import re
import unicodedata

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from slowapi import Limiter
from slowapi.util import get_remote_address

from src.auth_utils import (
    JWT_ALGORITHM as _AUTH_JWT_ALGORITHM,
    JWT_SECRET    as _AUTH_JWT_SECRET,
)

# ── Rate limiting ─────────────────────────────────────────────────────────────
# Instancia única compartida por todos los routers.
# api.py asigna: app.state.limiter = limiter
limiter: Limiter = Limiter(key_func=get_remote_address)

# ── C3: JWT ───────────────────────────────────────────────────────────────────
bearer_scheme  = HTTPBearer(auto_error=False)
_JWT_SECRET    = _AUTH_JWT_SECRET
_JWT_ALGORITHM = _AUTH_JWT_ALGORITHM

# ── C4: Verificación de origen ────────────────────────────────────────────────
SKIP_ORIGIN_CHECK    = os.getenv("SKIP_ORIGIN_CHECK", "false").lower() == "true"
_INTERNAL_SOURCE_HDR = "x-cometa-source"
_IAP_USER_HDR        = "x-goog-authenticated-user-email"
_VALID_SOURCES       = {"dashboard", "analyst-portal", "internal-tool"}

# ── A1: Dominios de analistas internos ────────────────────────────────────────
INTERNAL_DOMAINS: frozenset[str] = frozenset(
    {"cometa.vc", "cometa.fund", "cometavc.com"}
)

# ── C2: Límite de tamaño de archivo ──────────────────────────────────────────
MAX_FILE_MB    = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024

# ── C7: Magic bytes por extensión ────────────────────────────────────────────
MAGIC_BYTES: dict[str, list[bytes]] = {
    ".pdf":     [b"%PDF"],
    ".xlsx":    [b"PK\x03\x04"],
    ".xls":     [b"\xd0\xcf\x11\xe0"],
    ".docx":    [b"PK\x03\x04"],
    ".doc":     [b"\xd0\xcf\x11\xe0"],
    ".parquet": [b"PAR1"],
    ".csv":     [],   # texto plano, sin magic bytes fijos
}

# ── C6: Patrones de sanitización ─────────────────────────────────────────────
_SAFE_FILENAME_RE = re.compile(r"[^\w\-.]")
_COMPANY_ID_RE    = re.compile(r"^[a-zA-Z0-9_\-\.]{1,64}$")
_EMAIL_RE         = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


# ── Auth dependencies ─────────────────────────────────────────────────────────

async def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """
    Valida el JWT HS256 emitido por el backend.
    Lanza 401 si el token es inválido, expirado o ausente.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Token de autenticación requerido")
    if not _JWT_SECRET:
        raise HTTPException(status_code=500, detail="JWT_SECRET no configurado en el servidor")
    try:
        payload = jwt.decode(
            credentials.credentials,
            _JWT_SECRET,
            algorithms=[_JWT_ALGORITHM],
            options={"verify_aud": False},
        )
        return payload
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Token inválido: {exc}")


def check_cometa_domain(token: dict) -> None:
    """
    Valida que el JWT pertenezca al dominio @cometa.vc.
    Lanza 403 si no coincide — defensa en profundidad más allá del login.
    """
    email  = (token.get("email") or token.get("sub") or "").strip().lower()
    domain = email.split("@")[-1] if "@" in email else ""
    if domain != "cometa.vc":
        raise HTTPException(
            status_code=403,
            detail=(
                "Acceso denegado. Este recurso está restringido al dominio "
                "@cometa.vc. Token emitido para un dominio no autorizado."
            ),
        )


async def require_analyst_auth(token: dict = Depends(require_auth)) -> dict:
    """
    Dependencia compuesta para endpoints /api/analyst/*.

    Encadena tres capas de control de acceso:
      1. JWT válido y no expirado  (require_auth ya lo garantiza).
      2. Dominio @cometa.vc        (defensa en profundidad más allá del login).
      3. Rol ANALISTA               (control de autorización estándar).

    Uso: token: dict = Depends(require_analyst_auth)
    """
    check_cometa_domain(token)
    if token.get("role") != "ANALISTA":
        raise HTTPException(
            status_code=403,
            detail="Acceso denegado. Se requiere rol ANALISTA con dominio @cometa.vc.",
        )
    return token


async def verify_origin(request: Request) -> None:
    """
    C4: Verifica que la petición provenga de una fuente autorizada.

    En producción (Cloud IAP) valida X-Goog-Authenticated-User-Email.
    En entornos sin IAP acepta X-Cometa-Source con valor válido.
    SKIP_ORIGIN_CHECK=true lo deshabilita para desarrollo local.
    """
    if SKIP_ORIGIN_CHECK:
        return
    if request.headers.get(_IAP_USER_HDR):
        return  # Cloud IAP verificó la identidad
    source = request.headers.get(_INTERNAL_SOURCE_HDR, "").strip().lower()
    if source in _VALID_SOURCES:
        return
    raise HTTPException(
        status_code=403,
        detail=(
            "Acceso denegado: origen no autorizado. "
            "Se requiere X-Goog-Authenticated-User-Email o X-Cometa-Source válido."
        ),
    )


# ── Security helpers ──────────────────────────────────────────────────────────

def validate_magic_bytes(file_content: bytes, ext: str) -> bool:
    """
    Verifica que los primeros bytes del contenido coincidan con la extensión
    declarada. Protege contra archivos renombrados (e.g. malware.exe → doc.pdf).
    """
    signatures = MAGIC_BYTES.get(ext, [])
    if not signatures:
        return True
    return any(file_content[:8].startswith(sig) for sig in signatures)


def sanitize_filename(filename: str) -> str:
    """
    Protege contra path traversal y caracteres peligrosos.
    Pasos: normalizar unicode → basename → strip chars no seguros
           → eliminar puntos dobles → limitar a 200 chars.
    """
    filename = unicodedata.normalize("NFKD", filename)
    filename = os.path.basename(filename)                     # bloquea ../../
    filename = _SAFE_FILENAME_RE.sub("_", filename)           # solo alfanum + -_.
    filename = re.sub(r"\.{2,}", ".", filename)               # elimina ..
    stem, ext = os.path.splitext(filename)
    return f"{stem[:196]}{ext}" if len(filename) > 200 else filename


def validate_company_header(company_id: str | None) -> str | None:
    """Valida que company_id sea alfanumérico + guiones/puntos (sin path traversal)."""
    if not company_id:
        return None
    if not _COMPANY_ID_RE.match(company_id):
        raise HTTPException(
            status_code=400,
            detail=f"company_id contiene caracteres no permitidos: {company_id!r}",
        )
    return company_id


def validate_email_header(email: str | None) -> str | None:
    """Valida formato básico de email."""
    if not email:
        return None
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail=f"founder-email inválido: {email!r}")
    return email.lower()
