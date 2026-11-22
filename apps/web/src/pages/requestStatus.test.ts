import assert from "node:assert/strict";
import { test } from "node:test";
import { replacementNotes, statusLabel } from "./requestStatus.ts";

const active = {
  approval_status: "approved",
  reasons: [{ active: true }],
};

test("a finished transfer still being imported is Importing", () => {
  assert.equal(
    statusLabel(active, {
      state: "wanted",
      attempt_state: "complete",
      next_action: "downloads",
    }),
    "Importing",
  );
});

test("an active transfer stays Downloading", () => {
  assert.equal(
    statusLabel(active, {
      state: "wanted",
      attempt_state: "downloading",
      next_action: "downloads",
    }),
    "Downloading",
  );
});

test("queued and preflight attempts have not started transferring", () => {
  for (const attempt_state of ["queued", "preflight"]) {
    assert.equal(
      statusLabel(active, {
        state: "wanted",
        attempt_state,
        next_action: "downloads",
      }),
      "Queued",
    );
  }
});

test("uncertain and held transfers need attention rather than claiming to download", () => {
  for (const attempt_state of ["uncertain", "held"]) {
    assert.equal(
      statusLabel(active, {
        state: "wanted",
        attempt_state,
        next_action: "downloads",
      }),
      "Download needs attention",
    );
    assert.equal(
      statusLabel(active, {
        state: "satisfied",
        attempt_state,
        next_action: "book",
      }),
      "In library",
    );
  }
});

test("a committed selection with no transfer yet is Downloading", () => {
  assert.equal(
    statusLabel(active, {
      state: "wanted",
      next_action: "downloads",
    }),
    "Downloading",
  );
});

test("a cancelled transfer is no longer Downloading", () => {
  assert.equal(
    statusLabel(active, {
      state: "wanted",
      attempt_state: "cancelled",
      next_action: "downloads",
    }),
    "Wanted",
  );
});

test("a finished download waiting on inventory is Check inventory", () => {
  assert.equal(
    statusLabel(active, {
      state: "awaiting-inventory",
      attempt_state: "complete",
      next_action: "downloads",
      message: "Refresh library inventory before acquiring another copy",
    }),
    "Check inventory",
  );
});

test("a completed transfer already in the library is In library", () => {
  assert.equal(
    statusLabel(active, {
      state: "satisfied",
      attempt_state: "complete",
      next_action: "book",
    }),
    "In library",
  );
});

test("manual release failures and preparation remain visible in Requests", () => {
  assert.equal(
    statusLabel(active, { state: "wanted", selection_status: "held" }),
    "Source needs review",
  );
  assert.equal(
    statusLabel(active, { state: "wanted", selection_status: "failed" }),
    "Download not started",
  );
  assert.equal(
    statusLabel(active, { state: "wanted", selection_status: "running" }),
    "Preparing download",
  );
  assert.equal(
    statusLabel(active, { state: "satisfied", selection_status: "held" }),
    "In library",
  );
});

test("a held import needs review and a satisfied request wins over stale review", () => {
  assert.equal(
    statusLabel(active, {
      state: "wanted",
      attempt_state: "complete",
      import_state: "held",
    }),
    "Needs review",
  );
  assert.equal(
    statusLabel(active, {
      state: "wanted",
      attempt_state: "complete",
      needs_review: true,
    }),
    "Needs review",
  );
  assert.equal(
    statusLabel(active, {
      state: "satisfied",
      attempt_state: "complete",
      needs_review: true,
    }),
    "In library",
  );
});

test("a replaced release reports the replacement, not the rejected transfer", () => {
  const replacement = {
    state: "selecting",
    reason: "Rejected in download review: Wrong language",
    message:
      "Selecting the next eligible release with the original constraints",
  };
  const target = {
    state: "wanted",
    attempt_state: "held",
    import_state: "held",
    replacement,
  };
  assert.equal(statusLabel(active, target), "Finding another release");
  assert.deepEqual(replacementNotes(replacement), [
    "Previous release rejected: wrong language",
    "Choosing the best matching release",
  ]);
  assert.equal(
    statusLabel(active, {
      ...target,
      replacement: { ...replacement, state: "held" },
    }),
    "Replacement needs attention",
  );
  assert.equal(
    replacementNotes({ ...replacement, state: "held" })[1],
    "No other release could be chosen automatically. Pick one on the book's Sources tab.",
  );
  assert.equal(
    replacementNotes({
      ...replacement,
      reason: "Reported problem: wrong-narrator",
    })[0],
    "Previous release reported: wrong narrator",
  );
});
