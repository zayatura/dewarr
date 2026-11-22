import { useQuery } from "@tanstack/react-query";
import { api, result } from "../api/client";

type Medium = "ebook" | "audio";

function known(medium?: string | null): Medium | undefined {
  return medium === "ebook" || medium === "audio" ? medium : undefined;
}

/**
 * Libraries with a folder this account can download a medium into, and the
 * library a download uses when none is chosen (as the API resolves it).
 */
export function useReleaseLibraries(medium?: string | null, enabled = true) {
  // Every release row asks; one cached answer serves them all.
  const options = useQuery({
    queryKey: ["selection-options"],
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      result(await api.GET("/api/acquisition/selections/options")),
  });
  const defaults = useQuery({
    queryKey: ["download-defaults", "personal"],
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      result(
        await api.GET("/api/acquisition/preferences/{scope}", {
          params: { path: { scope: "personal" } },
        }),
      ),
  });
  const kind = known(medium);
  const folders = (options.data?.destinations || []).filter(
    (item) => item.medium === kind && item.library_id,
  );
  const libraries = [
    ...new Map(
      folders.map((item) => [
        item.library_id!,
        { id: item.library_id!, name: item.name },
      ]),
    ).values(),
  ];
  const effective = defaults.data?.effective;
  const saved =
    kind &&
    folders.find(
      (item) => item.id === effective?.[`${kind}_destination_id` as const],
    );
  const preferred =
    (kind && effective?.[`${kind}_library_id` as const]) ||
    (saved && saved.library_id) ||
    (libraries.length === 1 ? libraries[0].id : undefined);
  return {
    libraries,
    preferred: libraries.find((library) => library.id === preferred),
    several: libraries.length > 1,
  };
}
