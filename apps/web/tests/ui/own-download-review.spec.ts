import { expect, test } from "../fixtures";

const reason = "The files are in German, but this request expects English";

test("a requester reviews their own held download and rejects it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const reports: unknown[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog/cover-image") return route.fallback();
    let data: unknown = { items: [], total: 0 };
    if (path === "/api/auth/me")
      data = {
        user: {
          id: "member",
          role: "member",
          username: "member",
          display_name: "Member",
          onboarding_status: "completed",
          permissions: ["request"],
        },
        csrf_token: "test",
      };
    else if (path === "/api/setup/onboarding") data = { status: "completed" };
    else if (path === "/api/request-quotas/me")
      data = { bypass: true, windows: [], pending_remaining: null };
    else if (path === "/api/requests/counts")
      data = { pending: 0, downloading: 0, review: 0, active: 1 };
    else if (path === "/api/requests")
      data = {
        items: [
          {
            id: "request-1",
            work_id: "work-1",
            work_title: "Harbor Lights",
            authors: ["Author A"],
            owner_name: "Member",
            can_open_book: true,
            can_withdraw: false,
            can_decide: false,
            approval_status: "approved",
            specification: { mode: "audio" },
            reasons: [
              {
                id: "reason-1",
                active: true,
                label: "Your request",
                approval_status: "approved",
              },
            ],
            targets: [
              {
                slot: "audio",
                state: "wanted",
                message: reason,
                attempt_id: "attempt-1",
                attempt_state: "complete",
                import_state: "held",
                needs_review: true,
                own_review: true,
                review_message: `${reason}. An administrator will check this download.`,
              },
            ],
          },
        ],
        total: 1,
      };
    else if (path === "/api/acquisition/downloads/attempt-1/review")
      data = {
        attempt_id: "attempt-1",
        selection_id: "selection-1",
        work_id: "work-1",
        title: "Harbor Lights",
        authors: ["Author A"],
        medium: "audio",
        message: reason,
        can_reject: true,
      };
    else if (path === "/api/acquisition/recovery/reports") {
      reports.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: [] });
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/requests");
  await page.getByRole("button", { name: "Review download" }).click();
  const dialog = page.getByRole("dialog", { name: "Review download" });
  await expect(dialog.getByRole("status")).toHaveText(reason);
  await dialog
    .getByRole("button", { name: "Wrong book, find another" })
    .click();
  await dialog
    .getByLabel("What is wrong with this release?")
    .selectOption("wrong-language");
  await dialog.getByRole("button", { name: "Reject and find another" }).click();
  await expect(dialog.getByText("Looking for another release")).toBeVisible();
  expect(reports).toEqual([
    {
      selection_id: "selection-1",
      reason: "wrong-language",
      require_approval: false,
    },
  ]);
  expect(errors).toEqual([]);
});
