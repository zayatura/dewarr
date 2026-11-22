import { useQuery } from "@tanstack/react-query";
import { api, result } from "../api/client";

type Medium = "ebook" | "audio";
export type LibraryChoices = Partial<Record<Medium, string>>;

const labels: Record<Medium, string> = {
  ebook: "Ebook library",
  audio: "Audiobook library",
};

function known(medium?: string | null): Medium | undefined {
  return medium === "ebook" || medium === "audio" ? medium : undefined;
}

/**
 * Libraries with a folder this account can download a medium into, and the
 * library a download uses when none is chosen (as the API resolves it).
 */
export function useReleaseLibraries(medium?: string | null) {
  const options = useQuery({
    queryKey: ["selection-options"],
    queryFn: async () =>
      result(await api.GET("/api/acquisition/selections/options")),
  });
  const defaults = useQuery({
    queryKey: ["download-defaults", "personal"],
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

/** True when a download of this medium would stop for want of a library. */
export function libraryMissing(
  choice: ReturnType<typeof useReleaseLibraries>,
  value?: string,
) {
  return choice.several && !value && !choice.preferred;
}

export default function ReleaseLibraryChoice({
  medium,
  value,
  onChange,
  disabled = false,
}: {
  medium?: string | null;
  value?: string;
  onChange: (value?: string) => void;
  disabled?: boolean;
}) {
  const choice = useReleaseLibraries(medium);
  const kind = known(medium);
  if (!kind || !choice.several) return null;
  return (
    <label className="release-library-choice">
      {labels[kind]}
      <select
        aria-label={labels[kind]}
        value={value || ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">
          {choice.preferred
            ? `Default · ${choice.preferred.name}`
            : "Choose a library"}
        </option>
        {choice.libraries.map((library) => (
          <option key={library.id} value={library.id}>
            {library.name}
          </option>
        ))}
      </select>
    </label>
  );
}
