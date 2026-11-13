/**
 * The two hooks that answer "what is annotated on this picture, and where does a
 * new annotation go" for the two surfaces that render pictures in a thread: a
 * stored chat, and an agent-session transcript.
 *
 * Both produce the same {@link ImageAnnotationApi}, so a picture component (and
 * the lightbox it opens) never has to know which one it is inside.
 *
 * Marks already sent are derived from the rows' own `comments`: an annotation lives
 * on the message that *carried* it, not on the message it points at, so the only
 * way to find the marks of a picture is to walk the conversation. That walk is
 * memoised on the rows.
 */
import { MAX_COMMENTS_PER_MESSAGE } from "@shared/constants/comments";
import { t } from "@shared/l10n";
import type { MessageComment } from "@shared/types";
import { useMemo, useState } from "react";
import { appStore, useApp } from "../../../../app-store";
import {
  newImageAnnotation,
  pendingMarkViews,
} from "../../../../image-annotation-draft";
import type { PendingComment } from "../../../../comment-draft";
import type {
  ImageAnnotationApi,
  PictureLocation,
  PendingImageAnnotations,
} from "./context";
import type { MarkView } from "./marks-layer";

/** One row that can carry annotations of pictures. */
export interface AnnotatableRow {
  /** Identity of the row as a `[Comments]` target names it. */
  source: PictureLocation["source"];
  comments: readonly MessageComment[] | null;
}

/** Identity of one picture, as {@link sentIndex} keys its marks. */
function sentKey(picture: PictureLocation): string {
  const owner =
    picture.source.kind === "message"
      ? `m${picture.source.messageId}`
      : `e${picture.source.entryId}`;
  return `${owner}:${picture.attachmentIndex}`;
}

/** Identity of the row that carried an annotation. */
function batchKey(source: PictureLocation["source"]): string {
  return source.kind === "message"
    ? `m${source.messageId}`
    : `e${source.entryId}`;
}

/**
 * Index the marks an earlier batch left on each picture, keyed by picture.
 *
 * A picture annotated by **several** batches renders per decision ③:
 *
 * - the **newest** batch (the last row that annotated it, rows being in
 *   chronological order) keeps the normal register: red, numbered, and the numbers
 *   are the ones that batch's own cards show;
 * - every **other** batch is drawn as a grey dashed mark with **no number** and no
 *   interaction. Two batches cannot both be `#1`, and a mark whose ordinal means
 *   nothing is worse than one without any.
 *
 * Within one batch the register never mixes: red and numbered throughout.
 */
function sentIndex(
  rows: readonly AnnotatableRow[],
): (picture: PictureLocation) => MarkView[] {
  const byPicture = new Map<string, MarkView[]>();
  /** Batch that most recently annotated each picture (rows are chronological). */
  const newest = new Map<string, string>();
  for (const row of rows) {
    const batch = batchKey(row.source);
    (row.comments ?? []).forEach((comment, index) => {
      const target = comment.anchor.target;
      if (target.kind !== "image") return;
      // A picture of the carrying message itself was **replaced** by its marked copy
      // at send time, so its marks are already in the pixels: drawing them again
      // would stack a second badge a few pixels off (the screen floor and the bake
      // floor cannot agree exactly). Pictures of *earlier* messages keep their
      // original bytes, which is exactly why those need the overlay.
      if (target.source === null) return;
      const mark = comment.anchor.mark;
      if (mark === undefined) return;
      // The picture lives where the annotation *points* (`target.source`), which is
      // the **earlier** message for an annotation of an old picture; only an
      // annotation of the carrying message's own attachment has no source of its own.
      const picture: PictureLocation = {
        source: target.source ?? row.source,
        attachmentIndex: target.attachmentIndex,
        attachmentName: target.attachmentName,
        annotatable: true,
      };
      const key = sentKey(picture);
      const views = byPicture.get(key) ?? [];
      views.push({
        key: `${batch}:${index}`,
        mark,
        ordinal: index + 1,
        note: comment.note,
        sent: true,
      });
      byPicture.set(key, views);
      newest.set(key, batch);
    });
  }
  for (const [key, views] of byPicture) {
    const latest = newest.get(key);
    const batches = new Set(views.map((view) => view.key.split(":")[0] ?? ""));
    if (batches.size <= 1) continue;
    byPicture.set(
      key,
      views.map((view) =>
        view.key.startsWith(`${latest}:`)
          ? view
          : { ...view, ordinal: undefined, historical: true },
      ),
    );
  }
  return (picture) => byPicture.get(sentKey(picture)) ?? [];
}

/** Where a new annotation of a thread picture is stored. */
interface PendingStore {
  add(comment: PendingComment): void;
  update(id: number, note: string): void;
  remove(id: number): void;
}

/** The composer batch, adapted to what pictures need. */
function pendingSurface(
  comments: readonly PendingComment[],
  store: PendingStore,
): PendingImageAnnotations {
  const full = comments.length >= MAX_COMMENTS_PER_MESSAGE;
  return {
    count: comments.length,
    canAnnotate: !full,
    ...(full
      ? {
          unavailableReason: t("Already ${count} annotations in this batch.", {
            count: String(MAX_COMMENTS_PER_MESSAGE),
          }),
        }
      : {}),
    viewsFor: (picture) =>
      pendingMarkViews(comments, {
        kind: "sent",
        source: picture.source,
        attachmentIndex: picture.attachmentIndex,
        attachmentName: picture.attachmentName,
      }),
    add: (picture, mark, note) =>
      store.add(
        newImageAnnotation(
          {
            kind: "sent",
            source: picture.source,
            attachmentIndex: picture.attachmentIndex,
            attachmentName: picture.attachmentName,
            // Without this the send has no way to read the original pixels and the
            // marked copy cannot be baked (the annotation would go out as
            // coordinates only). It stays draft-only: the record never stores a path.
            ...(picture.src === undefined ? {} : { src: picture.src }),
          },
          mark,
          note,
        ),
      ),
    updateNote: (key, note) => {
      const id = Number(key);
      if (Number.isSafeInteger(id)) store.update(id, note);
    },
    remove: (key) => {
      const id = Number(key);
      if (Number.isSafeInteger(id)) store.remove(id);
    },
  };
}

/** Mark generator kept out of the component path: an image mark is plain data. */
function useSurface(
  rows: readonly AnnotatableRow[],
  pending: readonly PendingComment[],
  store: PendingStore,
): ImageAnnotationApi {
  const index = useMemo(() => sentIndex(rows), [rows]);
  const surface = useMemo(
    () => pendingSurface(pending, store),
    [pending, store],
  );
  // Which mark a comment card is pointing at (hover). Kept here, above both ends,
  // because a card and the picture it annotates live in different rows.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  return useMemo(
    () => ({ sentMarks: index, pending: surface, focusKey, setFocusKey }),
    [index, surface, focusKey],
  );
}

/** Annotation surface of one stored conversation. */
export function useChatImageAnnotations(
  chatId: number,
  rows: readonly AnnotatableRow[],
): ImageAnnotationApi {
  const snap = useApp();
  const pending = snap.chatComments[chatId] ?? [];
  const store = useMemo<PendingStore>(
    () => ({
      add: (comment) => appStore.addChatComment(chatId, comment),
      update: (id, note) => appStore.updateChatComment(chatId, id, note),
      remove: (id) => appStore.removeChatComment(chatId, id),
    }),
    [chatId],
  );
  return useSurface(rows, pending as readonly PendingComment[], store);
}

/** Annotation surface of one agent-session transcript (`sessionKey`). */
export function useSessionImageAnnotations(
  sessionKey: string,
  rows: readonly AnnotatableRow[],
): ImageAnnotationApi {
  const snap = useApp();
  const pending = snap.sessionComments[sessionKey] ?? [];
  const store = useMemo<PendingStore>(
    () => ({
      add: (comment) => appStore.addSessionComment(sessionKey, comment),
      update: (id, note) => appStore.updateSessionComment(sessionKey, id, note),
      remove: (id) => appStore.removeSessionComment(sessionKey, id),
    }),
    [sessionKey],
  );
  return useSurface(rows, pending as readonly PendingComment[], store);
}

/** Exported for the equivalence harness: the plain-data part of the same rule. */
export function sentMarksFor(
  rows: readonly AnnotatableRow[],
  picture: PictureLocation,
): MarkView[] {
  return sentIndex(rows)(picture);
}
