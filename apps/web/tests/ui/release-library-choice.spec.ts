import { expect, test } from "../fixtures";

test("Download offers each library and asks when there is no default", async ({
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
  const libraries = page.getByRole("group", { name: "Download to" });
  // Without a default library, Download asks where the book should go.
  const rowDownload = table.getByRole("button", {
    name: "Download Harbor Lights",
  });
  await expect(rowDownload).toHaveAttribute(
    "title",
    "Choose a library to download into",
  );
  await rowDownload.click();
  await expect(libraries).toBeVisible();
  await expect(libraries.getByText("Default")).toHaveCount(0);
  await libraries
    .getByRole("button", { name: "Download to Library B" })
    .click();
  await expect.poll(() => downloads).toEqual(["library-b"]);
  // With a default, Download uses it; the arrow still offers the others.
  effective = { audio_library_id: "library-a" };
  await page.reload();
  await page.getByRole("button", { name: "Details for Harbor Lights" }).click();
  const dialog = page.getByRole("dialog", { name: "Release details" });
  const download = dialog.getByRole("button", {
    name: "Download Harbor Lights",
  });
  await expect(download).toHaveAttribute("title", "Download to Library A");
  await dialog.getByLabel("Choose library for Harbor Lights").click();
  const choices = dialog.getByRole("group", { name: "Download to" });
  await expect(
    choices.getByRole("button", { name: "Download to Library A" }),
  ).toContainText("Default");
  await page.keyboard.press("Escape");
  await expect(choices).toBeHidden();
  await download.click();
  await expect.poll(() => downloads).toEqual(["library-b", ""]);
  // A request's own search keeps that request's library.
  search.request_id = "request-1";
  await page.goto("/books/work-1?tab=sources");
  await expect(
    table.getByRole("button", { name: "Download Harbor Lights" }),
  ).toBeVisible();
  await expect(page.getByLabel("Choose library for Harbor Lights")).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});
