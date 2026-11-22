import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, result } from "../api/client";
import type { components } from "../api/schema";
import { Loading, Notice } from "../components";
import BookDialog from "./BookDialog";

type Reason = components["schemas"]["ReportInput"]["reason"];

/** A requester's held download: why it stopped, and rejecting it themselves. */
export default function OwnDownloadReview({
  attemptId,
  close,
}: {
  attemptId: string;
  close: () => void;
}) {
  const cache = useQueryClient();
  const review = useQuery({
    queryKey: ["own-download-review", attemptId],
    queryFn: async ({ signal }) =>
      result(
        await api.GET("/api/acquisition/downloads/{attempt_id}/review", {
          signal,
          params: { path: { attempt_id: attemptId } },
        }),
      ),
  });
  const data = review.data;
  const audio = data?.medium === "audio";
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<Reason>("wrong-book");
  const reject = useMutation({
    mutationFn: async () =>
      result(
        await api.POST("/api/acquisition/recovery/reports", {
          body: {
            selection_id: data!.selection_id,
            reason,
            require_approval: false,
          },
        }),
      ),
    onSuccess: async () => {
      await Promise.all(
        ["requests", "downloads", "book-downloads", "release-blocklist"].map(
          (key) => cache.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
  return (
    <BookDialog title="Review download" close={close}>
      <div className="own-download-review">
        {review.isPending ? (
          <Loading />
        ) : reject.isSuccess ? (
          <>
            <h3>Looking for another release</h3>
            <p role="status">
              This release is blocked for your request, and Dewarr is searching
              for another one with the same requirements. The rejected files
              stay in the download folder.
            </p>
            <div className="actions">
              <button className="primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        ) : data ? (
          <>
            <h3>{data.title}</h3>
            <p role="status">{data.message}</p>
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
                      setReason(event.target.value as Reason)
                    }
                  >
                    <option value="wrong-book">Wrong book</option>
                    <option value="wrong-language">Wrong language</option>
                    {audio && (
                      <option value="wrong-narrator">Wrong narrator</option>
                    )}
                    <option value="incomplete">
                      Missing parts or chapters
                    </option>
                    {audio && <option value="bad-audio">Bad audio</option>}
                  </select>
                </label>
                <p>
                  Dewarr blocks this release for your request and looks for
                  another one with the same requirements. The downloaded files
                  stay in the download folder, so seeding continues.
                </p>
                <div className="actions">
                  <button className="primary" disabled={reject.isPending}>
                    {reject.isPending
                      ? "Rejecting…"
                      : "Reject and find another"}
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
                <p className="muted">
                  An administrator can add these files to the library. If this
                  is not the book you wanted, reject the release and Dewarr will
                  look for another one.
                </p>
                <div className="actions">
                  {data.can_reject && (
                    <button
                      className="primary"
                      onClick={() => setRejecting(true)}
                    >
                      Wrong book, find another
                    </button>
                  )}
                  <button onClick={close}>Close</button>
                </div>
              </>
            )}
          </>
        ) : null}
        <Notice error={review.error || reject.error} />
      </div>
    </BookDialog>
  );
}
