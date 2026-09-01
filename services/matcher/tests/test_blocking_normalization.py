from samewise_matcher.blocking_normalization import (
    address_number,
    name_tokens,
    normalize_address,
    normalize_domain,
    normalize_email,
    normalize_name,
    normalize_phone,
    normalize_postal,
    normalize_text,
)


def test_text_normalization_is_unicode_aware_conservative_and_idempotent() -> None:
    normalized = normalize_text("  Ｎorthstar—Medical, Group  ")
    assert normalized == "northstar medical group"
    assert normalize_text(normalized) == normalized
    assert normalize_name("Northstar Medical Group") != normalize_name(
        "Northstar Medical Supply"
    )


def test_corporate_suffixes_are_removed_only_from_the_name_tail() -> None:
    assert name_tokens("Acme Services Incorporated") == ("acme", "services")
    assert normalize_name("Acme Corporation") == "acme"
    assert normalize_name("Corporation Supply") == "corporation supply"


def test_phone_email_domain_postal_and_address_normalization() -> None:
    assert normalize_phone("+1 (555) 010-1000") == "5550101000"
    assert normalize_phone("12") == ""
    assert normalize_email(" Accounts@Example.COM ") == "accounts@example.com"
    assert normalize_email("not-an-email") == ""
    assert normalize_domain("HTTPS://WWW.Example.COM/a?q=1") == "example.com"
    assert normalize_domain("") == ""
    assert normalize_postal("02110-1234") == "02110"
    assert normalize_address("100 Main Street") == "100 main st"
    assert address_number("100 Main St") == "100"


def test_missing_values_normalize_to_empty_not_a_shared_sentinel() -> None:
    assert {
        normalize_text(""),
        normalize_phone(""),
        normalize_email(""),
        normalize_domain(""),
        normalize_postal(""),
        normalize_address(""),
    } == {""}
