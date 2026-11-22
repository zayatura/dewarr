"""Equivalent language labels used by catalog display and ownership matching."""

import re

from sqlalchemy import case, func

# Library sources may use a language name, ISO 639-1, or ISO 639-2 code.
# Regional variants belong to editions of the same language; preserve unknown names.
LANGUAGE_ALIASES = {
    "english": "en",
    "eng": "en",
    "french": "fr",
    "fra": "fr",
    "fre": "fr",
    "german": "de",
    "deu": "de",
    "ger": "de",
    "spanish": "es",
    "spa": "es",
    "italian": "it",
    "ita": "it",
    "portuguese": "pt",
    "por": "pt",
    "dutch": "nl",
    "nld": "nl",
    "dut": "nl",
    "japanese": "ja",
    "jpn": "ja",
    "chinese": "zh",
    "zho": "zh",
    "chi": "zh",
    "russian": "ru",
    "rus": "ru",
    "arabic": "ar",
    "ara": "ar",
    "swedish": "sv",
    "swe": "sv",
    "danish": "da",
    "dan": "da",
    "norwegian": "no",
    "nor": "no",
    "finnish": "fi",
    "fin": "fi",
    "polish": "pl",
    "pol": "pl",
    "korean": "ko",
    "kor": "ko",
}

# Audio tags often name the language in that language ("Deutsch"). Kept apart from
# LANGUAGE_ALIASES, which also reads release titles, where these words can be titles.
NATIVE_LANGUAGE_NAMES = {
    "deutsch": "de",
    "français": "fr",
    "francais": "fr",
    "español": "es",
    "espanol": "es",
    "italiano": "it",
    "português": "pt",
    "portugues": "pt",
    "nederlands": "nl",
    "svenska": "sv",
    "dansk": "da",
    "norsk": "no",
    "suomi": "fi",
    "polski": "pl",
    "русский": "ru",
    "日本語": "ja",
    "中文": "zh",
    "한국어": "ko",
}

LANGUAGE_NAMES = {code: name.title() for name, code in LANGUAGE_ALIASES.items() if len(name) > 3}


def language_name(value):
    """A readable name for a language code or label, e.g. "de" -> "German"."""
    key = catalog_language(value)
    return LANGUAGE_NAMES.get(key or "", (value or "").strip()) or None


def catalog_language(value):
    value = " ".join((value or "").lower().split()).replace("_", "-")
    parts = value.split("-")
    base = LANGUAGE_ALIASES.get(parts[0]) or NATIVE_LANGUAGE_NAMES.get(parts[0], parts[0])
    # Script variants can be different readable editions, even within one language.
    if len(parts) > 1 and re.fullmatch(r"[a-z]{4}", parts[1]):
        return base + "-" + parts[1]
    return base or None


def catalog_language_sql(value):
    value = func.nullif(
        func.replace(func.lower(func.trim(func.regexp_replace(value, r"\s+", " ", "g"))), "_", "-"),
        "",
    )
    base = func.split_part(value, "-", 1)
    base = case({**NATIVE_LANGUAGE_NAMES, **LANGUAGE_ALIASES}, value=base, else_=base)
    script = func.split_part(value, "-", 2)
    return case((script.op("~")(r"^[a-z]{4}$"), base + "-" + script), else_=base)
