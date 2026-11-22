"""A requester's own view of a held download: why it stopped and what they can do.

Requesters with "Resolve own download reviews" can confirm that the files are the
book they asked for when only the title, author or language differs. The import then
runs again under the administrator's automatic-import approval; problems with the
files themselves stay with administrators.
"""

from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import Database, Member
from app.api.imports import ReleaseListing, RequestMismatch, listing
from app.db.models import (
    AuditEvent,
    AutomaticImport,
    DownloadAttempt,
    DownloadInspection,
    DownloadRecovery,
    ImportDestination,
    Library,
    LibraryGrant,
)
from app.domain.permissions import REVIEW_OWN_DOWNLOADS, has

router = APIRouter(prefix="/acquisition/downloads", tags=["downloads"])

# The tags a requester may see; server paths and hashes stay private.
TAGS = ("album", "title", "artist", "album_artist", "narrator", "composer", "language")


class ReviewFile(BaseModel):
    path: str
    medium: str | None = None
    technical: dict = Field(default_factory=dict)
    metadata: dict = Field(default_factory=dict)


class Identifier(BaseModel):
    namespace: str
    value: str


class OwnReviewView(BaseModel):
    attempt_id: UUID
    selection_id: UUID
    work_id: UUID
    title: str
    authors: list[str]
    medium: str
    message: str
    # Reject through the existing report: block the release and search again.
    can_reject: bool
    mismatches: list[RequestMismatch] = Field(default_factory=list)
    expected_language: str | None = None
    expected_language_source: str | None = None
    release: ReleaseListing | None = None
    files: list[ReviewFile] = Field(default_factory=list)
    identifiers: list[Identifier] = Field(default_factory=list)
    library: str | None = None
    can_add: bool = False
    # Why "Add to library" is not offered, in plain words.
    add_unavailable: str | None = None
    # What the requester confirms; stale confirmations are refused.
    confirmation: str | None = None


class AcceptInput(BaseModel):
    confirmation: str = Field(min_length=1, max_length=128)


async def own_held_download(db, user, attempt_id):
    """The requester's selection in a held download, or 404 for anyone else."""
    from app.domain import download_memberships

    attempt = await db.get(DownloadAttempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "Download not found")
    members = await download_memberships.for_attempt(db, attempt.id)
    selection = next((item for item in members if item.owner_id == user.id), None)
    automatic = await db.scalar(
        select(AutomaticImport).where(AutomaticImport.attempt_id == attempt.id)
    )
    if not selection or not automatic:
        raise HTTPException(404, "Download not found")
    return attempt, selection, automatic, members


async def assess(db, user, attempt, selection, automatic, members):
    """What the requester may do, with the evidence the review shows."""
    from app.domain.catalog_language import language_name
    from app.domain.download_reviews import has_imports
    from app.domain.work_graph import canonical_work
    from app.importing.grouping import current_grouping
    from app.importing.linked_download import confirmable, file_match
    from app.importing.match_evidence import group_evidence

    work = await canonical_work(db, UUID(selection.frozen["origin_work_id"]))
    replaced = await db.scalar(
        select(DownloadRecovery.id).where(DownloadRecovery.selection_id == selection.id)
    )
    importing = bool(attempt.inspection_id and await has_imports(db, attempt.inspection_id))
    held = (
        attempt.state == "complete"
        and automatic.state == "held"
        and not automatic.import_run_id
        and not automatic.evidence.get("release_rejection")
        and not replaced
        and not importing
    )
    view = OwnReviewView(
        attempt_id=attempt.id,
        selection_id=selection.id,
        work_id=work.id,
        title=work.title,
        authors=work.authors,
        medium=selection.frozen["requirements"]["medium"],
        message=automatic.message,
        can_reject=bool(attempt.state == "complete" and not replaced and not importing),
        release=listing(selection.frozen.get("release") or {}),
    )
    destination = await db.get(ImportDestination, selection.destination_id)
    library = await db.get(Library, destination.library_id) if destination else None
    view.library = library.name if library else None
    inspection = (
        await db.get(DownloadInspection, attempt.inspection_id) if attempt.inspection_id else None
    )
    group = None
    if inspection and inspection.state == "ready" and inspection.snapshot:
        _, grouping = await current_grouping(db, inspection)
        if len(grouping.groups) == 1:
            group = grouping.groups[0]
        paths = {file.path for item in grouping.groups for file in item.files}
        view.files = [
            ReviewFile(
                path=file["path"],
                medium=file.get("medium"),
                technical={
                    "duration": (file.get("technical") or {}).get("duration"),
                    "tags": {
                        key: value
                        for key, value in ((file.get("technical") or {}).get("tags") or {}).items()
                        if key in TAGS
                    },
                },
                metadata={
                    key: value
                    for key, value in (file.get("metadata") or {}).items()
                    if key in {"title", "authors", "languages"}
                },
            )
            for file in inspection.snapshot["files"]
            if file["path"] in paths
        ]
    confirmation = None
    if group:
        decision = await file_match(db, work, selection, inspection, group)
        view.mismatches = [RequestMismatch.model_validate(item) for item in decision.mismatches]
        view.expected_language = language_name(decision.language)
        view.expected_language_source = decision.language_source if decision.language else None
        view.identifiers = [
            Identifier(namespace=item.namespace, value=item.value)
            for item in group_evidence(inspection.snapshot, group).identifiers
        ]
        confirmation = confirmable(decision)
    granted = user.role == "admin" or bool(
        library
        and await db.scalar(
            select(LibraryGrant.library_id).where(
                LibraryGrant.library_id == library.id, LibraryGrant.user_id == user.id
            )
        )
    )
    view.add_unavailable = (
        None
        if held and confirmation and granted and has(user, REVIEW_OWN_DOWNLOADS)
        else "This download is no longer waiting for review."
        if not held
        else "Your account can't add held downloads; an administrator will check it."
        if not has(user, REVIEW_OWN_DOWNLOADS)
        else "This download needs an administrator: besides any title, author or "
        "language difference, its files have a problem only they can resolve."
        if not confirmation or len(members) != 1 or not group
        else "An administrator will check it: the library isn't one you can use."
    )
    view.can_add = view.add_unavailable is None and len(members) == 1
    view.confirmation = confirmation if view.can_add else None
    return view


@router.get("/{attempt_id}/review", response_model=OwnReviewView)
async def own_review(attempt_id: UUID, user: Member, db: Database):
    return await assess(db, user, *await own_held_download(db, user, attempt_id))


@router.post("/{attempt_id}/review/accept", response_model=OwnReviewView, status_code=202)
async def accept_own_review(attempt_id: UUID, body: AcceptInput, user: Member, db: Database):
    """The requester confirms these files are the book they asked for."""
    from app.domain.download_attempts import locked
    from app.domain.operations import transaction_lock
    from app.importing.automatic import retry_held

    attempt, *_ = await own_held_download(db, user, attempt_id)
    await locked(db, attempt.id)
    attempt, selection, automatic, members = await own_held_download(db, user, attempt_id)
    await transaction_lock(db, f"automatic-import:{automatic.id}")
    await db.refresh(automatic)
    view = await assess(db, user, attempt, selection, automatic, members)
    if not view.can_add:
        raise HTTPException(409, view.add_unavailable or "This download can't be added")
    if body.confirmation != view.confirmation:
        raise HTTPException(409, "The download changed since you reviewed it; review it again")
    automatic.evidence = {
        **automatic.evidence,
        "requester_confirmation": {"user_id": str(user.id), "mismatches": view.confirmation},
    }
    db.add(
        AuditEvent(
            actor_id=user.id,
            action="acquisition.download.requester_confirmed",
            entity_id=attempt.id,
            detail={"mismatches": [item.message for item in view.mismatches]},
        )
    )
    if not await retry_held(db, attempt):
        raise HTTPException(409, "This download is no longer waiting for review; refresh it")
    await db.commit()
    return await assess(db, user, *await own_held_download(db, user, attempt_id))
