from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.importing.linked_download import agrees_with_request
from app.importing.match_evidence import MatchEvidence


@pytest.mark.parametrize(
    "change",
    [None, "missing-title", "missing-author", "wrong-author", "wrong-title", "invalid", "rejected"],
)
def test_multiple_isbns_need_independent_book_identity(change):
    from app.importing.linked_download import MULTIPLE_IDENTIFIERS

    work = SimpleNamespace(
        title="First Harbor",
        authors=["Alex Morgan"],
        language="en",
        metadata_fields={"identity_rejected": change == "rejected"},
    )
    facts = MatchEvidence(
        titles=[]
        if change == "missing-title"
        else ["other book" if change == "wrong-title" else "first harbor"],
        authors=[]
        if change == "missing-author"
        else [["other author" if change == "wrong-author" else "alex morgan"]],
        identifiers=[
            {"namespace": "isbn", "value": "9781234567897"},
            {"namespace": "isbn", "value": "9780306406157"},
        ],
        issues=[MULTIPLE_IDENTIFIERS]
        + (["An embedded edition identifier is invalid"] if change == "invalid" else []),
    )
    assert agrees_with_request(work, {"title": work.title, "authors": work.authors}, facts) is (
        change is None
    )


@pytest.mark.parametrize(
    "case", ["same-book", "other-book", "pending", "specific-edition", "ambiguous"]
)
async def test_multiple_isbns_do_not_override_catalog_conflicts(monkeypatch, case):
    from app.importing import linked_download

    work = SimpleNamespace(
        id=uuid4(), title="First Harbor", authors=["Alex Morgan"], language="en", metadata_fields={}
    )
    facts = MatchEvidence(
        titles=["first harbor"],
        authors=[["alex morgan"]],
        issues=[linked_download.MULTIPLE_IDENTIFIERS],
    )
    candidate = SimpleNamespace(
        identifier_match=True,
        work_id=uuid4() if case == "other-book" else work.id,
        conflicts=["Resolve this catalog version's pending metadata conflict"]
        if case == "pending"
        else [linked_download.UNSUPPORTED_IDENTIFIERS],
    )
    selection = SimpleNamespace(
        owner_id=uuid4(),
        frozen={
            "origin_work_id": str(work.id),
            "requirements": {
                "medium": "ebook",
                "version_id": str(uuid4()) if case == "specific-edition" else None,
            },
            "release": {"title": work.title, "authors": work.authors},
        },
    )
    version = SimpleNamespace(id=uuid4())
    attach = AsyncMock(return_value=(version, True))
    monkeypatch.setattr(linked_download, "canonical_work", AsyncMock(return_value=work))
    monkeypatch.setattr(linked_download, "identity", AsyncMock(return_value={"series": []}))
    monkeypatch.setattr(linked_download, "group_evidence", lambda *args: facts)
    monkeypatch.setattr(linked_download, "attach_file_edition", attach)
    result = await linked_download.linked_version(
        AsyncMock(),
        None,
        selection,
        SimpleNamespace(id=uuid4(), snapshot={}),
        SimpleNamespace(key="book", medium="ebook"),
        "revision",
        match=SimpleNamespace(
            candidates=[candidate, candidate] if case == "ambiguous" else [candidate]
        ),
    )
    accepted = case in {"same-book", "ambiguous"}
    assert result is (version if accepted else None)
    assert attach.await_count == int(accepted)


def test_proxied_author_title_names_identify_untagged_completed_audio():
    work = SimpleNamespace(
        title="The Anxious Generation: A Descriptive Subtitle",
        authors=["Jonathan Haidt"],
        language="en",
        metadata_fields={},
    )
    release = {
        "source": "prowlarr",
        "title": "Jonathan.Haidt-The.Anxious.Generation",
        "authors": [],
    }
    assert agrees_with_request(work, release, MatchEvidence())
    assert not agrees_with_request(work, release, MatchEvidence(titles=["Other Book"]))
    assert not agrees_with_request(work, release, MatchEvidence(authors=[["other writer"]]))
    assert not agrees_with_request(
        work, {**release, "title": "Someone.Else-The.Anxious.Generation"}, MatchEvidence()
    )
    assert not agrees_with_request(
        work,
        {**release, "title": "Modern Childhood 2 - Jonathan Haidt"},
        MatchEvidence(),
        series=[{"name": "Modern Childhood", "position": "2"}],
    )


@pytest.mark.parametrize(
    "facts",
    [
        MatchEvidence(),
        MatchEvidence(titles=["project hail mary"], authors=[["andy weir"]]),
        MatchEvidence(identifiers=[{"namespace": "asin", "value": "B012345678"}]),
    ],
)
def test_linked_book_does_not_need_embedded_edition_identifier(facts):
    work = SimpleNamespace(
        title="Project Hail Mary", authors=["Andy Weir"], language="en", metadata_fields={}
    )
    assert agrees_with_request(work, {"title": work.title, "authors": work.authors}, facts)


@pytest.mark.parametrize(
    "facts",
    [
        MatchEvidence(titles=["another book"]),
        MatchEvidence(authors=[["another author"]]),
        MatchEvidence(languages=["fr"]),
        MatchEvidence(issues=["Files disagree about narrator"]),
    ],
)
def test_linked_book_preserves_conflicting_file_metadata(facts):
    work = SimpleNamespace(
        title="Project Hail Mary", authors=["Andy Weir"], language="en", metadata_fields={}
    )
    assert not agrees_with_request(work, {"title": work.title, "authors": work.authors}, facts)


@pytest.mark.parametrize(
    ("catalog_title", "release_title", "file_title", "expected"),
    [
        ("Atmosphere: A Love Story", "Atmosphere", "Atmosphere: A Love Story", True),
        ("Atmosphere: A Love Story", "Atmosphere", "Atmosphere", True),
        ("Atmosphere: A Love Story", "Atmosphere", "Atmosphere: Another Story", False),
        ("Atmosphere: A Love Story", "Atmosphere: Another Story", "Atmosphere", False),
        ("Atmosphere: A Love Story", "Atmosphere", "Atmosphere (1 of 2)", False),
        ("Atmosphere: Volume Two", "Atmosphere", "Atmosphere", False),
        ("Atmosphere: A Love Story", "Atmosphere", "Atmosphere: A Study Guide", False),
    ],
)
def test_linked_download_accepts_omitted_subtitle_but_not_conflicting_content(
    catalog_title, release_title, file_title, expected
):
    work = SimpleNamespace(
        title=catalog_title, authors=["Taylor Jenkins Reid"], language="en", metadata_fields={}
    )
    facts = MatchEvidence(titles=[file_title], authors=[["taylor jenkins reid"]])
    assert (
        agrees_with_request(work, {"title": release_title, "authors": work.authors}, facts)
        is expected
    )


def test_audiobookbay_credit_and_leading_file_title_can_link_the_download():
    work = SimpleNamespace(title="Lantern", authors=["Writer"], language="en", metadata_fields={})
    facts = MatchEvidence(
        titles=["Lantern: North Sea, Book 5"],
        authors=[["reader", "writer"]],
    )
    assert agrees_with_request(
        work,
        {"source": "audiobookbay", "title": "North Sea 5 - Writer, Reader", "authors": []},
        facts,
        series=[{"name": "North Sea", "position": "5"}],
    )
    assert agrees_with_request(
        work,
        {"source": "audiobookbay", "title": "Lantern - Writer, Reader", "authors": ["Writer"]},
        MatchEvidence(titles=["Lantern"], authors=[["writer"]]),
    )
    assert not agrees_with_request(
        work,
        {"title": "North Sea 5 - Writer, Reader", "authors": []},
        MatchEvidence(titles=["Other Book: North Sea, Book 5"], authors=[["reader", "writer"]]),
    )


@pytest.mark.parametrize(
    ("release_title", "file_title"),
    [
        ("Lantern - Writer, Reader", "Lantern: A Study Guide"),
        ("Lantern - Writer, Reader", "Lantern: Another Story"),
        ("Another Book - Writer, Reader", "Lantern"),
        ("North Sea 4 - Writer, Reader", "Lantern: North Sea, Book 5"),
    ],
)
def test_abb_link_keeps_conflicting_content_held(release_title, file_title):
    work = SimpleNamespace(title="Lantern", authors=["Writer"], language="en", metadata_fields={})
    assert not agrees_with_request(
        work,
        {"source": "audiobookbay", "title": release_title, "authors": []},
        MatchEvidence(titles=[file_title], authors=[["writer"]]),
        series=[{"name": "North Sea", "position": "5"}],
    )


@pytest.mark.parametrize(
    ("file_title", "file_authors", "expected"),
    [
        ("Lantern: A Light: North Sea, Book 5", ["co writer", "writer"], True),
        ("Lantern: A Light (The North Sea Trilogy)", ["writer"], True),
        ("Lantern: A Light: North Sea, Book 5.5", ["writer"], False),
        ("Lantern: A Light: Other Coast, Book 5", ["writer"], False),
        ("Lantern: A Different Light", ["writer"], False),
        ("Lantern: A Light: A Study Guide", ["writer"], False),
        ("Lantern: A Light", ["other writer"], False),
    ],
)
def test_abb_link_requires_known_annotation_after_the_full_title(
    file_title, file_authors, expected
):
    work = SimpleNamespace(
        title="Lantern: A Light", authors=["Writer"], language="en", metadata_fields={}
    )
    assert (
        agrees_with_request(
            work,
            {"source": "audiobookbay", "title": "North Sea 5 - Writer, Reader", "authors": []},
            MatchEvidence(titles=[file_title], authors=[file_authors]),
            series=[{"name": "North Sea", "position": "5"}],
        )
        is expected
    )


@pytest.mark.parametrize(
    "facts",
    [MatchEvidence(), MatchEvidence(titles=["Lantern"]), MatchEvidence(authors=[["writer"]])],
)
def test_new_credit_forms_need_independent_title_and_author_tags(facts):
    work = SimpleNamespace(title="Lantern", authors=["Writer"], language="en", metadata_fields={})
    assert not agrees_with_request(
        work,
        {"source": "audiobookbay", "title": "Lantern - Writer, Reader", "authors": ["Writer"]},
        facts,
    )


@pytest.mark.parametrize(
    "case",
    [
        "corroborated",
        "missing-title",
        "missing-author",
        "wrong-author",
        "wrong-title",
        "wrong-language",
        "extra-file",
        "overlap",
        "rejected-identity",
        "conflicting-isbn",
    ],
)
async def test_reviewed_collection_mapping_requires_independent_file_identity(monkeypatch, case):
    from app.importing import linked_download

    work = SimpleNamespace(
        id=uuid4(),
        title="Angels & Demons",
        authors=["Dan Brown"],
        language="en",
        metadata_fields={"identity_rejected": case == "rejected-identity"},
    )
    facts = MatchEvidence(
        titles=[]
        if case == "missing-title"
        else ["Inferno" if case == "wrong-title" else "Angels and Demons"],
        authors=[]
        if case == "missing-author"
        else [["other writer" if case == "wrong-author" else "dan brown"]],
        languages=["fr" if case == "wrong-language" else "en"],
    )
    member = SimpleNamespace(
        frozen={
            "collection_review": {"paths": ["pack/book.epub"]},
            "descriptor": {"name": "pack"},
            "origin_work_id": str(work.id),
            "requirements": {"medium": "ebook"},
            "release": {"title": "Dan Brown collection", "authors": ["Dan Brown"]},
        }
    )
    group = SimpleNamespace(
        key="one",
        medium="ebook",
        files=[
            SimpleNamespace(path=p)
            for p in (["book.epub", "extra.epub"] if case == "extra-file" else ["book.epub"])
        ],
    )
    match = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                identifier_match=True,
                work_id=uuid4(),
                conflicts=[],
            )
        ]
        if case == "conflicting-isbn"
        else []
    )
    version = SimpleNamespace(id=uuid4(), work_id=work.id)
    attach = AsyncMock(return_value=(version, None))
    monkeypatch.setattr(linked_download, "canonical_work", AsyncMock(return_value=work))
    monkeypatch.setattr(linked_download, "group_evidence", lambda *args: facts)
    monkeypatch.setattr(linked_download, "attach_file_edition", attach)
    result = await linked_download.linked_collection_version(
        AsyncMock(),
        None,
        [member, member] if case == "overlap" else [member],
        SimpleNamespace(id=uuid4(), snapshot={}),
        group,
        "revision",
        match,
    )
    assert result is (version if case == "corroborated" else None)
    assert attach.await_count == (1 if case == "corroborated" else 0)


def test_author_punctuation_does_not_hold_a_matching_download():
    work = SimpleNamespace(
        title="Harbor Lights", authors=["Author A. Example"], language=None, metadata_fields={}
    )
    release = {"source": "mam", "title": "Harbor Lights", "authors": ["Author A Example"]}
    facts = MatchEvidence(titles=["harbor lights"], authors=[["author a. example"]])
    assert agrees_with_request(work, release, facts, language="en")


def test_request_language_holds_files_in_another_language():
    from app.importing.linked_download import request_mismatches
    from app.importing.match_evidence import language_key

    work = SimpleNamespace(
        title="Harbor Lights", authors=["Author A"], language=None, metadata_fields={}
    )
    release = {"source": "mam", "title": "Harbor Lights", "authors": ["Author A"]}
    facts = MatchEvidence(
        titles=["harbor lights"], authors=[["author a"]], languages=[language_key("Deutsch")]
    )
    assert request_mismatches(work, release, facts, language="en") == [
        {
            "field": "language",
            "message": "The files are in German, but this request expects English",
        }
    ]
    # Without an expected language, or with an unrecognized tag, language stays neutral.
    assert agrees_with_request(work, release, facts)
    unknown = facts.model_copy(update={"languages": ["english (us)"]})
    assert agrees_with_request(work, release, unknown, language="en")
    # Untagged files fall back to the language the source listed.
    listed = {**release, "language": "GER"}
    assert (
        request_mismatches(work, listed, MatchEvidence(titles=["harbor lights"]), language="en")[0][
            "message"
        ]
        == "The release is in German, but this request expects English"
    )


@pytest.mark.parametrize("label", ["HUN", "hun", "hu", "Hungarian", "Magyar", "hu-HU"])
def test_every_form_of_a_language_matches_the_picker_code(label):
    from app.domain.acquisition import language_accepts
    from app.importing.match_evidence import language_key

    # MAM lists "HUN", tags say "Magyar", and requests store the picker's "hu".
    assert language_accepts("hu", label)
    assert not language_accepts("en", label)
    assert language_key(label) == "hu"


def test_hungarian_files_satisfy_a_hungarian_request_and_hold_an_english_one():
    from app.importing.linked_download import request_mismatches
    from app.importing.match_evidence import language_key

    work = SimpleNamespace(
        title="Harbor Lights", authors=["Author A"], language=None, metadata_fields={}
    )
    release = {"source": "mam", "title": "Harbor Lights", "authors": ["Author A"]}
    facts = MatchEvidence(
        titles=["harbor lights"], authors=[["author a"]], languages=[language_key("Magyar")]
    )
    assert agrees_with_request(work, release, facts, language="hu")
    assert request_mismatches(work, release, facts, language="en") == [
        {
            "field": "language",
            "message": "The files are in Hungarian, but this request expects English",
        }
    ]


@pytest.mark.parametrize(("position", "agrees"), [("6", True), ("5", False), (None, False)])
def test_release_subtitle_at_the_books_series_position_does_not_hold_the_import(position, agrees):
    work = SimpleNamespace(
        title="Harbor Lights", authors=["Author A"], language=None, metadata_fields={}
    )
    release = {
        "source": "mam",
        "title": "Harbor Lights: The Harbor Cycle, Part One",
        "authors": ["Author A"],
        "series": [{"name": "Coast", "position": position, "source_id": "1"}] if position else [],
    }
    facts = MatchEvidence(titles=["harbor lights"], authors=[["author a"]])
    assert (
        agrees_with_request(
            work, release, facts, series=[{"name": "Coast", "position": "6"}], language="en"
        )
        is agrees
    )


def test_requesters_confirm_only_title_author_and_language_differences():
    from app.importing.linked_download import RequestFileMatch, confirmable

    def decision(*fields, conflicts=()):
        return RequestFileMatch(
            uuid4(),
            (),
            list(conflicts),
            not fields,
            tuple({"field": field, "message": f"{field} differs"} for field in fields),
        )

    assert confirmable(decision("language")) == confirmable(decision("language"))
    assert confirmable(decision("language", "release_title"))
    assert confirmable(decision("language")) != confirmable(decision("release_title"))
    assert confirmable(decision()) is None
    assert confirmable(decision("identifiers")) is None
    assert (
        confirmable(decision("language", conflicts=["The files use a different language"])) is None
    )


def test_resolving_own_reviews_keeps_the_member_label():
    from app.domain import permissions

    user = SimpleNamespace(active=True, role="member", can_automate=False)
    user.permissions = permissions.MEMBER | permissions.REVIEW_OWN_DOWNLOADS
    assert permissions.access_label(user) == "Member"
    assert permissions.has(user, permissions.REVIEW_OWN_DOWNLOADS)
    user.permissions = permissions.MEMBER
    assert not permissions.has(user, permissions.REVIEW_OWN_DOWNLOADS)
