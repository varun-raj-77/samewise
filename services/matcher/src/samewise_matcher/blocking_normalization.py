"""Conservative, versioned normalization used only to form blocking keys."""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlsplit

NORMALIZATION_VERSION = "blocking-normalization-v0.1.0"

CORPORATE_SUFFIXES = frozenset(
    {
        "co",
        "company",
        "corp",
        "corporation",
        "inc",
        "incorporated",
        "llc",
        "ltd",
        "limited",
    }
)


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    normalized = re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE)
    return " ".join(normalized.split())


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", unicodedata.normalize("NFKC", value))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) >= 7 else ""


def normalize_email(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    normalized = re.sub(r"\s+", "", normalized)
    if normalized.count("@") != 1:
        return ""
    local, domain = normalized.split("@", maxsplit=1)
    return normalized if local and normalize_domain(domain) else ""


def email_domain(value: str) -> str:
    normalized = normalize_email(value)
    return normalized.rsplit("@", maxsplit=1)[1] if normalized else ""


def normalize_domain(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    if not normalized:
        return ""
    candidate = normalized if "://" in normalized else f"//{normalized}"
    parsed = urlsplit(candidate)
    host = (parsed.hostname or "").rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if not host or " " in host or "." not in host:
        return ""
    return host


def name_tokens(value: str) -> tuple[str, ...]:
    tokens = normalize_text(value).split()
    while tokens and tokens[-1] in CORPORATE_SUFFIXES:
        tokens.pop()
    return tuple(tokens)


def normalize_name(value: str) -> str:
    return " ".join(name_tokens(value))


def normalize_postal(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]", "", normalize_text(value))
    if len(normalized) >= 5 and normalized[:5].isdigit():
        return normalized[:5]
    return normalized


def normalize_address(value: str) -> str:
    tokens = normalize_text(value).split()
    replacements = {
        "avenue": "ave",
        "boulevard": "blvd",
        "drive": "dr",
        "road": "rd",
        "street": "st",
    }
    return " ".join(replacements.get(token, token) for token in tokens)


def address_number(value: str) -> str:
    normalized = normalize_address(value)
    first = normalized.split(maxsplit=1)[0] if normalized else ""
    return first if first.isdigit() else ""
