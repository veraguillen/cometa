"""
email_service.py — Confirmation email dispatch for Cometa founders.

Transport strategy (evaluated in order):
  1. Resend API  — if RESEND_API_KEY env var is set (pip install resend)
  2. SMTP        — if SMTP_HOST env var is set (SMTP_PORT, SMTP_USER, SMTP_PASSWORD)
  3. Stdout log  — dev fallback; always returns True so the UI is never blocked

Call only ``send_founder_confirmation()`` from application code.
All internal helpers are module-private.
"""

from __future__ import annotations

import os
import smtplib
import textwrap
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Sequence

# Load .env so the module works correctly when run outside uvicorn
# (e.g. during local tests or one-off scripts).
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed — rely on environment variables already set


# ── Transport config ──────────────────────────────────────────────────────────
# FROM/NAME are stable — read once at module load.
# RESEND_API_KEY is read fresh on every call (lazy) so .env updates don't
# require a server restart. load_dotenv(override=True) is called inside each
# send function to pick up any in-place .env edits.
_FROM_ADDRESS: str = os.getenv("EMAIL_FROM",      "onboarding@cometa.vc")
_FROM_NAME:    str = os.getenv("EMAIL_FROM_NAME", "Cometa Vault")


def _load_transport_config() -> dict:
    """Re-read volatile transport credentials from .env on every call."""
    try:
        from dotenv import load_dotenv as _ld
        _ld(override=True)
    except ImportError:
        pass
    return {
        "api_key":       os.getenv("RESEND_API_KEY", ""),
        "smtp_host":     os.getenv("SMTP_HOST", ""),
        "smtp_port":     int(os.getenv("SMTP_PORT", "587")),
        "smtp_user":     os.getenv("SMTP_USER", ""),
        "smtp_password": os.getenv("SMTP_PASSWORD", ""),
        "from_address":  os.getenv("EMAIL_FROM", _FROM_ADDRESS),
        "from_name":     os.getenv("EMAIL_FROM_NAME", _FROM_NAME),
    }


# ── HTML template ─────────────────────────────────────────────────────────────

def _build_html(
    company_domain: str,
    file_names: Sequence[str],
    manual_kpis: dict[str, str],
    timestamp: str,
) -> str:
    """Minimal, institutional HTML body — dark theme, Helvetica-family."""
    file_rows = "".join(
        f'<tr>'
        f'<td style="padding:3px 8px 3px 0;color:#888;font-size:12px;">&#x2022;</td>'
        f'<td style="padding:3px 0;color:#EDEDED;font-size:12px;">{name}</td>'
        f'</tr>'
        for name in file_names
    ) or '<tr><td colspan="2" style="color:#555;font-size:11px;">—</td></tr>'

    kpi_section = ""
    if manual_kpis:
        kpi_rows = "".join(
            f'<tr>'
            f'<td style="padding:3px 12px 3px 0;color:#A3A3A3;font-size:11px;">'
            f'{k.replace("_", " ").title()}</td>'
            f'<td style="padding:3px 0;color:#EDEDED;font-size:11px;font-weight:500;">{v}</td>'
            f'</tr>'
            for k, v in manual_kpis.items()
        )
        kpi_section = f"""
        <p style="margin:20px 0 8px;font-size:10px;letter-spacing:0.14em;
                   text-transform:uppercase;color:#555;">
          KPIs complementados manualmente
        </p>
        <table cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
          {kpi_rows}
        </table>
        """

    return textwrap.dedent(f"""
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    </head>
    <body style="margin:0;padding:0;background:#0A0A0A;
                 font-family:Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0A0A0A;padding:40px 16px;">
        <tr><td>
        <table width="560" align="center" cellpadding="0" cellspacing="0"
               style="background:#171717;
                      border:1px solid rgba(255,255,255,0.08);
                      border-radius:12px;overflow:hidden;max-width:560px;">

          <!-- ── Header ── -->
          <tr>
            <td style="padding:28px 32px 20px;
                        border-bottom:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:10px;letter-spacing:0.18em;
                         text-transform:uppercase;color:#64CAE4;">
                Cometa Vault
              </p>
              <h1 style="margin:8px 0 0;font-size:20px;font-weight:100;
                          color:#FFFFFF;letter-spacing:0.04em;">
                Expediente digital completo
              </h1>
            </td>
          </tr>

          <!-- ── Body ── -->
          <tr>
            <td style="padding:24px 32px 28px;">
              <p style="margin:0 0 20px;font-size:13px;font-weight:300;
                         color:#A3A3A3;line-height:1.65;">
                Tu expediente financiero para
                <strong style="color:#EDEDED;">{company_domain}</strong>
                ha sido registrado correctamente en la Bóveda de Cometa.
              </p>

              <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.14em;
                         text-transform:uppercase;color:#555;">
                Registrado
              </p>
              <p style="margin:0 0 20px;font-size:12px;color:#888;">
                {timestamp} UTC
              </p>

              <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.14em;
                         text-transform:uppercase;color:#555;">
                Documentos procesados
              </p>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
                {file_rows}
              </table>

              {kpi_section}

              <p style="margin:24px 0 0;font-size:11px;color:#555;line-height:1.6;">
                El equipo de Cometa revisará el expediente próximamente.<br>
                Este correo es una confirmación automática — no es necesario responder.
              </p>
            </td>
          </tr>

          <!-- ── Footer ── -->
          <tr>
            <td style="padding:14px 32px;
                        border-top:1px solid rgba(255,255,255,0.05);
                        background:rgba(0,0,0,0.25);">
              <p style="margin:0;font-size:10px;color:#444;letter-spacing:0.06em;">
                COMETA VENTURE CAPITAL &nbsp;·&nbsp; cometa.vc
              </p>
            </td>
          </tr>

        </table>
        </td></tr>
      </table>
    </body>
    </html>
    """).strip()


def _build_plain(
    company_domain: str,
    file_names: Sequence[str],
    timestamp: str,
) -> str:
    files_text = "\n".join(f"  * {n}" for n in file_names) or "  (ninguno)"
    return textwrap.dedent(f"""
    Cometa Vault — Expediente digital completo
    ==========================================

    Tu expediente financiero para {company_domain} ha sido registrado
    correctamente en la Boveda de Cometa.

    Documentos procesados:
    {files_text}

    Registrado: {timestamp} UTC

    El equipo de Cometa revisara el expediente proximamente.

    -- Cometa VC (cometa.vc)
    """).strip()


# ── Invite email templates ────────────────────────────────────────────────────

def _build_invite_html(company_name: str, setup_url: str) -> str:
    """Dark-theme invite email — Obsidian palette, Helvetica Now Display, cyan CTA."""
    return textwrap.dedent(f"""
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    </head>
    <body style="margin:0;padding:0;background:#0A0A0A;
                 font-family:Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0A0A0A;padding:48px 16px;">
        <tr><td>
        <table width="540" align="center" cellpadding="0" cellspacing="0"
               style="background:#111111;
                      border:1px solid rgba(255,255,255,0.07);
                      border-radius:14px;overflow:hidden;max-width:540px;">

          <!-- ── Header ── -->
          <tr>
            <td style="padding:32px 36px 24px;
                        border-bottom:1px solid rgba(255,255,255,0.05);">
              <p style="margin:0;font-size:10px;letter-spacing:0.20em;
                         text-transform:uppercase;color:#64CAE4;">
                Cometa VC
              </p>
              <!-- weight 100 title -->
              <h1 style="margin:10px 0 0;font-size:24px;font-weight:100;
                          letter-spacing:0.03em;color:#FFFFFF;line-height:1.25;">
                Tu Bóveda Digital<br>en Cometa VC
              </h1>
            </td>
          </tr>

          <!-- ── Body ── -->
          <tr>
            <td style="padding:28px 36px 32px;">
              <p style="margin:0 0 10px;font-size:13px;font-weight:400;
                         color:#A3A3A3;line-height:1.7;">
                Hola,
              </p>
              <p style="margin:0 0 24px;font-size:13px;font-weight:300;
                         color:#A3A3A3;line-height:1.7;">
                Has sido invitado a tu Bóveda Digital en Cometa VC como
                representante de
                <strong style="color:#EDEDED;font-weight:400;">{company_name}</strong>.
                Configura tu acceso seguro para comenzar el proceso de onboarding.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td style="border-radius:10px;background:#64CAE4;">
                    <a href="{setup_url}"
                       style="display:inline-block;padding:14px 32px;
                              font-size:13px;font-weight:400;
                              letter-spacing:0.06em;color:#000000;
                              text-decoration:none;border-radius:10px;">
                      Configurar acceso seguro →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:11px;color:#555;line-height:1.6;">
                Si el botón no funciona, copia este enlace en tu navegador:
              </p>
              <p style="margin:0 0 24px;font-size:10px;word-break:break-all;
                         color:#444;font-family:monospace;">
                {setup_url}
              </p>

              <p style="margin:0;font-size:11px;color:#444;line-height:1.6;">
                Este enlace expira en 48 horas. Si no esperabas esta invitación,
                puedes ignorar este correo de forma segura.
              </p>
            </td>
          </tr>

          <!-- ── Footer ── -->
          <tr>
            <td style="padding:14px 36px;
                        border-top:1px solid rgba(255,255,255,0.05);
                        background:rgba(0,0,0,0.3);">
              <p style="margin:0;font-size:10px;color:#333;letter-spacing:0.06em;">
                COMETA VENTURE CAPITAL &nbsp;·&nbsp; cometa.vc
              </p>
            </td>
          </tr>

        </table>
        </td></tr>
      </table>
    </body>
    </html>
    """).strip()


def _build_invite_plain(company_name: str, setup_url: str) -> str:
    return textwrap.dedent(f"""
    Cometa VC — Invitacion a tu Boveda Digital
    ==========================================

    Has sido invitado a tu Boveda Digital en Cometa VC como
    representante de {company_name}.

    Configura tu acceso seguro en el siguiente enlace (valido 48 horas):

    {setup_url}

    Si no esperabas esta invitacion, ignora este correo.

    -- Cometa VC (cometa.vc)
    """).strip()


# ── Receipt (Vault Seal) email templates ──────────────────────────────────────

def _build_receipt_html(
    company_domain: str,
    period:         str,
    vault_seal:     str,
    file_hash:      str,
    kpi_count:      int,
    processed_at:   str,
) -> str:
    seal_short = vault_seal[:16]
    return textwrap.dedent(f"""
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    </head>
    <body style="margin:0;padding:0;background:#0A0A0A;
                 font-family:Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#0A0A0A;padding:48px 16px;">
        <tr><td>
        <table width="540" align="center" cellpadding="0" cellspacing="0"
               style="background:#111111;
                      border:1px solid rgba(255,255,255,0.07);
                      border-radius:14px;overflow:hidden;max-width:540px;">

          <!-- Header -->
          <tr>
            <td style="padding:28px 36px 20px;
                        border-bottom:1px solid rgba(255,255,255,0.05);">
              <p style="margin:0;font-size:10px;letter-spacing:0.20em;
                         text-transform:uppercase;color:#64CAE4;">
                Cometa Vault · Recibo Digital
              </p>
              <h1 style="margin:10px 0 0;font-size:22px;font-weight:100;
                          letter-spacing:0.03em;color:#FFFFFF;line-height:1.25;">
                Recibo de Información<br>
                <span style="color:#A3A3A3;font-size:16px;">{period}</span>
              </h1>
            </td>
          </tr>

          <!-- Vault Seal -->
          <tr>
            <td style="padding:24px 36px 0;">
              <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.16em;
                         text-transform:uppercase;color:#555;">
                Sello de Bóveda (SHA-256)
              </p>
              <div style="background:#0D0D0D;border:1px solid rgba(100,202,228,0.2);
                           border-radius:8px;padding:14px 16px;">
                <p style="margin:0;font-size:11px;font-family:monospace;
                           color:#64CAE4;letter-spacing:0.08em;word-break:break-all;">
                  {vault_seal}
                </p>
              </div>
            </td>
          </tr>

          <!-- Details table -->
          <tr>
            <td style="padding:20px 36px 28px;">
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="padding:6px 0;font-size:10px;letter-spacing:0.12em;
                              text-transform:uppercase;color:#555;width:40%;">Empresa</td>
                  <td style="padding:6px 0;font-size:12px;color:#EDEDED;">
                    {company_domain}
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:10px;letter-spacing:0.12em;
                              text-transform:uppercase;color:#555;">Período</td>
                  <td style="padding:6px 0;font-size:12px;color:#EDEDED;">{period}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:10px;letter-spacing:0.12em;
                              text-transform:uppercase;color:#555;">KPIs registrados</td>
                  <td style="padding:6px 0;font-size:12px;color:#EDEDED;">{kpi_count}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:10px;letter-spacing:0.12em;
                              text-transform:uppercase;color:#555;">Sello corto</td>
                  <td style="padding:6px 0;font-size:12px;font-family:monospace;
                              color:#64CAE4;">{seal_short}…</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:10px;letter-spacing:0.12em;
                              text-transform:uppercase;color:#555;">Procesado</td>
                  <td style="padding:6px 0;font-size:12px;color:#888;">{processed_at}</td>
                </tr>
              </table>

              <p style="margin:20px 0 0;font-size:11px;color:#444;line-height:1.6;">
                Este sello es prueba criptográfica de la integridad de los datos
                registrados. Guárdalo como referencia — Cometa VC lo usará para
                verificar la autenticidad del expediente.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:14px 36px;
                        border-top:1px solid rgba(255,255,255,0.05);
                        background:rgba(0,0,0,0.3);">
              <p style="margin:0;font-size:10px;color:#333;letter-spacing:0.06em;">
                COMETA VENTURE CAPITAL &nbsp;·&nbsp; cometa.vc
              </p>
            </td>
          </tr>

        </table>
        </td></tr>
      </table>
    </body>
    </html>
    """).strip()


def _build_receipt_plain(
    company_domain: str,
    period:         str,
    vault_seal:     str,
    kpi_count:      int,
    processed_at:   str,
) -> str:
    return textwrap.dedent(f"""
    Cometa Vault — Recibo de Informacion
    =====================================
    Empresa  : {company_domain}
    Periodo  : {period}
    KPIs     : {kpi_count}
    Procesado: {processed_at}

    Sello de Boveda (SHA-256):
    {vault_seal}

    Guarda este sello como referencia de integridad.

    -- Cometa VC (cometa.vc)
    """).strip()


# ── Public interface ──────────────────────────────────────────────────────────

def send_receipt_email(
    to_email:       str,
    company_domain: str,
    period:         str,
    vault_seal:     str,
    file_hash:      str,
    kpi_count:      int,
    processed_at:   str,
) -> bool:
    """
    Send a cryptographic receipt (Vault Seal) to the founder after a
    successful KPI submission.

    Parameters
    ----------
    to_email       : Recipient — the founder's email address.
    company_domain : Company slug, e.g. ``"solvento"``.
    period         : Canonical period ID, e.g. ``"P2025Q4M12"``.
    vault_seal     : 64-char SHA-256 hex digest from ``generate_vault_seal()``.
    file_hash      : SHA-256 of the original PDF bytes.
    kpi_count      : Number of valid KPI rows included in the seal.
    processed_at   : ISO-8601 UTC timestamp string.

    Returns
    -------
    bool — True if delivered, False on any failure. Never raises.
    """
    cfg     = _load_transport_config()
    subject = f"Cometa Vault — Recibo de Información · {period}"
    html    = _build_receipt_html(company_domain, period, vault_seal, file_hash, kpi_count, processed_at)
    plain   = _build_receipt_plain(company_domain, period, vault_seal, kpi_count, processed_at)
    sender  = f"{cfg['from_name']} <{cfg['from_address']}>"

    # ── 1. Resend ─────────────────────────────────────────────────────────────
    if cfg["api_key"]:
        try:
            import resend  # type: ignore[import]
            resend.api_key = cfg["api_key"]
            resp = resend.Emails.send({
                "from":    sender,
                "to":      [to_email],
                "subject": subject,
                "html":    html,
                "text":    plain,
            })
            print(f"[email/receipt] Resend OK -> {to_email}  id={getattr(resp, 'id', resp)}")
            return True
        except Exception as exc:
            print(f"[email/receipt] Resend FAILED ({type(exc).__name__}): {exc}")
            # fall through to SMTP

    # ── 2. SMTP ───────────────────────────────────────────────────────────────
    if cfg["smtp_host"]:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"]    = sender
            msg["To"]      = to_email
            msg.attach(MIMEText(plain, "plain", "utf-8"))
            msg.attach(MIMEText(html,  "html",  "utf-8"))
            with smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"]) as server:
                server.ehlo()
                server.starttls()
                if cfg["smtp_user"] and cfg["smtp_password"]:
                    server.login(cfg["smtp_user"], cfg["smtp_password"])
                server.sendmail(cfg["from_address"], [to_email], msg.as_string())
            print(f"[email/receipt] SMTP OK -> {to_email}")
            return True
        except Exception as exc:
            print(f"[email/receipt] SMTP FAILED: {exc}")
            return False

    print("[email/receipt] No transport configured — skipping receipt email")
    return False


def send_invite_email(
    to_email:     str,
    company_name: str,
    setup_url:    str,
) -> tuple[bool, str]:
    """
    Send a founder invite email with a secure setup link.

    Parameters
    ----------
    to_email     : Recipient — the founder's email address.
    company_name : Company / startup name shown in the email body.
    setup_url    : Full URL to the /auth/setup-password page with JWT token.

    Returns
    -------
    tuple[bool, str]
        (True, "")          — email delivered via Resend or SMTP.
        (False, error_msg)  — delivery failed; error_msg contains the exact
                              Resend/SMTP error for display in the UI.
    """
    cfg     = _load_transport_config()
    subject = "Cometa VC — Configurar tu acceso a la Bóveda Digital"
    html    = _build_invite_html(company_name, setup_url)
    plain   = _build_invite_plain(company_name, setup_url)
    sender  = f"{cfg['from_name']} <{cfg['from_address']}>"

    # ── 1. Resend ─────────────────────────────────────────────────────────────
    if cfg["api_key"]:
        try:
            import resend  # type: ignore[import]
            resend.api_key = cfg["api_key"]
            resp = resend.Emails.send({
                "from":    sender,
                "to":      [to_email],
                "subject": subject,
                "html":    html,
                "text":    plain,
            })
            print(f"[email/invite] Resend OK -> {to_email}  id={getattr(resp, 'id', resp)}")
            return (True, "")
        except Exception as exc:
            body_detail = getattr(exc, "response", None) or getattr(exc, "body", None)
            error_msg = str(exc)
            if body_detail:
                error_msg = f"{exc} — {body_detail}"
            print(f"[email/invite] Resend FAILED ({type(exc).__name__}): {error_msg}")
            return (False, error_msg)

    # ── 2. SMTP ───────────────────────────────────────────────────────────────
    if cfg["smtp_host"]:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"]    = sender
            msg["To"]      = to_email
            msg.attach(MIMEText(plain, "plain", "utf-8"))
            msg.attach(MIMEText(html,  "html",  "utf-8"))
            with smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"]) as server:
                server.ehlo()
                server.starttls()
                if cfg["smtp_user"] and cfg["smtp_password"]:
                    server.login(cfg["smtp_user"], cfg["smtp_password"])
                server.sendmail(cfg["from_address"], [to_email], msg.as_string())
            print(f"[email/invite] SMTP OK -> {to_email}")
            return (True, "")
        except Exception as exc:
            error_msg = str(exc)
            print(f"[email/invite] SMTP FAILED: {error_msg}")
            return (False, f"SMTP error: {error_msg}")

    # No transport configured — surface it as a clear error
    return (False, "No hay transporte de correo configurado: establece RESEND_API_KEY en .env")


def send_founder_confirmation(
    to_email:       str,
    company_domain: str,
    file_names:     Sequence[str],
    manual_kpis:    dict[str, str] | None = None,
) -> bool:
    """
    Send a founder confirmation email via the first available transport.

    Parameters
    ----------
    to_email       : Recipient — the founder's email address.
    company_domain : Company slug, e.g. ``"solvento.com"``.
    file_names     : Ordered list of processed file display names.
    manual_kpis    : Optional dict of manually entered KPI key → value pairs.

    Returns
    -------
    bool
        ``True`` if the email was queued / delivered successfully or the dev
        fallback was used.  ``False`` if an attempted transport failed.
        Never raises.
    """
    cfg       = _load_transport_config()
    kpis      = manual_kpis or {}
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    subject   = f"Cometa Vault — Expediente {company_domain} registrado"
    html      = _build_html(company_domain, file_names, kpis, timestamp)
    plain     = _build_plain(company_domain, file_names, timestamp)
    sender    = f"{cfg['from_name']} <{cfg['from_address']}>"

    # ── 1. Resend ─────────────────────────────────────────────────────────────
    if cfg["api_key"]:
        try:
            import resend  # type: ignore[import]
            resend.api_key = cfg["api_key"]
            resp = resend.Emails.send({
                "from":    sender,
                "to":      [to_email],
                "subject": subject,
                "html":    html,
                "text":    plain,
            })
            print(f"[email] Resend OK -> {to_email}  id={getattr(resp, 'id', resp)}")
            return True
        except Exception as exc:
            print(f"[email] Resend FAILED ({type(exc).__name__}): {exc}")
            # fall through to SMTP

    # ── 2. SMTP ───────────────────────────────────────────────────────────────
    if cfg["smtp_host"]:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"]    = sender
            msg["To"]      = to_email
            msg.attach(MIMEText(plain, "plain", "utf-8"))
            msg.attach(MIMEText(html,  "html",  "utf-8"))
            with smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"]) as server:
                server.ehlo()
                server.starttls()
                if cfg["smtp_user"] and cfg["smtp_password"]:
                    server.login(cfg["smtp_user"], cfg["smtp_password"])
                server.sendmail(cfg["from_address"], [to_email], msg.as_string())
            print(f"[email] SMTP OK -> {to_email}")
            return True
        except Exception as exc:
            print(f"[email] SMTP FAILED: {exc}")
            return False

    return False
