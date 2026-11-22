import { expect, test } from "../fixtures";

test("each audiobook library gets its own folder card", async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  const first = {
    id: "first-folder",
    root_key: "library-audio",
    medium: "audio",
    workflow: "library",
    library_id: "library-a",
    backend_path: "/audiobooks/a",
    local_path: "/audiobooks/a",
    mode: "hardlink",
    enabled: true,
    revision: "first-revision",
    configured: true,
    publication_available: true,
    server_kind: "audiobookshelf",
    client_routes: [],
  };
  let saved: any;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === "/api/auth/me")
      data = {
        user: {
          id: "admin",
          role: "admin",
          display_name: "Reader",
          onboarding_status: "complete",
        },
        csrf_token: "test",
      };
    else if (path === "/api/setup/onboarding") data = { status: "completed" };
    else if (path === "/api/library/libraries")
      data = [
        { id: "library-a", name: "Library A", accessible: true },
        { id: "library-b", name: "Library B", accessible: true },
      ];
    else if (path.startsWith("/api/acquisition/preferences/"))
      data = {
        effective: {
          audio_library_id: "library-a",
          audio_destination_id: "first-folder",
        },
        inherited: {},
        overrides: {},
        revision: "one",
      };
    else if (path === "/api/organization/destinations") data = [first];
    else if (path === "/api/organization/library-folders")
      data = ["a", "b"].map((name) => ({
        library_id: `library-${name}`,
        library_name: `Library ${name.toUpperCase()}`,
        server_name: "Audiobookshelf",
        server_kind: "audiobookshelf",
        ebooks_allowed: false,
        audio_allowed: true,
        folders: [`/audiobooks/${name}`],
      }));
    else if (path.endsWith("/automatic-import"))
      data = { enabled: true, requested_enabled: true, generation: 1 };
    else if (path === "/api/organization/library-folders/audio") {
      saved = route.request().postDataJSON();
      data = { ...first, ...saved, id: "second-folder", revision: "two" };
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/settings#libraries");
  const firstCard = page.getByRole("region", {
    name: "Audiobooks destination for Library A",
  });
  await expect(firstCard.getByText("Default", { exact: true })).toBeVisible();
  const second = page.getByRole("region", {
    name: "Audiobooks destination for Library B",
  });
  await expect(
    second.getByText("No folder selected", { exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Choose audiobooks folder for Library B" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Choose audiobooks folder for Library B",
  });
  await expect(dialog.locator(".library-selection-summary")).toContainText(
    "Library B",
  );
  await dialog
    .getByRole("button", { name: "Save folder", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  // A new library gets a new folder; Library A's folder is left as it was.
  expect(saved).toMatchObject({
    library_id: "library-b",
    backend_path: "/audiobooks/b",
    local_path: "/audiobooks/b",
  });
  expect(saved.destination_id).toBeUndefined();
});

test("no folder is marked default when the API would ask for a library", async ({
  page,
}) => {
  const folder = (name: string, root_key: string) => ({
    id: `folder-${name}`,
    root_key,
    medium: "audio",
    workflow: "library",
    library_id: `library-${name}`,
    backend_path: `/audiobooks/${name}`,
    local_path: `/audiobooks/${name}`,
    mode: "hardlink",
    enabled: true,
    revision: name,
    configured: true,
    publication_available: true,
    server_kind: "audiobookshelf",
    client_routes: [],
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === "/api/auth/me")
      data = {
        user: {
          id: "admin",
          role: "admin",
          display_name: "Reader",
          onboarding_status: "complete",
        },
        csrf_token: "test",
      };
    else if (path === "/api/setup/onboarding") data = { status: "completed" };
    else if (path === "/api/library/libraries")
      data = ["a", "b"].map((name) => ({
        id: `library-${name}`,
        name: `Library ${name.toUpperCase()}`,
        accessible: true,
      }));
    else if (path.startsWith("/api/acquisition/preferences/"))
      data = {
        effective: {},
        inherited: {},
        inherited_origins: {},
        overrides: {},
        revision: "one",
      };
    else if (path === "/api/organization/destinations")
      // The oldest folder keeps the legacy key; that alone is not a default.
      data = [folder("a", "library-audio"), folder("b", "library-audio-b")];
    else if (path.endsWith("/automatic-import"))
      data = { enabled: true, requested_enabled: true, generation: 1 };
    return route.fulfill({ json: data });
  });
  await page.goto("/settings#libraries");
  for (const name of ["A", "B"])
    await expect(
      page.getByRole("region", {
        name: `Audiobooks destination for Library ${name}`,
      }),
    ).toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toHaveCount(0);
  // Administrators choose default libraries with their download defaults.
  await page.goto("/settings#preferences");
  await expect(
    page.getByRole("heading", { name: "Default libraries" }),
  ).toBeVisible();
  const audio = page.getByRole("combobox", { name: "Audiobook library" });
  await expect(audio).toBeVisible();
  await expect(audio.locator("option")).toContainText([
    "Choose during acquisition",
    "Library A",
    "Library B",
  ]);
});
