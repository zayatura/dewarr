import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, result } from "../api/client";
import type { components } from "../api/schema";
import { Loading, Notice } from "../components";
import { Link } from "react-router-dom";
import { randomUUID } from "../randomUUID";
import DownloadComparison from "./DownloadComparison";

type Inspection = components["schemas"]["InspectionView"];
type Plan = components["schemas"]["FrozenPlanView"];
type Rejection = components["schemas"]["RejectionView"];
type RejectReason = components["schemas"]["RejectInput"]["reason"];

/** A saved download needs a decision about its files, not another catalog workflow. */
export default function DownloadMatchReview({
  inspection,
  retry,
  retrying,
  rejected,
}: {
  inspection: Inspection;
  retry: () => void;
  retrying: boolean;
  rejected: (value: Rejection) => void;
}) {
  const download = inspection.download!;
  const cache = useQueryClient();
  const [destinationId, setDestinationId] = useState("");
  const [complete, setComplete] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const mismatched = !!download.mismatches?.length;
  const [reason, setReason] = useState<RejectReason>(
    download.mismatches?.some((item) => item.field === "language")
      ? "wrong-language"
      : "wrong-book",
  );
  const prepared = useRef<{
    plan: Plan;
    destination: { id: string; revision: string };
    key: string;
  } | null>(null);
  const context = useQuery({
    retry: (attempt, error) =>
      attempt < 1 && error instanceof ApiError && error.status === 409,
    queryKey: [
      "download-review-context",
      inspection.id,
      inspection.snapshot?.revision,
    ],
    queryFn: async () => {
      const [grouping, settings, destinations] = await Promise.all([
        api
          .GET("/api/organization/inspections/{inspection_id}/grouping", {
            params: { path: { inspection_id: inspection.id } },
          })
          .then(result),
        api.GET("/api/organization/settings").then(result),
        api.GET("/api/organization/destinations").then(result),
      ]);
      const matches = result(
        await api.GET("/api/organization/inspections/{inspection_id}/matches", {
          params: {
            path: { inspection_id: inspection.id },
            query: { grouping_revision: grouping.revision, limit: 10 },
          },
        }),
      );
      return { grouping, settings, destinations, matches };
    },
  });
  const data = context.data;
  const group =
    data?.grouping.content.groups.length === 1
      ? data.grouping.content.groups[0]
      : undefined;
  const match = data?.matches.items.find(
    (item) => item.group_key === group?.key,
  );
  const candidates =
    match?.candidates.filter((item) => item.work_id === download.work_id) || [];
  const identified = candidates.filter((item) => item.identifier_match);
  const candidate =
    candidates.find((item) => item.version_id === match?.selected_version_id) ||
    (identified.length === 1 ? identified[0] : undefined);
  const issues = [
    ...(download.file_conflicts || []),
    ...(match?.evidence.issues || []),
  ];
  const conflicts =
    candidate?.conflicts.filter(
      (reason) =>
        !(
          reason === "Embedded title is missing or differs" &&
          !match?.evidence.titles?.length
        ) &&
        !(
          reason === "Embedded authors are missing or differ" &&
          !match?.evidence.authors?.length
        ),
    ) || [];
  const blocked =
    !group ||
    group.medium !== download.medium ||
    !match ||
    match.truncated ||
    identified.length > 1 ||
    conflicts.length > 0 ||
    issues.length > 0 ||
    match.candidates.some(
      (item) => item.identifier_match && item.work_id !== download.work_id,
    );
  const unreadable =
    inspection.snapshot?.files.filter(
      (file) =>
        file.state === "held" &&
        (file.medium ||
          /\.(epub|pdf|cbz|m4b|m4a|mp3|flac|ogg|opus|aac|wav|wma)$/i.test(
            file.path,
          )),
    ) || [];
  const problem = unreadable.length
    ? unreadable[0].reason ||
      "The downloaded book could not be read. Check its files and try again."
    : data?.grouping.content.groups.length === 0
      ? "No supported book files were found in this download."
      : !group
        ? "These files may contain several books. Choose a download containing only the requested book."
        : identified.length > 1
          ? "The files point to more than one catalog edition. We need a clearer release to avoid importing the wrong edition."
          : download.file_conflicts?.length
            ? download.file_conflicts[0]
            : issues.length
              ? "Some files could not be verified or contain conflicting information."
              : "The downloaded files do not agree with the book you requested.";
  const destinations =
    data?.destinations.filter(
      (item) =>
        item.medium === download.medium &&
        item.enabled &&
        item.publication_available,
    ) || [];
  const saved = destinations.filter(
    (item) =>
      item.backend_path === download.destination ||
      item.local_path === download.destination,
  );
  const needsDestination =
    destinations.length > 1 && !download.destination_id && saved.length !== 1;
  const destination =
    destinations.find((item) => item.id === destinationId) ||
    (download.destination_id
      ? destinations.find((item) => item.id === download.destination_id)
      : saved.length === 1
        ? saved[0]
        : destinations.length === 1
          ? destinations[0]
          : undefined);
  // Dewarr can read every file, but only a person can tell whether a multi-file
  // recording is missing a part. A single file is the whole download.
  const several =
    (group?.files.filter((file) => file.role === "media").length || 0) > 1;
  const confirmed = !several || complete;
  const confirm = useMutation({
    mutationFn: async () => {
      if (!prepared.current) {
        if (!data || !group || !destination || blocked || !confirmed)
          throw new Error("Refresh the review before importing.");
        const version =
          candidate?.version_id ||
          result(
            await api.POST(
              "/api/organization/inspections/{inspection_id}/editions",
              {
                params: { path: { inspection_id: inspection.id } },
                body: {
                  work_id: download.work_id,
                  group_key: group.key,
                  grouping_revision: data.grouping.revision,
                },
              },
            ),
          ).version_id;
        const plan = result(
          await api.POST(
            "/api/organization/inspections/{inspection_id}/plans",
            {
              params: { path: { inspection_id: inspection.id } },
              body: {
                inspection_revision: inspection.snapshot!.revision,
                grouping_revision: data.grouping.revision,
                profile_revision: data.settings.revision,
                include_covers: true,
                destinations: { [download.medium]: destination.id },
                selections: [
                  {
                    group_key: group.key,
                    work_id: download.work_id,
                    version_id: version,
                    full_content: true,
                    contents_confirmed: false,
                    ...(match?.status === "matched"
                      ? { match_revision: match.revision }
                      : {}),
                  },
                ],
              },
            },
          ),
        );
        prepared.current = {
          plan,
          destination: { id: destination.id, revision: destination.revision },
          key: randomUUID(),
        };
      }
      const frozen = prepared.current;
      return result(
        await api.POST("/api/organization/plans/{plan_id}/imports", {
          params: {
            path: { plan_id: frozen.plan.id },
            header: { "idempotency-key": frozen.key },
          },
          body: {
            plan_revision: frozen.plan.revision,
            destinations: { [download.medium]: frozen.destination },
          },
        }),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["inspection", inspection.id] }),
        cache.invalidateQueries({ queryKey: ["requests"] }),
      ]);
    },
  });
  const reject = useMutation({
    mutationFn: async () =>
      result(
        await api.POST("/api/organization/inspections/{inspection_id}/reject", {
          params: { path: { inspection_id: inspection.id } },
          body: { reason },
        }),
      ),
    onSuccess: async (value) => {
      await cache.invalidateQueries({ queryKey: ["requests"] });
      rejected(value);
    },
  });
  const audio = download.medium === "audio";
  return (
    <section className="download-attention" aria-label="Download next step">
      {context.isPending ? (
        <Loading />
      ) : data ? (
        <>
          <h3>
            {blocked
              ? "This download needs a closer look"
              : "Is this the book that was requested?"}
          </h3>
          <p role="status">
            {blocked
              ? problem
              : download.message ||
                "Compare the files with the request, then add them to the library."}
          </p>
          <DownloadComparison
            download={download}
            files={inspection.snapshot?.files || []}
            paths={group?.files.map((file) => file.path)}
            identifiers={match?.evidence.identifiers}
            evidenceTitles={match?.evidence.titles}
          />
          {rejecting ? (
            <form
              className="download-reject"
              onSubmit={(event) => {
                event.preventDefault();
                reject.mutate();
              }}
            >
              <label>
                What is wrong with this release?
                <select
                  value={reason}
                  disabled={reject.isPending}
                  onChange={(event) =>
                    setReason(event.target.value as RejectReason)
                  }
                >
                  <option value="wrong-book">Wrong book</option>
                  <option value="wrong-language">Wrong language</option>
                  {audio && (
                    <option value="wrong-narrator">Wrong narrator</option>
                  )}
                  <option value="incomplete">Missing parts or chapters</option>
                  {audio && <option value="bad-audio">Bad audio</option>}
                </select>
              </label>
              <p>
                Dewarr blocks this release for the request and looks for another
                one with the same requirements. The downloaded files stay in the
                download folder, so seeding continues.
              </p>
              <div className="actions">
                <button className="primary" disabled={reject.isPending}>
                  {reject.isPending ? "Rejecting…" : "Reject and find another"}
                </button>
                <button
                  type="button"
                  disabled={reject.isPending}
                  onClick={() => setRejecting(false)}
                >
                  Back
                </button>
              </div>
            </form>
          ) : (
            <>
              {!blocked && several && (
                <>
                  <p>
                    Dewarr read every file, but it cannot tell whether a part is
                    missing. Check the file list and the length before adding.
                  </p>
                  <label className="download-complete-check">
                    <input
                      type="checkbox"
                      checked={complete}
                      disabled={confirm.isPending || !!prepared.current}
                      onChange={(event) => setComplete(event.target.checked)}
                    />
                    <span>These files contain the complete book</span>
                  </label>
                </>
              )}
              {!blocked && needsDestination && (
                <label className="download-destination">
                  Library folder
                  <select
                    value={destinationId}
                    onChange={(event) => setDestinationId(event.target.value)}
                  >
                    <option value="">Choose a library folder</option>
                    {destinations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.backend_path}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!blocked &&
                (!destinations.length ||
                  (download.destination_id && !destination)) && (
                  <p>
                    Connect a library folder in{" "}
                    <Link to="/settings#naming">Library settings</Link> to
                    continue.
                  </p>
                )}
              <div className="actions">
                {!blocked && (
                  <button
                    className={mismatched ? undefined : "primary"}
                    disabled={!destination || !confirmed || confirm.isPending}
                    onClick={() => confirm.mutate()}
                  >
                    {confirm.isPending
                      ? "Adding to library…"
                      : prepared.current
                        ? "Retry import"
                        : "Add to library"}
                  </button>
                )}
                {blocked && !!unreadable.length && download.can_retry && (
                  <button
                    className="primary"
                    disabled={retrying}
                    onClick={retry}
                  >
                    {retrying ? "Checking files…" : "Check files again"}
                  </button>
                )}
                <button
                  className={
                    (mismatched || blocked) && !unreadable.length
                      ? "primary"
                      : undefined
                  }
                  disabled={confirm.isPending || !!prepared.current}
                  onClick={() => setRejecting(true)}
                >
                  Wrong book, find another
                </button>
                {!blocked && download.can_retry && (
                  <button
                    className="text-button"
                    disabled={retrying}
                    title="Run the automatic checks again, for example after correcting the book's catalog details"
                    onClick={retry}
                  >
                    {retrying ? "Checking…" : "Check again"}
                  </button>
                )}
              </div>
              {!blocked && destination && (
                <p className="download-handling">
                  Adds a copy to {destination.backend_path}. The download stays
                  where it is, so seeding continues.
                </p>
              )}
              {blocked && (
                <p className="download-links">
                  <Link to={`/books/${download.work_id}?tab=sources`}>
                    Choose a release yourself
                  </Link>
                  <Link to={`/books/${download.work_id}?tab=manage`}>
                    Review book metadata
                  </Link>
                </p>
              )}
            </>
          )}
        </>
      ) : null}
      <Notice error={context.error || confirm.error || reject.error} />
      {context.isError && (
        <button
          disabled={context.isFetching}
          onClick={() => void context.refetch()}
        >
          {context.isFetching ? "Refreshing…" : "Refresh review"}
        </button>
      )}
    </section>
  );
}
