"""
test_identity.py — Tests for hybrid ID generation and validation.

Run with:
    pytest src/tests/test_identity.py -v
"""
import re
import pytest
from src.auth_utils import generate_hybrid_id, is_hybrid_id

# ── Constantes ─────────────────────────────────────────────────────────────────
_HYBRID_PATTERN = re.compile(r"^(ANA|FND)-[A-Za-z0-9]{6}$")

_INTERNAL_EMAILS = [
    "alice@cometa.com",
    "bob@cometa.vc",
    "carol@cometa.fund",
    "dave@cometavc.com",
]

_EXTERNAL_EMAILS = [
    "founder@solvento.com",
    "cfo@startup.io",
    "partner@acme.org",
    "user@gmail.com",
]

_VALID_HYBRID_IDS = [
    "ANA-3kL9pZ",
    "ANA-000000",
    "ANA-AAAAAA",
    "ANA-zzzzzz",
    "FND-X7mQr2",
    "FND-AbCdEf",
    "FND-123456",
]

_INVALID_IDS = [
    "U001",
    "U002",
    "",
    None,
    "ANA-",
    "FND-",
    "ANA-12345",        # solo 5 chars
    "ANA-1234567",      # 7 chars
    "ANA-abc!ef",       # carácter no permitido
    "ana-AbCdEf",       # prefijo en minúscula
    "SOCIO-AbCdEf",     # prefijo inválido
    "ANA_AbCdEf",       # guión bajo en lugar de guión
    "ANA-Ab Cde",       # espacio
]


# ═══════════════════════════════════════════════════════════════════════════════
# generate_hybrid_id — prefijo correcto según dominio
# ═══════════════════════════════════════════════════════════════════════════════

class TestGenerateHybridIdPrefix:

    @pytest.mark.parametrize("email", _INTERNAL_EMAILS)
    def test_internal_domain_gets_ana_prefix(self, email: str) -> None:
        """Usuarios @cometa.* deben recibir el prefijo ANA-."""
        result = generate_hybrid_id(email)
        assert result.startswith("ANA-"), (
            f"Se esperaba prefijo ANA- para {email!r}, se obtuvo {result!r}"
        )

    @pytest.mark.parametrize("email", _EXTERNAL_EMAILS)
    def test_external_domain_gets_fnd_prefix(self, email: str) -> None:
        """Usuarios externos deben recibir el prefijo FND-."""
        result = generate_hybrid_id(email)
        assert result.startswith("FND-"), (
            f"Se esperaba prefijo FND- para {email!r}, se obtuvo {result!r}"
        )

    @pytest.mark.parametrize("email", _INTERNAL_EMAILS + _EXTERNAL_EMAILS)
    def test_output_matches_full_pattern(self, email: str) -> None:
        """Cualquier ID generado debe cumplir el patrón ^(ANA|FND)-[A-Za-z0-9]{6}$."""
        result = generate_hybrid_id(email)
        assert _HYBRID_PATTERN.match(result), (
            f"ID {result!r} no cumple el patrón para email {email!r}"
        )

    def test_suffix_is_exactly_6_chars(self) -> None:
        result = generate_hybrid_id("user@startup.com")
        suffix = result.split("-", 1)[1]
        assert len(suffix) == 6, f"El sufijo debe tener 6 chars, tiene {len(suffix)}"

    def test_suffix_is_alphanumeric_only(self) -> None:
        for _ in range(20):   # múltiples llamadas para mayor cobertura aleatoria
            result = generate_hybrid_id("user@startup.com")
            suffix = result.split("-", 1)[1]
            assert suffix.isalnum(), f"El sufijo {suffix!r} contiene chars no alfanuméricos"

    def test_email_without_at_sign_gets_fnd(self) -> None:
        """Email malformado (sin @) no debe romper la función — cae en FND-."""
        result = generate_hybrid_id("no-at-sign")
        assert result.startswith("FND-")

    def test_empty_email_gets_fnd(self) -> None:
        result = generate_hybrid_id("")
        assert result.startswith("FND-")

    def test_ids_are_not_always_identical(self) -> None:
        """La generación debe ser aleatoria: 50 llamadas no deben producir el mismo ID."""
        ids = {generate_hybrid_id("user@startup.com") for _ in range(50)}
        assert len(ids) > 1, "generate_hybrid_id parece no ser aleatoria"


# ═══════════════════════════════════════════════════════════════════════════════
# is_hybrid_id — reconocimiento de IDs válidos y legados
# ═══════════════════════════════════════════════════════════════════════════════

class TestIsHybridId:

    @pytest.mark.parametrize("hybrid_id", _VALID_HYBRID_IDS)
    def test_valid_hybrid_ids_are_accepted(self, hybrid_id: str) -> None:
        assert is_hybrid_id(hybrid_id) is True, (
            f"Se esperaba True para ID válido {hybrid_id!r}"
        )

    @pytest.mark.parametrize("bad_id", _INVALID_IDS)
    def test_invalid_and_legacy_ids_are_rejected(self, bad_id) -> None:
        assert is_hybrid_id(bad_id) is False, (
            f"Se esperaba False para ID inválido/legacy {bad_id!r}"
        )

    def test_generated_id_is_always_valid(self) -> None:
        """Todo ID producido por generate_hybrid_id debe pasar is_hybrid_id."""
        emails = _INTERNAL_EMAILS + _EXTERNAL_EMAILS
        for email in emails:
            generated = generate_hybrid_id(email)
            assert is_hybrid_id(generated), (
                f"ID generado {generated!r} no pasó is_hybrid_id para {email!r}"
            )
