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

# Every language in the web language picker: its ISO 639-1 code, ISO 639-2 codes
# (bibliographic and terminology) and English name, so "hun", "HUN" and "Hungarian"
# all equal the picker's "hu". Release-title parsing keeps the shorter list above.
LANGUAGES = {
    "en": ("eng", "English"),
    "es": ("spa", "Spanish"),
    "fr": ("fre fra", "French"),
    "de": ("ger deu", "German"),
    "it": ("ita", "Italian"),
    "pt": ("por", "Portuguese"),
    "nl": ("dut nld", "Dutch"),
    "da": ("dan", "Danish"),
    "sv": ("swe", "Swedish"),
    "no": ("nor nob nno", "Norwegian"),
    "fi": ("fin", "Finnish"),
    "is": ("ice isl", "Icelandic"),
    "pl": ("pol", "Polish"),
    "cs": ("cze ces", "Czech"),
    "sk": ("slo slk", "Slovak"),
    "hu": ("hun", "Hungarian"),
    "ro": ("rum ron", "Romanian"),
    "bg": ("bul", "Bulgarian"),
    "el": ("gre ell", "Greek"),
    "uk": ("ukr", "Ukrainian"),
    "ru": ("rus", "Russian"),
    "tr": ("tur", "Turkish"),
    "ar": ("ara", "Arabic"),
    "he": ("heb", "Hebrew"),
    "fa": ("per fas", "Persian"),
    "hi": ("hin", "Hindi"),
    "bn": ("ben", "Bengali"),
    "ta": ("tam", "Tamil"),
    "te": ("tel", "Telugu"),
    "ur": ("urd", "Urdu"),
    "id": ("ind", "Indonesian"),
    "ms": ("may msa", "Malay"),
    "vi": ("vie", "Vietnamese"),
    "th": ("tha", "Thai"),
    "ko": ("kor", "Korean"),
    "ja": ("jpn", "Japanese"),
    "zh": ("chi zho", "Chinese"),
    "sw": ("swa", "Swahili"),
    "af": ("afr", "Afrikaans"),
    "sq": ("alb sqi", "Albanian"),
    "am": ("amh", "Amharic"),
    "hy": ("arm hye", "Armenian"),
    "az": ("aze", "Azerbaijani"),
    "eu": ("baq eus", "Basque"),
    "be": ("bel", "Belarusian"),
    "bs": ("bos", "Bosnian"),
    "ca": ("cat", "Catalan"),
    "et": ("est", "Estonian"),
    "fil": ("tgl", "Filipino"),
    "gl": ("glg", "Galician"),
    "ka": ("geo kat", "Georgian"),
    "gu": ("guj", "Gujarati"),
    "hr": ("hrv", "Croatian"),
    "kk": ("kaz", "Kazakh"),
    "km": ("khm", "Khmer"),
    "kn": ("kan", "Kannada"),
    "ky": ("kir", "Kyrgyz"),
    "lo": ("lao", "Lao"),
    "lt": ("lit", "Lithuanian"),
    "lv": ("lav", "Latvian"),
    "mk": ("mac mkd", "Macedonian"),
    "ml": ("mal", "Malayalam"),
    "mn": ("mon", "Mongolian"),
    "mr": ("mar", "Marathi"),
    "my": ("bur mya", "Burmese"),
    "ne": ("nep", "Nepali"),
    "pa": ("pan", "Punjabi"),
    "si": ("sin", "Sinhala"),
    "sl": ("slv", "Slovenian"),
    "sr": ("srp", "Serbian"),
    "so": ("som", "Somali"),
    "uz": ("uzb", "Uzbek"),
    "zu": ("zul", "Zulu"),
}

# Audio tags often name the language in that language ("Deutsch", "Magyar").
NATIVE_LANGUAGE_NAMES = {
    "deutsch": "de",
    "magyar": "hu",
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
    "íslenska": "is",
    "polski": "pl",
    "čeština": "cs",
    "slovenčina": "sk",
    "română": "ro",
    "romana": "ro",
    "türkçe": "tr",
    "hrvatski": "hr",
    "srpski": "sr",
    "slovenščina": "sl",
    "eesti": "et",
    "latviešu": "lv",
    "lietuvių": "lt",
    "català": "ca",
    "euskara": "eu",
    "galego": "gl",
    "русский": "ru",
    "українська": "uk",
    "български": "bg",
    "ελληνικά": "el",
    "עברית": "he",
    "العربية": "ar",
    "日本語": "ja",
    "中文": "zh",
    "한국어": "ko",
}

LANGUAGE_CODES = {
    alias: code
    for code, (codes, name) in LANGUAGES.items()
    for alias in (code, *codes.split(), name.casefold())
}
LANGUAGE_CODES.update(NATIVE_LANGUAGE_NAMES)
LANGUAGE_NAMES = {code: name for code, (_, name) in LANGUAGES.items()}


def language_code(value):
    """The picker's code for a code or name in any of the forms above, else None."""
    return LANGUAGE_CODES.get(" ".join((value or "").casefold().split()))


def language_name(value):
    """A readable name for a language code or label, e.g. "de" -> "German"."""
    key = catalog_language(value)
    return LANGUAGE_NAMES.get(key or "", (value or "").strip()) or None


def catalog_language(value):
    value = " ".join((value or "").lower().split()).replace("_", "-")
    parts = value.split("-")
    base = LANGUAGE_ALIASES.get(parts[0]) or LANGUAGE_CODES.get(parts[0], parts[0])
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
    base = case({**LANGUAGE_CODES, **LANGUAGE_ALIASES}, value=base, else_=base)
    script = func.split_part(value, "-", 2)
    return case((script.op("~")(r"^[a-z]{4}$"), base + "-" + script), else_=base)
