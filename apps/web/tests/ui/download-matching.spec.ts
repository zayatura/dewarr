import { expect, test } from "../fixtures";

for (const scenario of [
  "identified",
  "untagged",
  "ambiguous",
  "retry",
  "automatic",
  "conflict",
  "unknown-conflict",
  "stale-review",
  "unavailable-review",
  "series-identified",
  "series-unidentified",
] as const) {
  test(`download review ${scenario} keeps the decision visible and reuses the saved request`, async ({
    page,
  }, testInfo) => {
    let imported = false;
    let automaticRetries = 0;
    let plans = 0;
    let editions = 0;
    let matchRequests = 0;
    let reviewAvailable = false;
    const submissions: { key: string | undefined; body: unknown }[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const title =
      "The Anxious Generation: How the Great Rewiring of Childhood is Causing an Epidemic of Mental Illness";
    const series = scenario.startsWith("series-");
    const files =
      scenario === "untagged"
        ? ["01.mp3", "02.mp3"]
        : series
          ? ["Modern Childhood, Book 2.m4b"]
          : ["The Anxious Generation.epub"];
    const medium = scenario === "untagged" || series ? "audio" : "ebook";
    const group = {
      key: "group",
      medium,
      title: "The Anxious Generation",
      authors: ["Jonathan Haidt"],
      narrators: [],
      files: files.map((path) => ({ path, role: "media" })),
    };
    const candidate = {
      work_id: "book",
      version_id: "version",
      identifier_match: true,
      reasons: [
        "Embedded edition identifier matches",
        "Embedded authors agree",
      ],
      conflicts: series ? [] : ["Embedded title is missing or differs"],
      title,
      authors: group.authors,
    };
    const destination = {
      id: "destination",
      medium,
      enabled: true,
      publication_available: true,
      backend_path: "/media/books",
      revision: "route-revision",
      mode: "hardlink",
    };
    const plan = {
      id: "plan",
      inspection_id: "download",
      revision: "plan-revision",
      document: {
        profile: { layout: "conventional" },
        version_revisions: { version: "version-revision" },
        destinations: { [medium]: "destination" },
        plan: {
          items: [
            {
              group_id: "group",
              work_id: "book",
              title,
              medium,
              state: "ready",
              folder: "Jonathan Haidt/The Anxious Generation",
              files: [],
            },
          ],
        },
      },
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = { items: [], total: 0 };
      if (path === "/api/auth/me")
        data = {
          user: {
            id: "reader",
            role: "admin",
            username: "reader",
            display_name: "Reader",
          },
          csrf_token: "test",
        };
      else if (path === "/api/setup/onboarding") data = { status: "completed" };
      else if (path === "/api/requests")
        data = {
          items: [{ targets: [{ inspection_id: "next-download" }] }],
          total: 1,
        };
      else if (path === "/api/organization/inspections/download")
        data = {
          id: "download",
          state: "ready",
          relative_path: "The Anxious Generation",
          plan_id: imported ? "plan" : null,
          snapshot: {
            revision: "inspection-revision",
            files: files.map((path) => ({
              path,
              extension: path.split(".").pop(),
              identity: { size: 5242880 },
              technical:
                medium === "audio" ? { duration: 600, codec: "mp3" } : null,
              medium,
              state: "inspected",
            })),
          },
          download: {
            attempt_id: "attempt",
            work_id: "book",
            title,
            authors: group.authors,
            medium,
            destination: "/media/books",
            mode: "hardlink",
            state: imported ? "complete" : "held",
            can_retry: scenario === "automatic",
            destination_id: "destination",
            file_conflicts:
              scenario === "unknown-conflict"
                ? ["The files name a different book"]
                : [],
            message:
              scenario === "untagged"
                ? "Audio files need a complete numbered sequence or matching track totals"
                : "Embedded title is missing or differs",
          },
        };
      else if (path === "/api/organization/inspections/download/retry") {
        automaticRetries++;
        imported = true;
        data = {
          id: "download",
          state: "ready",
          plan_id: "plan",
          download: {
            work_id: "book",
            title,
            authors: group.authors,
            medium,
            state: "complete",
          },
        };
      } else if (path.endsWith("/grouping"))
        data = {
          revision: "grouping-revision",
          content: { groups: [group], excluded: [] },
        };
      else if (path.endsWith("/matches")) {
        matchRequests++;
        expect(
          new URL(route.request().url()).searchParams.get("grouping_revision"),
        ).toBe("grouping-revision");
        if (scenario === "stale-review" && matchRequests === 1)
          return route.fulfill({
            status: 409,
            json: { detail: "File groups changed; reload before matching" },
          });
        if (scenario === "unavailable-review" && !reviewAvailable)
          return route.fulfill({
            status: 503,
            json: { detail: "Review temporarily unavailable" },
          });
        data = {
          items: [
            {
              group_key: "group",
              status: "review",
              revision: "match-revision",
              evidence: {
                issues: [],
                titles:
                  scenario === "conflict"
                    ? ["A Different Book"]
                    : series
                      ? ["Modern Childhood, Book 2"]
                      : [],
                authors: [],
              },
              candidates:
                scenario === "untagged" ||
                scenario === "unknown-conflict" ||
                scenario === "series-unidentified"
                  ? []
                  : scenario === "ambiguous"
                    ? [candidate, { ...candidate, version_id: "other-version" }]
                    : [candidate],
            },
          ],
          total: 1,
        };
      } else if (path === "/api/organization/settings")
        data = { revision: "settings-revision" };
      else if (path === "/api/organization/destinations") data = [destination];
      else if (path === "/api/organization/inspections/download/editions") {
        editions++;
        expect(route.request().postDataJSON().work_id).toBe("book");
        data = { version_id: "version" };
      } else if (path === "/api/organization/inspections/download/plans") {
        plans++;
        const body = route.request().postDataJSON();
        expect(body.selections).toEqual([
          {
            group_key: "group",
            work_id: "book",
            version_id: "version",
            full_content: true,
            contents_confirmed: false,
          },
        ]);
        expect(body.destinations).toEqual({ [medium]: "destination" });
        data = plan;
      } else if (path === "/api/organization/plans/plan") data = plan;
      else if (path === "/api/organization/plans/plan/imports") {
        if (route.request().method() === "POST") {
          submissions.push({
            key: route.request().headers()["idempotency-key"],
            body: route.request().postDataJSON(),
          });
          if (scenario === "retry" && submissions.length === 1)
            return route.fulfill({
              status: 503,
              json: { detail: "Library temporarily unavailable" },
            });
          imported = true;
        }
        data = [
          {
            id: "run",
            plan_id: "plan",
            entries: [
              {
                id: "entry",
                group_id: "group",
                state: "confirmed",
                message: "Available in your library",
                can_retry: false,
                can_cancel: false,
              },
            ],
          },
        ];
      } else if (
        path === "/api/organization/download-roots" ||
        path === "/api/organization/inspections"
      )
        data = [];
      await route.fulfill({ json: data });
    });
    await page.goto("/organization/inspections?inspection=download");
    const review = page.getByRole("region", {
      name: "Download next step",
    });
    await expect(review).toBeVisible();
    if (scenario === "unavailable-review") {
      await expect(
        review.getByText("Review temporarily unavailable"),
      ).toBeVisible();
      reviewAvailable = true;
      await review.getByRole("button", { name: "Refresh review" }).click();
    }
    await expect(page.getByLabel("Find catalog book")).not.toBeVisible();
    await expect(
      page.getByText("Inspection details", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Files and naming", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Change book or file selection", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("inspection-revision", { exact: false }),
    ).toHaveCount(0);
    if (
      scenario === "ambiguous" ||
      scenario === "conflict" ||
      scenario === "unknown-conflict"
    ) {
      await expect(
        review.getByRole("link", { name: "Choose a release yourself" }),
      ).toHaveAttribute("href", "/books/book?tab=sources");
      await expect(
        review.getByRole("button", { name: "Wrong book, find another" }),
      ).toBeVisible();
      await expect(
        review.getByRole("link", { name: "Review book metadata" }),
      ).toHaveAttribute("href", "/books/book?tab=manage");
      await expect(
        review.getByRole("button", { name: "Add to library" }),
      ).toHaveCount(0);
      if (scenario === "conflict")
        await expect(review.getByText("A Different Book")).toBeVisible();
      expect(plans).toBe(0);
      expect(errors).toEqual([]);
      return;
    }
    if (scenario === "automatic") {
      await expect(review.getByRole("status")).toHaveText(
        "Embedded title is missing or differs",
      );
      await review.getByRole("button", { name: "Check again" }).click();
      await expect(page.locator(".download-import-state")).toHaveText(
        "In library",
      );
      expect(automaticRetries).toBe(1);
      expect(editions).toBe(0);
      expect(plans).toBe(0);
      expect(errors).toEqual([]);
      return;
    }
    // Only a multi-file download asks whether every part is there.
    const several = files.length > 1;
    await expect(
      review.getByRole("button", { name: "Add to library" }),
    ).toBeEnabled({ enabled: !several });
    await expect(
      review.getByLabel("These files contain the complete book"),
    ).toHaveCount(several ? 1 : 0);
    if (scenario === "stale-review" || scenario === "unavailable-review")
      expect(matchRequests).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath("download-review-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("download-review-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "View files", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Downloaded files" })
        .getByText(files[0], { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "View files", exact: true }),
    ).toBeFocused();
    if (several)
      await review.getByLabel("These files contain the complete book").check();
    await review.getByRole("button", { name: "Add to library" }).click();
    if (scenario === "retry") {
      await expect(
        page.getByText("Library temporarily unavailable"),
      ).toBeVisible();
      await review
        .getByRole("button", { name: "Retry import", exact: true })
        .click();
      expect(submissions[1]).toEqual(submissions[0]);
    }
    await expect(page.locator(".download-import-state")).toHaveText(
      "In library",
    );
    await expect(
      page.getByRole("link", { name: "Review next download →" }),
    ).toHaveAttribute(
      "href",
      "/organization/inspections?inspection=next-download",
    );
    expect(plans).toBe(1);
    expect(editions).toBe(
      scenario === "untagged" || scenario === "series-unidentified" ? 1 : 0,
    );
    expect(errors).toEqual([]);
  });
}

for (const mode of ["reject", "accept"] as const) {
  test(`download review compares the request with the files and can ${mode}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const rejections: unknown[] = [];
    const accepts: unknown[] = [];
    const reason = "The files are in German, but this request expects English";
    const path = "Author A - Harbor Lights.m4b";
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url()).pathname;
      let data: unknown = { items: [], total: 0 };
      if (url === "/api/auth/me")
        data = {
          user: {
            id: "reader",
            role: "admin",
            username: "reader",
            display_name: "Reader",
          },
          csrf_token: "test",
        };
      else if (url === "/api/setup/onboarding") data = { status: "completed" };
      else if (url === "/api/organization/inspections/download")
        data = {
          id: "download",
          state: "ready",
          relative_path: "Harbor Lights",
          plan_id: null,
          snapshot: {
            revision: "inspection-revision",
            files: [
              {
                path,
                extension: "m4b",
                identity: { size: 5242880 },
                technical: {
                  duration: 56024,
                  codec: "aac",
                  tags: {
                    album: "Harbor Lights",
                    artist: "Author A",
                    composer: "Narrator B",
                    language: "Deutsch",
                  },
                },
                medium: "audio",
                state: "inspected",
              },
            ],
          },
          download: {
            attempt_id: "attempt",
            work_id: "book",
            title: "Harbor Lights",
            authors: ["Author A"],
            medium: "audio",
            destination: "/media/audiobooks",
            destination_id: "destination",
            mode: "hardlink",
            state: "held",
            can_retry: true,
            file_conflicts: [],
            confirmation: "confirm-1",
            message: reason,
            mismatches: [{ field: "language", message: reason }],
            expected_language: "English",
            expected_language_source: "settings",
            release: {
              source: "mam",
              title: "Harbor Lights",
              authors: ["Author A"],
              narrators: ["Narrator B"],
              language: "German",
            },
          },
        };
      else if (url.endsWith("/grouping"))
        data = {
          revision: "grouping-revision",
          content: {
            groups: [
              {
                key: "group",
                medium: "audio",
                title: "Harbor Lights",
                authors: ["Author A"],
                narrators: ["Narrator B"],
                files: [{ path, role: "media" }],
              },
            ],
            excluded: [],
          },
        };
      else if (url.endsWith("/matches"))
        data = {
          items: [
            {
              group_key: "group",
              status: "review",
              revision: "match-revision",
              evidence: {
                issues: [],
                titles: ["harbor lights"],
                authors: [["author a"]],
                identifiers: [{ namespace: "isbn", value: "9783000000000" }],
              },
              candidates: [],
            },
          ],
          total: 1,
        };
      else if (url === "/api/organization/settings")
        data = { revision: "settings-revision" };
      else if (url === "/api/organization/destinations")
        data = [
          {
            id: "destination",
            medium: "audio",
            enabled: true,
            publication_available: true,
            backend_path: "/media/audiobooks",
            revision: "route-revision",
            mode: "hardlink",
          },
        ];
      else if (url === "/api/organization/inspections/download/accept") {
        accepts.push(route.request().postDataJSON());
        return route.fulfill({
          status: 202,
          json: { id: "download", state: "ready", plan_id: null },
        });
      } else if (url === "/api/organization/inspections/download/reject") {
        rejections.push(route.request().postDataJSON());
        return route.fulfill({
          status: 202,
          json: {
            work_id: "book",
            message:
              "Rejected in download review (wrong language); finding another release",
          },
        });
      } else if (
        url === "/api/organization/download-roots" ||
        url === "/api/organization/inspections"
      )
        data = [];
      await route.fulfill({ json: data });
    });
    await page.goto("/organization/inspections?inspection=download");
    const review = page.getByRole("region", { name: "Download next step" });
    await expect(review.getByRole("status")).toHaveText(reason);
    const comparison = review.getByRole("table");
    const language = comparison.getByRole("row", { name: /Language/ });
    await expect(language).toContainText(
      "English (your catalog's primary language)",
    );
    await expect(language.locator(".is-mismatch")).toHaveText(
      "Deutsch (differs)",
    );
    await expect(comparison.getByRole("row", { name: /Length/ })).toContainText(
      "15 h 34 min",
    );
    await expect(comparison.getByRole("row", { name: /ISBN/ })).toContainText(
      "ISBN 9783000000000",
    );
    // A single file needs no completeness confirmation; the mismatch makes rejecting primary.
    await expect(
      review.getByRole("button", { name: "Add to library" }),
    ).toBeEnabled();
    const wrong = review.getByRole("button", {
      name: "Wrong book, find another",
    });
    await expect(wrong).toHaveClass(/primary/);
    if (mode === "accept") {
      await review.getByRole("button", { name: "Add to library" }).click();
      await expect.poll(() => accepts).toEqual([{ confirmation: "confirm-1" }]);
      expect(rejections).toEqual([]);
      expect(errors).toEqual([]);
      return;
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await wrong.click();
    await expect(
      review.getByLabel("What is wrong with this release?"),
    ).toHaveValue("wrong-language");
    await review
      .getByRole("button", { name: "Reject and find another" })
      .click();
    await expect(page.locator(".download-import-state")).toHaveText("Rejected");
    await expect(page.getByText("Looking for another release")).toBeVisible();
    expect(rejections).toEqual([{ reason: "wrong-language" }]);
    expect(errors).toEqual([]);
  });
}
