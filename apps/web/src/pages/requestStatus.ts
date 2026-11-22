export const liveDownloadStates = new Set([
  "queued",
  "preflight",
  "submitting",
  "uncertain",
  "downloading",
  "held",
]);

type StatusRequest = {
  approval_status: string;
  reasons: { active: boolean }[];
};

type StatusTarget = {
  state: string;
  message?: string | null;
  attempt_state?: string | null;
  selection_status?: string | null;
  next_action?: string | null;
  needs_review?: boolean;
  import_state?: string | null;
  replacement?: Replacement | null;
};

type Replacement = { state: string; reason: string; message: string };

const replacementSteps: Record<string, string> = {
  queued: "Waiting to search sources again",
  searching: "Searching sources for another release",
  selecting: "Choosing the best matching release",
  approval: "Waiting for an administrator to approve a replacement",
  complete: "Another copy already satisfied this request",
  held: "No other release could be chosen automatically. Pick one on the book's Sources tab.",
};

/** Why the earlier release was dropped, and what the replacement is doing now. */
export function replacementNotes(replacement: Replacement) {
  const [kind, detail] = replacement.reason.split(/:\s*(.*)/s);
  const why =
    kind === "Rejected in download review"
      ? `Previous release rejected: ${(detail || "").toLowerCase()}`
      : kind === "Reported problem"
        ? `Previous release reported: ${(detail || "").replace(/-/g, " ")}`
        : `Previous download failed: ${replacement.reason}`;
  return [why, replacementSteps[replacement.state] || replacement.message];
}

export function statusLabel(request: StatusRequest, target: StatusTarget) {
  if (!request.reasons.some((reason) => reason.active)) return "Withdrawn";
  if (
    request.approval_status === "declined" ||
    target.message === "Request declined"
  )
    return "Declined";
  if (
    request.approval_status === "pending" ||
    target.message === "Waiting for approval"
  )
    return "Pending";
  if (target.state === "satisfied") return "In library";
  if (target.replacement)
    return target.replacement.state === "held"
      ? "Replacement needs attention"
      : target.replacement.state === "approval"
        ? "Replacement awaits approval"
        : "Finding another release";
  if (target.needs_review || target.import_state === "held")
    return "Needs review";
  if (["uncertain", "held"].includes(target.attempt_state || ""))
    return "Download needs attention";
  if (["queued", "preflight"].includes(target.attempt_state || ""))
    return "Queued";
  if (target.attempt_state && liveDownloadStates.has(target.attempt_state))
    return "Downloading";
  if (target.state === "awaiting-inventory") return "Check inventory";
  if (target.state === "paused") return "Paused";
  if (target.attempt_state === "complete") return "Importing";
  if (
    target.next_action === "downloads" &&
    target.attempt_state !== "cancelled"
  )
    return "Downloading";
  if (target.selection_status === "searching") return "Searching sources";
  if (target.selection_status === "waiting") return "Waiting for source";
  if (target.selection_status === "scheduled") return "Request queued";
  if (target.selection_status === "held") return "Source needs review";
  if (target.selection_status === "failed") return "Download not started";
  if (["queued", "running"].includes(target.selection_status || ""))
    return "Preparing download";
  if (target.state === "wanted") return "Wanted";
  if (target.state === "cancelled") return "Withdrawn";
  return target.state;
}
