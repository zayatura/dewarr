import type { components } from "../api/schema";

type Inspection = components["schemas"]["InspectionView"];
type Download = components["schemas"]["DownloadContext"];
type Mismatch = components["schemas"]["RequestMismatch"]["field"];
type Column = "requested" | "release" | "files";
type Row = {
  key: string;
  label: string;
  values: Record<Column, string>;
  flagged: Column[];
};

const languageSources: Record<string, string> = {
  request: "set on the request",
  book: "from the catalog",
  settings: "your catalog's primary language",
};

const columns: { key: Column; label: string }[] = [
  { key: "requested", label: "You requested" },
  { key: "release", label: "Release listing" },
  { key: "files", label: "The files say" },
];

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function list(values: unknown[]) {
  return [...new Set(values.map(text).filter(Boolean))].join(", ");
}

function hours(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What the files' own tags say, read from the inspected media files. */
function fileFacts(inspection: Inspection, paths?: string[]) {
  const media = (inspection.snapshot?.files || []).filter(
    (file) => file.medium && (!paths || paths.includes(file.path)),
  );
  const tags = media.map(
    (file) =>
      ((file.technical?.tags as Record<string, unknown>) || {}) as Record<
        string,
        unknown
      >,
  );
  const metadata = media.map((file) => file.metadata || {});
  const many = (key: string) =>
    metadata.flatMap((item) =>
      Array.isArray(item[key]) ? (item[key] as unknown[]) : [item[key]],
    );
  const duration = media.reduce(
    (total, file) =>
      total +
      (typeof file.technical?.duration === "number"
        ? file.technical.duration
        : 0),
    0,
  );
  return {
    title: list([
      ...tags.map((tag) => tag.album || tag.title),
      ...many("title"),
    ]),
    authors: list([
      ...tags.map((tag) => tag.album_artist || tag.artist),
      ...many("authors"),
    ]),
    narrators: list(tags.map((tag) => tag.narrator || tag.composer)),
    language: list([...tags.map((tag) => tag.language), ...many("languages")]),
    length: duration ? hours(duration) : "",
  };
}

/** Request, release listing and file tags side by side, with disagreements marked. */
export default function DownloadComparison({
  download,
  inspection,
  paths,
  identifiers,
  evidenceTitles,
}: {
  download: Download;
  inspection: Inspection;
  paths?: string[];
  identifiers?: { namespace: string; value: string }[];
  evidenceTitles?: string[];
}) {
  const release = download.release;
  const facts = fileFacts(inspection, paths);
  // Without readable tags, the matcher's title evidence is the best file-side title.
  const files = { ...facts, title: facts.title || list(evidenceTitles || []) };
  const fields = new Set<Mismatch>(
    (download.mismatches || []).map((item) => item.field),
  );
  const audio = download.medium === "audio";
  const rows: Row[] = [
    {
      key: "title",
      label: "Title",
      values: {
        requested: download.title,
        release: release?.title || "",
        files: files.title,
      },
      flagged: [
        ...(fields.has("release_title") ? (["release"] as const) : []),
        ...(fields.has("title") ? (["files"] as const) : []),
      ],
    },
    {
      key: "authors",
      label: "Author",
      values: {
        requested: download.authors.join(", "),
        release: release?.authors?.join(", ") || "",
        files: files.authors,
      },
      flagged: [
        ...(fields.has("release_authors") ? (["release"] as const) : []),
        ...(fields.has("authors") && files.authors ? (["files"] as const) : []),
      ],
    },
    ...(audio
      ? [
          {
            key: "narrators",
            label: "Narrator",
            values: {
              requested: "",
              release: release?.narrators?.join(", ") || "",
              files: files.narrators,
            },
            flagged: [] as Column[],
          },
        ]
      : []),
    {
      key: "language",
      label: "Language",
      values: {
        requested: download.expected_language
          ? `${download.expected_language}${
              download.expected_language_source
                ? ` (${languageSources[download.expected_language_source]})`
                : ""
            }`
          : "",
        release: release?.language || "",
        files: files.language,
      },
      flagged: (fields.has("language")
        ? [files.language ? "files" : "release"]
        : []) as Column[],
    },
    ...(audio
      ? [
          {
            key: "length",
            label: "Length",
            values: { requested: "", release: "", files: files.length },
            flagged: [] as Column[],
          },
        ]
      : []),
    {
      key: "identifiers",
      label: "ISBN / ASIN",
      values: {
        requested: "",
        release: "",
        files: (identifiers || [])
          .map((item) => `${item.namespace.toUpperCase()} ${item.value}`)
          .join(", "),
      },
      flagged: (fields.has("identifiers") ? ["files"] : []) as Column[],
    },
  ].filter((row) => Object.values(row.values).some(Boolean));
  return (
    <table className="download-comparison">
      <caption className="sr-only">
        The request compared with the release listing and the files
      </caption>
      <thead>
        <tr>
          <td />
          {columns.map((column) => (
            <th key={column.key} scope="col">
              {column.key === "release" && release?.source
                ? `Release listing (${release.source.toUpperCase()})`
                : column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.label}</th>
            {columns.map((column) => {
              const flagged = row.flagged.includes(column.key);
              return (
                <td
                  key={column.key}
                  data-label={column.label}
                  className={
                    flagged
                      ? "is-mismatch"
                      : row.values[column.key]
                        ? undefined
                        : "is-empty"
                  }
                >
                  {row.values[column.key] || (
                    <span className="muted" aria-label="Not given">
                      —
                    </span>
                  )}
                  {flagged && <span className="sr-only"> (differs)</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
