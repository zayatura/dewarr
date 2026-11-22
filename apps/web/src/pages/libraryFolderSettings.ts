import { useQuery } from "@tanstack/react-query";
import { api, result } from "../api/client";
import type { components } from "../api/schema";
import type { Medium } from "./namingBuilder";

type Destination = components["schemas"]["DestinationView"];
export function selectLibraryDestination(
  destinations: Destination[],
  id: unknown,
  medium: Medium,
) {
  const matching = destinations.filter((item) => item.medium === medium);
  return (
    matching.find((item) => item.id === id) ||
    matching.find((item) => item.root_key === `library-${medium}`) ||
    (matching.length === 1 ? matching[0] : undefined)
  );
}

/**
 * The folder a download uses when its request names no library, resolved the
 * way the API does it: a saved folder, else the default library's only folder,
 * else the only folder. Several candidates mean there is no default.
 */
export function defaultLibraryDestination(
  destinations: Destination[],
  preferences: Partial<Record<string, unknown>> | undefined,
  medium: Medium,
) {
  const matching = destinations.filter(
    (item) => item.medium === medium && item.enabled,
  );
  const library = preferences?.[`${medium}_library_id`];
  const saved = matching.find(
    (item) => item.id === preferences?.[`${medium}_destination_id`],
  );
  if (saved && (!library || saved.library_id === library)) return saved;
  const candidates = library
    ? matching.filter((item) => item.library_id === library)
    : matching;
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function useLibraryFolderSettings() {
  return useQuery({
    queryKey: ["library-folder-settings"],
    refetchInterval: 5000,
    queryFn: async () => {
      const [destinations, libraries, defaults] = await Promise.all([
        api.GET("/api/organization/destinations").then(result),
        api.GET("/api/library/libraries").then(result),
        api
          .GET("/api/acquisition/preferences/{scope}", {
            params: { path: { scope: "personal" } },
          })
          .then(result),
      ]);
      return { destinations, libraries, defaults };
    },
  });
}
