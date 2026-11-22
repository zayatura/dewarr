import { expect, test } from "../fixtures";

test("each release shows its language, can be filtered by it, and blocked ones cannot download", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const work = {
    id: "work-1",
    title: "Harbor Lights",
    authors: ["Author A"],
    versions: [],
    availability: { owned: false, ebook: false, audio: false, stale: false },
  };
  const profile = { id: null, generation: 0, preferences: {} };
  const expires_at = new Date(Date.now() + 25 * 60_000).toISOString();
  const search = {
    id: "search-1",
    work_id: work.id,
    request_id: null as string | null,
    query: work.title,
    medium: "all",
    offset: 0,
    status: "completed",
    message: "Search complete",
    stale_identity: false,
    expires_at,
    profile,
    sources: [
      { key: "mam", name: "MAM", state: "completed", count: 1, message: "" },
    ],
    items: [
      {
        id: "result-1",
        release: {
          source: "mam",
          source_id: "1",
          title: work.title,
          raw_title: work.title,
          authors: work.authors,
          narrators: [],
          medium: "audio",
          formats: ["m4b"],
          size_bytes: 1000,
          seeders: 5,
          freeleech: true,
          personal_freeleech: false,
          vip: false,
          tags: [],
          series: [],
          observed_at: new Date().toISOString(),
        },
        current_connection: true,
        expires_at,
        download: null,
        language_name: "German",
        assessment: {
          blocked: [
            "Blocked for this book (Rejected in download review: Wrong language)",
          ],
          review: [],
          explanation: [],
        },
      },
      {
        id: "result-2",
        release: {
          source: "mam",
          source_id: "2",
          title: `${work.title}: A Subtitle`,
          raw_title: `${work.title}: A Subtitle`,
          authors: work.authors,
          narrators: [],
          medium: "audio",
          formats: ["m4b"],
          size_bytes: 1000,
          seeders: 50,
          freeleech: true,
          personal_freeleech: false,
          vip: false,
          tags: [],
          series: [],
          observed_at: new Date().toISOString(),
        },
        current_connection: true,
        expires_at,
        download: null,
        language_name: "English",
        assessment: { blocked: [], review: [], explanation: [] },
      },
    ],
  };
  const downloads: string[] = [];
  let effective: Record<string, string> = {};
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let data: unknown = {};
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
    else if (path === "/api/catalog/works/work-1") data = work;
    else if (path === "/api/acquisition/profiles") data = [profile];
    else if (path === "/api/acquisition/preferences/personal")
      data = { effective, inherited: {}, overrides: {}, revision: "one" };
    else if (path === "/api/acquisition/selections/options")
      data = {
        downloaders: [],
        destinations: ["a", "b"].map((name) => ({
          id: `folder-${name}`,
          library_id: `library-${name}`,
          name: `Library ${name.toUpperCase()}`,
          medium: "audio",
          revision: name,
          source_key: null,
          ready: true,
          automatic_import_ready: true,
          source_keys: [],
        })),
      };
    else if (path.endsWith("/source-searches/latest")) data = search;
    else if (path === "/api/sources/mam/releases/1")
      data = search.items[0].release;
    else if (path.endsWith("/results/result-1/download")) {
      downloads.push(url.searchParams.get("library_id") || "");
      return route.fulfill({
        status: 202,
        json: { id: "operation-1", status: "queued", message: "Queued" },
      });
    } else if (path === "/api/metadata/works/work-1")
      data = {
        sources: [],
        conflicts: [],
        fields: {},
        versions: [],
        versions_total: 0,
      };
    else if (path.endsWith("/reader-match")) data = { book: null };
    else if (path.endsWith("/reader-details"))
      data = { authors: [], reviews: [] };
    else if (path.endsWith("/versions")) data = [];
    else if (path.includes("/group"))
      data = { items: [], groups: [], members: [] };
    else if (path === "/api/requests" || path === "/api/catalog/works")
      data = { items: [], total: 0 };
    else if (path.startsWith("/api/acquisition/automatic-selections/"))
      data = { id: "operation-1", status: "queued", message: "Queued" };
    await route.fulfill({ json: data });
  });
  await page.goto("/books/work-1?tab=sources");
  const table = page.locator(".source-table");
  const german = table.getByRole("row", { name: "Harbor Lights", exact: true });
  await expect(german).toContainText("MAM · #1 · German · Blocked");
  await expect(
    german.getByRole("button", { name: "Download Harbor Lights" }),
  ).toBeDisabled();
  await expect(
    table.getByRole("row", { name: "Harbor Lights: A Subtitle" }),
  ).toContainText("English");
  await page.getByLabel("Release language").selectOption("English");
  await expect(german).toHaveCount(0);
  await expect(page.getByText("1 match your filters")).toBeVisible();
  expect(errors).toEqual([]);
});
