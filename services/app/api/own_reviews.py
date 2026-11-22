"""A requester's own view of a held download: why it stopped and what they can do."""

from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import Database, Member
from app.db.models import AutomaticImport, DownloadAttempt, DownloadRecovery

router = APIRouter(prefix="/acquisition/downloads", tags=["downloads"])


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


async def own_held_download(db, user, attempt_id):
    """The requester's selection in a held download, or 404 for anyone else."""
    from app.domain import download_memberships

    attempt = await db.get(DownloadAttempt, attempt_id)
    if not attempt:
        raise HTTPException(404, "Download not found")
    selection = next(
        (
            item
            for item in await download_memberships.for_attempt(db, attempt.id)
            if item.owner_id == user.id
        ),
        None,
    )
    automatic = await db.scalar(
        select(AutomaticImport).where(AutomaticImport.attempt_id == attempt.id)
    )
    if not selection or not automatic:
        raise HTTPException(404, "Download not found")
    return attempt, selection, automatic


@router.get("/{attempt_id}/review", response_model=OwnReviewView)
async def own_review(attempt_id: UUID, user: Member, db: Database):
    from app.domain.download_reviews import has_imports
    from app.domain.work_graph import canonical_work

    attempt, selection, automatic = await own_held_download(db, user, attempt_id)
    replaced = await db.scalar(
        select(DownloadRecovery.id).where(DownloadRecovery.selection_id == selection.id)
    )
    work = await canonical_work(db, UUID(selection.frozen["origin_work_id"]))
    return OwnReviewView(
        attempt_id=attempt.id,
        selection_id=selection.id,
        work_id=work.id,
        title=work.title,
        authors=work.authors,
        medium=selection.frozen["requirements"]["medium"],
        message=automatic.message,
        can_reject=bool(
            attempt.state == "complete"
            and automatic.state == "held"
            and not replaced
            and not (attempt.inspection_id and await has_imports(db, attempt.inspection_id))
        ),
    )
