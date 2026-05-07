#!/usr/bin/env python3
"""
invite_founder.py — Secure founder invitation CLI for Cometa VC.

Usage
-----
    python src/scripts/invite_founder.py \\
        --email founder@startup.com \\
        --company-name "Startup Inc" \\
        [--name "Nombre Apellido"] \\
        [--dry-run]

What it does
------------
  1. Validates the email is not already registered and ACTIVE.
  2. Generates a signed JWT invite token (48 h expiry, type="invite").
  3. Registers the founder in users.json with status="PENDING_INVITE".
  4. Sends the invite email via email_service.send_invite_email().

Security notes
--------------
  - Token is signed with JWT_SECRET — same key used for access tokens.
  - Placeholder password uses secrets.token_hex(32): not a bcrypt hash,
    not guessable, replaced by the real hash when the founder activates.
  - status="PENDING_INVITE" blocks login until /api/auth/setup-password.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

# ── Bootstrap ─────────────────────────────────────────────────────────────────
# Allow running from the project root (python src/scripts/invite_founder.py …)
_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))
load_dotenv(_REPO_ROOT / ".env")

from jose import jwt                                    # noqa: E402
from src.auth_utils import (                           # noqa: E402
    JWT_SECRET,
    JWT_ALGORITHM,
    generate_hybrid_id,
    is_hybrid_id,
)
from src.schemas import UserSchema                     # noqa: E402

_USERS_FILE      = _REPO_ROOT / "src" / "users.json"
_INVITE_EXPIRE_H = 48
_EMAIL_RE        = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Production frontend URL — used in invite link
_FRONTEND_URL = os.getenv(
    "NEXTAUTH_URL",
    "https://cometa-vault-frontend-92572839783.us-central1.run.app",
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_users() -> list[dict]:
    try:
        with open(_USERS_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh).get("users", [])
    except FileNotFoundError:
        return []


def _save_users(users: list[UserSchema]) -> None:
    tmp = _USERS_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"users": [u.model_dump() for u in users]}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(_USERS_FILE)


def _generate_invite_token(email: str, company_name: str) -> str:
    """Return a JWT invite token valid for 48 hours."""
    now = datetime.now(timezone.utc)
    payload = {
        "type":         "invite",
        "sub":          email,
        "email":        email,
        "company_name": company_name,
        "iat":          now,
        "exp":          now + timedelta(hours=_INVITE_EXPIRE_H),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


# ── Main logic ────────────────────────────────────────────────────────────────

def invite(
    email:        str,
    company_name: str,
    name:         str = "",
    dry_run:      bool = False,
) -> None:
    email = email.strip().lower()

    # Validate email format
    if not _EMAIL_RE.match(email):
        print(f"[invite] ERROR: email inválido: {email!r}", file=sys.stderr)
        sys.exit(1)

    users = _load_users()

    # Check for duplicates
    existing = next((u for u in users if u.get("email", "").lower() == email), None)
    if existing:
        status = existing.get("status", "ACTIVE")
        if status == "ACTIVE":
            print(f"[invite] ERROR: {email!r} ya está registrado y activo.", file=sys.stderr)
            sys.exit(1)
        elif status == "PENDING_INVITE":
            print(
                f"[invite] WARN: {email!r} ya tiene una invitación pendiente. "
                "Se regenerará el token y se reenviará el correo."
            )
            # Remove the stale record so we recreate it fresh
            users = [u for u in users if u.get("email", "").lower() != email]

    # Generate invite token
    invite_token = _generate_invite_token(email, company_name)
    setup_url    = f"{_FRONTEND_URL}/auth/setup-password?token={invite_token}"

    print(f"[invite] Email        : {email}")
    print(f"[invite] Company      : {company_name}")
    print(f"[invite] Expires in   : {_INVITE_EXPIRE_H}h")
    print(f"[invite] Setup URL    : {setup_url}")

    if dry_run:
        print("[invite] DRY RUN — no changes written, no email sent.")
        return

    # Build placeholder password (not a bcrypt hash → login blocked)
    placeholder_pw = f"LOCKED:{secrets.token_hex(24)}"

    # Derive company_id from company_name slug or domain
    company_domain = email.split("@")[1] if "@" in email else ""
    company_id     = company_domain or company_name.lower().replace(" ", "_")

    # Register user with PENDING_INVITE status
    new_user_dict = {
        "id":         generate_hybrid_id(email),
        "email":      email,
        "password":   placeholder_pw,
        "name":       name or company_name,
        "role":       "FOUNDER",
        "company_id": company_id,
        "status":     "PENDING_INVITE",
    }

    # Validate via UserSchema before touching disk (Zero Trust)
    new_user = UserSchema.model_validate(new_user_dict)

    # Rebuild validated list — migrate any legacy records in the same pass
    all_users = users + [new_user_dict]
    validated: list[UserSchema] = [
        UserSchema.model_validate(u) if not isinstance(u, UserSchema) else u
        for u in all_users
    ]
    _save_users(validated)
    print(f"[invite] Registered {email!r} as PENDING_INVITE (id={new_user.id})")

    # Send invite email
    from src.services.email_service import send_invite_email  # noqa: PLC0415
    sent = send_invite_email(
        to_email=email,
        company_name=company_name,
        setup_url=setup_url,
    )
    if sent:
        print(f"[invite] Email enviado a {email!r}")
    else:
        print(f"[invite] WARN: Email no enviado (revisar configuración SMTP/Resend).")
        print(f"[invite] Setup URL manual: {setup_url}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a secure founder invitation for Cometa Vault."
    )
    parser.add_argument("--email",        required=True,  help="Founder email address")
    parser.add_argument("--company-name", required=True,  help="Company / startup name")
    parser.add_argument("--name",         default="",     help="Founder display name (optional)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print token and URL without writing to disk or sending email.",
    )
    args = parser.parse_args()

    try:
        invite(
            email=args.email,
            company_name=args.company_name,
            name=args.name,
            dry_run=args.dry_run,
        )
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[invite] FATAL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
