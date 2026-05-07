"""
fx_service.py
─────────────
Currency exchange service for the Cometa data contract.

Architecture
────────────
  FxProvider (Protocol)
    └─ StaticFxProvider          — annual-average rates in RATE_TABLE (zero deps)
    └─ ExchangeRateApiProvider   — TODO: live/historical via exchangerate-api.com

The active provider is returned by get_fx_provider().
To switch to live rates: implement ExchangeRateApiProvider and swap the
return value in get_fx_provider() — no other file needs to change.

Rate convention
───────────────
All rates: units_of_foreign_currency per 1 USD  (USD as base).

  RATE_TABLE["MXN"][2025] = 17.80  →  1 USD = 17.80 MXN
  RATE_TABLE["EUR"][2025] = 0.910  →  1 USD = 0.91  EUR

Conversion:
  to_usd(amount_foreign, currency, year) = amount_foreign / rate

Sources
───────
Annual average rates sourced from IMF World Economic Outlook + US Federal
Reserve historical data. Update RATE_TABLE each January for the prior year.
"""

from __future__ import annotations

import logging
from typing import Optional, Protocol

logger = logging.getLogger(__name__)


# ── Annual-average rate table ─────────────────────────────────────────────────
# Extend this dict to add new currencies. Adding a row here is the ONLY change
# needed to support a new currency end-to-end.

RATE_TABLE: dict[str, dict[int, float]] = {
    # ── Latin America ─────────────────────────────────────────────────────────
    "MXN": {
        2019: 19.26, 2020: 21.49, 2021: 20.27,
        2022: 20.12, 2023: 17.18, 2024: 17.15, 2025: 17.80,
    },
    "BRL": {
        2019:  3.94, 2020:  5.39, 2021:  5.40,
        2022:  5.17, 2023:  4.99, 2024:  5.10, 2025:  5.25,
    },
    "COP": {
        2019: 3281,  2020: 3694,  2021: 3743,
        2022: 4255,  2023: 4325,  2024: 4150,  2025: 4350,
    },
    "ARS": {
        2019:   48.2, 2020:   70.5, 2021:   95.1,
        2022:  130.8, 2023:  350.0, 2024:  900.0, 2025: 1100.0,
    },
    "CLP": {
        2019:  703,   2020:  792,   2021:  759,
        2022:  874,   2023:  840,   2024:  920,   2025:  960,
    },
    "PEN": {
        2019: 3.34, 2020: 3.49, 2021: 3.88,
        2022: 3.84, 2023: 3.74, 2024: 3.80, 2025: 3.85,
    },
    # ── Europe ────────────────────────────────────────────────────────────────
    "EUR": {
        2019: 0.893, 2020: 0.877, 2021: 0.846,
        2022: 0.951, 2023: 0.924, 2024: 0.925, 2025: 0.910,
    },
    "GBP": {
        2019: 0.784, 2020: 0.780, 2021: 0.727,
        2022: 0.812, 2023: 0.804, 2024: 0.790, 2025: 0.785,
    },
    # ── Other majors ──────────────────────────────────────────────────────────
    "CAD": {
        2019: 1.327, 2020: 1.341, 2021: 1.254,
        2022: 1.301, 2023: 1.350, 2024: 1.360, 2025: 1.380,
    },
    "JPY": {
        2019: 109.0, 2020: 106.8, 2021: 109.8,
        2022: 131.5, 2023: 140.5, 2024: 149.7, 2025: 152.0,
    },
    # USD is always the base: identity rate
    "USD": {year: 1.0 for year in range(2019, 2031)},
}


# ── Provider protocol (interface contract) ────────────────────────────────────

class FxProvider(Protocol):
    """
    Interface for FX rate providers.
    Any class that implements get_rate + to_usd satisfies this protocol.
    """

    def get_rate(self, currency: str, year: int) -> Optional[float]:
        """
        Return the annual-average rate for `currency` in `year`,
        expressed as units-of-currency per 1 USD.
        Returns None if the pair/year is unavailable.
        """
        ...

    def to_usd(self, amount: float, currency: str, year: int) -> Optional[float]:
        """
        Convert `amount` expressed in `currency` to USD.
        Returns None if the rate is unavailable.
        """
        ...


# ── Static provider (default) ─────────────────────────────────────────────────

class StaticFxProvider:
    """
    Hard-coded annual-average rates from RATE_TABLE.
    Zero external dependencies — works offline and in CI.

    Nearest-year fallback: if a rate for the exact year is missing,
    uses the closest available year and logs a warning.
    """

    def get_rate(self, currency: str, year: int) -> Optional[float]:
        key = currency.upper().strip()
        if key not in RATE_TABLE:
            logger.warning(
                "[FX] Unknown currency '%s' — skipping USD conversion. "
                "Add it to RATE_TABLE in fx_service.py to enable support.",
                currency,
            )
            return None

        year_rates = RATE_TABLE[key]

        if year in year_rates:
            return year_rates[year]

        # Nearest-year fallback
        nearest = min(year_rates.keys(), key=lambda y: abs(y - year))
        rate    = year_rates[nearest]
        logger.warning(
            "[FX] Rate for %s/%d not found — using %d as nearest available year "
            "(rate=%.4f). Add year %d to RATE_TABLE for exact conversion.",
            key, year, nearest, rate, year,
        )
        return rate

    def to_usd(self, amount: float, currency: str, year: int) -> Optional[float]:
        key  = currency.upper().strip()
        rate = self.get_rate(key, year)
        if rate is None:
            return None
        if rate == 0.0:
            logger.error(
                "[FX] Rate for %s/%d is zero — USD conversion aborted.", key, year
            )
            return None
        return round(amount / rate, 6)

    def supported_currencies(self) -> list[str]:
        """Returns the sorted list of ISO codes with at least one rate entry."""
        return sorted(RATE_TABLE.keys())


# ── Future: live API provider ─────────────────────────────────────────────────

class ExchangeRateApiProvider:
    """
    TODO: Live and historical rates via exchangerate-api.com.

    Implementation checklist:
      1.  pip install httpx (async) or requests (sync)
      2.  Set env var:  EXCHANGE_RATE_API_KEY=<your key>
      3.  Endpoint for annual average:
            GET https://v6.exchangerate-api.com/v6/{key}/history/USD/{year}/{month}/{day}
          Fetch 12 monthly snapshots and average them for the annual rate.
      4.  Cache results in a local dict or Redis to avoid redundant API calls.
          Rates for closed years never change — cache them permanently.
      5.  Maintain the same rate convention (units-of-foreign per 1 USD) so
          to_usd() math stays identical to StaticFxProvider.
      6.  Swap get_fx_provider() below to return ExchangeRateApiProvider().

    No other file outside fx_service.py needs to change.
    """

    def get_rate(self, currency: str, year: int) -> Optional[float]:
        raise NotImplementedError(
            "ExchangeRateApiProvider is not yet implemented. "
            "Set EXCHANGE_RATE_API_KEY and complete the TODO above."
        )

    def to_usd(self, amount: float, currency: str, year: int) -> Optional[float]:
        raise NotImplementedError


# ── Factory ───────────────────────────────────────────────────────────────────

def get_fx_provider() -> StaticFxProvider:
    """
    Returns the active FX provider instance.

    To switch to live rates:
      1. Implement ExchangeRateApiProvider above.
      2. Change the return to: return ExchangeRateApiProvider()
    """
    return StaticFxProvider()
