"""Use the saved book association for one complete, unambiguous download."""

import re
from dataclasses import dataclass
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import select

from app.db.models import AcquisitionSelection, DownloadAttempt, Version
from app.domain.book_sources import identity
from app.domain.catalog_language import LANGUAGE_NAMES, language_name
from app.domain.catalog_titles import credit_key, display_title
from app.domain.release_profiles import indexer_title_authors, series_book_title
from app.domain.series_identity import title_outside_series_note
from app.domain.title_matching import compatible_title
from app.domain.work_graph import canonical_work
from app.importing.file_editions import attach_file_edition
from app.importing.match_evidence import group_evidence, language_key

MULTIPLE_IDENTIFIERS = "Multiple edition identifiers require review"
UNSUPPORTED_IDENTIFIERS = "Catalog identifiers do not support all embedded assertions"


def author_key(name):
    """Credits compare without punctuation or spacing: "Author A Example" is "Author A. Example"."""
    return credit_key(name)


def _authors(names):
    return sorted(author_key(name) for name in names)


def _file_conflicts(
    work, release, facts, *, series=(), reviewed_collection=False, verified_titles=()
):
    catalog = {"title": work.title, "authors": work.authors, "series": list(series)}
    credited = release.get("source") in {"audiobookbay", "prowlarr"}
    title_agrees = bool(facts.titles) and all(
        compatible_title(value, work.title, allow_extra_subtitle=reviewed_collection)
        or (title_outside_series_note(value, catalog) is not None)
        or value in verified_titles
        for value in facts.titles
    )
    authors = _authors(work.authors)
    conflicts = [("identifiers", issue) for issue in facts.issues]
    # Several ISBNs can describe formats of the same book. Independent title
    # and author tags can confirm a book request without selecting an edition.
    if title_agrees and authors and [_authors(names) for names in facts.authors] == [authors]:
        conflicts = [item for item in conflicts if item[1] != MULTIPLE_IDENTIFIERS]
    if facts.titles and not title_agrees:
        conflicts.append(("title", "The files name a different book"))
    if any(
        _authors(names) != authors
        and not (credited and title_agrees and set(authors) <= set(_authors(names)))
        for names in facts.authors
    ):
        conflicts.append(("authors", "The files name a different author"))
    if work.language and any(value != language_key(work.language) for value in facts.languages):
        conflicts.append(("language", "The files use a different language"))
    return conflicts


def request_file_conflicts(
    work, release, facts, *, series=(), reviewed_collection=False, verified_titles=()
):
    """Absent tags are neutral; contradictory tags need a different download or correction."""
    return [
        message
        for _, message in _file_conflicts(
            work,
            release,
            facts,
            series=series,
            reviewed_collection=reviewed_collection,
            verified_titles=verified_titles,
        )
    ]


def request_mismatches(work, release, facts, *, series=(), verified_titles=(), language=None):
    """Why the requested book cannot vouch for these files, as {field, message}.

    Empty means the release and the files agree with the request. `language` is the
    language the request expects when the catalog book does not record one.
    """
    found = [
        {"field": field, "message": message}
        for field, message in _file_conflicts(
            work, release, facts, series=series, verified_titles=verified_titles
        )
    ]

    def add(field, message):
        if not any(item["message"] == message for item in found):
            found.append({"field": field, "message": message})

    if work.metadata_fields.get("identity_rejected"):
        add("title", "This book's catalog identity was rejected; correct it before importing")
    title = display_title(work.title)
    authors = _authors(work.authors)
    if not title or not authors:
        add("title", "The catalog book has no title or author to compare with")
        return found
    catalog = {"title": work.title, "authors": work.authors, "series": list(series)}
    credited_source = release.get("source") in {"audiobookbay", "prowlarr"}
    file_titles_agree = bool(facts.titles) and all(
        compatible_title(value, work.title)
        or (title_outside_series_note(value, catalog) is not None)
        or value in verified_titles
        for value in facts.titles
    )
    file_authors_cover = bool(facts.authors) and all(
        set(authors) <= set(_authors(value)) for value in facts.authors
    )
    file_corroborated = file_titles_agree and file_authors_cover
    shown = display_title(release.get("title", ""))
    # Proxied releases with an exact catalog author/title pair can identify an
    # otherwise untagged download. The caller has verified the complete manifest.
    # ABB series/credit forms still need independent file corroboration.
    credited_release = (
        credited_source
        and (file_corroborated or release.get("source") == "prowlarr")
        and bool(
            indexer_title_authors(
                SimpleNamespace(
                    source=release["source"],
                    title=release.get("title", ""),
                    raw_title=release.get("raw_title") or release.get("title", ""),
                    authors=[],
                ),
                catalog if file_corroborated else {**catalog, "series": []},
            )
        )
    )
    if (
        not compatible_title(shown, work.title)
        and not credited_release
        # A source-only subtitle on a release at this book's own series position.
        and not series_book_title(release.get("title", ""), release, catalog)
    ):
        add("release_title", "The release has a different title")
    if facts.titles and not file_titles_agree:
        add("title", "The files name a different book")
    if any(
        _authors(value) != authors and not (credited_source and file_corroborated)
        for value in facts.authors
    ):
        add("authors", "The files name a different author")
    release_authors = _authors(release.get("authors", []))
    if release_authors and release_authors != authors:
        add("release_authors", "The release credits a different author")
    if not release_authors and not facts.authors and not credited_release:
        add("authors", "Neither the release nor the files name an author")
    expected = language_key(work.language or language or "")
    observed = {
        value
        for value in set(facts.languages)
        or ({language_key(release["language"])} if release.get("language") else set())
        # Unrecognized labels ("English (US)") stay neutral rather than hold a download.
        if value in LANGUAGE_NAMES or re.fullmatch(r"[a-z]{2}", value)
    }
    if expected and observed - {expected}:
        found_names = ", ".join(sorted(language_name(value) for value in observed - {expected}))
        add(
            "language",
            f"The {'files are' if facts.languages else 'release is'} in {found_names}, "
            f"but this request expects {language_name(expected)}",
        )
    return found


def agrees_with_request(work, release, facts, *, series=(), verified_titles=(), language=None):
    # Missing tags are common in M4B files. Conflicting tags still require review.
    return not request_mismatches(
        work, release, facts, series=series, verified_titles=verified_titles, language=language
    )


@dataclass(frozen=True)
class RequestFileMatch:
    work_id: UUID
    titles: tuple[str, ...]
    conflicts: list[str]
    agrees: bool
    mismatches: tuple[dict, ...] = ()
    language: str | None = None
    language_source: str | None = None


async def expected_language(db, work, selection):
    """The language a request expects: its own, the book's, else the catalog's primary."""
    requested = (selection.frozen.get("requirements") or {}).get("language")
    if requested:
        return requested, "request"
    if work.language:
        return work.language, "book"
    from app.domain.catalog_metadata import preferences

    return (await preferences(db)).language or None, "settings"


async def file_match(db, work, selection, inspection, group):
    """One request-scoped decision for automatic import, candidates and review."""
    facts = group_evidence(inspection.snapshot, group)
    catalog = {
        "title": work.title,
        "series": (await identity(db, work, selection.owner_id))["series"],
    }
    titles = tuple(
        value
        for value in facts.titles
        if compatible_title(value, work.title)
        or title_outside_series_note(value, catalog) is not None
    )
    if len(titles) != len(facts.titles):
        from app.importing.series_identity import corroborated_titles

        titles = await corroborated_titles(
            db, work, selection, inspection, group, facts, catalog["series"]
        )
    language, source = await expected_language(db, work, selection)
    options = {"series": catalog["series"], "verified_titles": titles}
    mismatches = request_mismatches(
        work, selection.frozen["release"], facts, **options, language=language
    )
    return RequestFileMatch(
        work.id,
        titles,
        request_file_conflicts(work, selection.frozen["release"], facts, **options),
        not mismatches,
        tuple(mismatches),
        language,
        source,
    )


async def inspection_match(db, inspection, group):
    row = (
        await db.execute(
            select(AcquisitionSelection, DownloadAttempt)
            .join(DownloadAttempt, DownloadAttempt.selection_id == AcquisitionSelection.id)
            .where(DownloadAttempt.inspection_id == inspection.id)
        )
    ).one_or_none()
    if not row:
        return None
    selection, attempt = row
    if selection.frozen.get("collection_review"):
        return None
    from app.domain import download_memberships

    if len(await download_memberships.for_attempt(db, attempt.id)) != 1:
        return None
    work = await canonical_work(db, UUID(selection.frozen["origin_work_id"]))
    return await file_match(db, work, selection, inspection, group)


# Disagreements a requester may confirm for their own request. Identifier problems
# and contradictory tags (conflicts) stay with administrators.
CONFIRMABLE = {"title", "authors", "language", "release_title", "release_authors"}


def confirmable(decision):
    """The fingerprint a requester confirms for these disagreements, or None."""
    from app.importing.naming import fingerprint

    if decision.agrees or decision.conflicts or not decision.mismatches:
        return None
    if any(item["field"] not in CONFIRMABLE for item in decision.mismatches):
        return None
    return fingerprint(sorted(item["message"] for item in decision.mismatches))


async def request_hold_reason(db, selection, inspection, group):
    """The first way the files or release disagree with the request, in plain words."""
    work = await canonical_work(db, UUID(selection.frozen["origin_work_id"]))
    decision = await file_match(db, work, selection, inspection, group)
    return decision.mismatches[0]["message"] if decision.mismatches else None


async def linked_version(
    db, approver, selection, inspection, group, grouping_revision, *, match, confirmed=None
):
    # Specific-edition requests must retain their stronger edition evidence.
    rule = selection.frozen["requirements"]
    if rule.get("version_id") or rule["medium"] != group.medium:
        return None
    work = await canonical_work(db, UUID(selection.frozen["origin_work_id"]))
    facts = group_evidence(inspection.snapshot, group)
    decision = await file_match(db, work, selection, inspection, group)
    # The requester confirmed exactly these disagreements for their own request.
    if not decision.agrees and not (confirmed and confirmable(decision) == confirmed):
        return None
    identified = [candidate for candidate in match.candidates if candidate.identifier_match]
    if identified:
        if MULTIPLE_IDENTIFIERS in facts.issues:
            # Preserve the assertions in the file-edition evidence, but do not
            # arbitrarily pick one ISBN's edition. Known identity or recording
            # conflicts still block the saved-book fallback.
            if any(
                candidate.work_id != work.id or set(candidate.conflicts) - {UNSUPPORTED_IDENTIFIERS}
                for candidate in identified
            ):
                return None
            version, _ = await attach_file_edition(
                db, approver, inspection.id, work.id, group.key, grouping_revision
            )
            return version
        # Missing tags do not undo the saved book selection. Keep the edition
        # when its identifier uniquely belongs to that book, but never erase
        # contradictory tags, another work, or an ambiguous identifier.
        missing = set()
        if not facts.titles:
            missing.add("Embedded title is missing or differs")
        if not facts.authors:
            missing.add("Embedded authors are missing or differ")
        if (
            len(identified) != 1
            or identified[0].work_id != work.id
            or set(identified[0].conflicts) - missing
        ):
            return None
        return await db.get(Version, identified[0].version_id)
    version, _ = await attach_file_edition(
        db, approver, inspection.id, work.id, group.key, grouping_revision
    )
    return version


async def linked_collection_version(
    db, approver, members, inspection, group, grouping_revision, match
):
    """Per-book file evidence must corroborate a reviewed collection mapping."""
    from pathlib import PurePosixPath

    group_paths = {f.path for f in group.files}
    eligible = []
    for member in members:
        review = member.frozen.get("collection_review")
        if not review:
            continue
        root = member.frozen["descriptor"]["name"]
        paths = {
            str(PurePosixPath(p).relative_to(root)) if p.startswith(root + "/") else p
            for p in review["paths"]
        }
        if paths == group_paths:
            eligible.append(member)
    if len(eligible) != 1:
        return None
    member = eligible[0]
    if (
        member.frozen["requirements"].get("version_id")
        or member.frozen["requirements"]["medium"] != group.medium
    ):
        return None
    work = await canonical_work(db, UUID(member.frozen["origin_work_id"]))
    facts = group_evidence(inspection.snapshot, group)
    # A filename or uploader claim cannot supply missing embedded identity here.
    if (
        not facts.titles
        or not facts.authors
        or work.metadata_fields.get("identity_rejected")
        or request_file_conflicts(work, member.frozen["release"], facts, reviewed_collection=True)
    ):
        return None
    identified = [c for c in match.candidates if c.identifier_match]
    if identified:
        if len(identified) != 1 or identified[0].work_id != work.id or identified[0].conflicts:
            return None
        return await db.get(Version, identified[0].version_id)
    version, _ = await attach_file_edition(
        db, approver, inspection.id, work.id, group.key, grouping_revision
    )
    return version
