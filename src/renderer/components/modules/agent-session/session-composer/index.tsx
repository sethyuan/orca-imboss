import { formatAttachmentSize } from "@shared/attachment-size";
import { t } from "@shared/l10n";
import type {
  AgentSessionAttachment,
  AgentSessionSendResult,
} from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appStore, sessionKey, useAppSync } from "../../../../app-store";
import { EMPTY_DRAFT, toPlainAttachment } from "../../../../chat-draft";
import { EMPTY_COMMENTS, toPlainComments } from "../../../../comment-draft";
import { newImageAnnotation } from "../../../../image-annotation-draft";
import { prepareAnnotatedSend } from "../../../../image-annotation-send";
import type { DraftAnnotationProps } from "../../chat/attachment-draft";
import { PendingComments } from "../../chat/pending-comments";
import {
  ComposerCard,
  type ComposerDraftBinding,
  type ComposerHandle,
} from "../../chat/composer-card";

/** How long a post-send notice stays (mirrors the chat composer's). */
const NOTICE_MS = 6000;

export interface SessionComposerProps {
  employeeId: number;
  /** Chat the session belongs to (already normalized to the root chat). */
  chatId: number;
  /** Receiving employee's display name (the "to" label). */
  employeeName: string;
  /**
   * Cosmetic run state: while a run is streaming the same action is a
   * **steer** (handed over after the current turn) instead of a plain prompt.
   * Routing is decided main-side; this only changes the copy.
   */
  streaming: boolean;
  /**
   * Text a withdrawn interjection hands back to the composer, as a one-shot
   * `{ text, token }` value: withdrawing is "take that sentence back", so the
   * boss can fix and re-send it instead of retyping. `token` makes a repeated
   * withdrawal of equal text a fresh request.
   */
  refill: { text: string; token: number } | null;
  /**
   * Called after the main process accepted the send (the draft is already
   * cleared). `text` is what the boss typed — empty for a file-only send, which
   * the placeholder row renders as chips instead.
   */
  onSent: (
    text: string,
    result: AgentSessionSendResult,
    attachments: AgentSessionAttachment[],
  ) => void;
}

/**
 * Bottom composer of the read-only agent-session view: the boss types a message
 * (with optional attachments) and it is injected into **this** `(employee,
 * chat)` Pi session only.
 *
 * It renders the same `ComposerCard` as the chat composer — same chips, same
 * attach menu (File / Folder / Conversation), same drop and paste handling, so
 * "what you can add and how" cannot drift between the two views. What it does
 * **not** have is everything chat-specific: no common-project rows (those also
 * write tags into a conversation), no `@`-mention popup, no tags or title side
 * effects.
 *
 * The draft lives on the app store per session key (`sessionDrafts`) so
 * switching modules does not lose it; the card's textarea is uncontrolled
 * (React never rewrites the DOM value, so IME composition and the first
 * keystrokes are never disturbed). The only run-state affordance is the send
 * button's label (`Send` vs `Interject`).
 */
export function SessionComposer({
  employeeId,
  chatId,
  employeeName,
  streaming,
  refill,
  onSent,
}: SessionComposerProps): React.JSX.Element {
  const snap = useAppSync();
  const draftKey = sessionKey(employeeId, chatId);
  const draft = snap.sessionDrafts[draftKey] ?? EMPTY_DRAFT;
  const attachments = draft.attachments;
  // Comments queued for the next turn: their `[Comments]` block is the only
  // storage a session prompt has (nothing is written to `messages`), so they
  // must travel with this exact send.
  const pendingComments = snap.sessionComments[draftKey] ?? EMPTY_COMMENTS;
  /** Annotation of the draft's pictures, bound to the chip ids of this draft. */
  const draftAnnotation = useMemo<DraftAnnotationProps>(
    () => ({
      comments: pendingComments,
      add: (attachmentId, attachmentName, mark, note) =>
        appStore.addSessionComment(
          draftKey,
          newImageAnnotation(
            { kind: "draft", attachmentId, attachmentName },
            mark,
            note,
          ),
        ),
      updateNote: (key, note) => {
        const id = Number(key);
        if (Number.isSafeInteger(id))
          appStore.updateSessionComment(draftKey, id, note);
      },
      remove: (key) => {
        const id = Number(key);
        if (Number.isSafeInteger(id))
          appStore.removeSessionComment(draftKey, id);
      },
    }),
    [draftKey, pendingComments],
  );

  const cardRef = useRef<ComposerHandle>(null);
  /** Guards a double submit before the first render lands (`sending` is async). */
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (live: string): Promise<void> => {
      if (sendingRef.current) return;
      // `live` is what the card read from the DOM (uncontrolled textarea): the
      // store may be one input event behind on the very first paste.
      const value = live;
      if (
        value.trim().length === 0 &&
        attachments.length === 0 &&
        pendingComments.length === 0
      ) {
        return;
      }

      sendingRef.current = true;
      setSending(true);
      setError(null);
      const plainAttachments = attachments.map((item) =>
        toPlainAttachment(item.attachment),
      );
      const prepared = await prepareAnnotatedSend({
        chatId,
        attachments: plainAttachments,
        draftAttachments: attachments.map((item) => ({
          id: item.id,
          attachment: toPlainAttachment(item.attachment),
        })),
        pending: pendingComments,
      });
      try {
        const result = await imb.agentSession.send(
          employeeId,
          chatId,
          value,
          prepared.attachments.length > 0 ? prepared.attachments : undefined,
          prepared.comments ?? toPlainComments(pendingComments),
        );
        // Accepted: clear the DOM and the draft together, otherwise a remount
        // would resurrect text that is already on its way to the agent.
        cardRef.current?.clear();
        appStore.clearSessionComments(draftKey);
        // The placeholder row shows the same chips the transcript will, so a
        // file-only send is not an empty bubble (and the row still matches its
        // projection, which strips the prompt's attachment block to `""`).
        // The placeholder row shows the pictures that were actually sent — the
        // marked copies, not the originals.
        onSent(
          value,
          result,
          prepared.attachments.map((attachment) =>
            toSessionAttachment(attachment),
          ),
        );
        if (prepared.warnings.length > 0) {
          // After the send: it describes the picture that just went out unmarked
          // (the coordinates still travelled), and no internal file name. It clears
          // itself, so it can never be read as a warning about the next message.
          cardRef.current?.notify(
            t(
              "The marked copy could not be made, so the picture was sent as-is.",
            ),
          );
          window.setTimeout(() => cardRef.current?.notify(null), NOTICE_MS);
        }
        cardRef.current?.focus();
      } catch (err) {
        // Keep the text (nothing typed may be lost) and surface the reason: only
        // an invalid request reaches here — run failures arrive as events.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [attachments, chatId, draftKey, employeeId, onSent, pendingComments],
  );

  const actionLabel = streaming ? t("Interject") : t("Send");

  // A withdrawn interjection comes back here. The textarea is uncontrolled (its
  // DOM value is the source of truth), so the value is written imperatively and
  // mirrored into the store — exactly like a paste would. Done in an effect so
  // the write happens after React commits, and guarded by `token` so a re-render
  // never repeats it. Attachments are not restored (a withdrawal only hands the
  // text back; the interjection record carries no attachment list).
  const refillTokenRef = useRef(0);
  useEffect(() => {
    if (!refill || refill.token === refillTokenRef.current) return;
    refillTokenRef.current = refill.token;
    cardRef.current?.setText(refill.text, refill.text.length);
  }, [refill]);

  const binding: ComposerDraftBinding = {
    draft,
    storageChatId: chatId,
    setText: (value) => appStore.setSessionDraftText(draftKey, value),
    addAttachments: (items) =>
      appStore.addSessionDraftAttachments(draftKey, items),
    removeAttachment: (index) =>
      appStore.removeSessionDraftAttachment(draftKey, index),
    clearDraft: () => appStore.clearSessionDraft(draftKey),
    // Live store read (never the snapshot): a cap re-check must see a chip that
    // an async add committed after this render.
    attachmentCount: () =>
      appStore.sessionDrafts[draftKey]?.attachments.length ?? 0,
  };

  return (
    <ComposerCard
      ref={cardRef}
      binding={binding}
      className="imb-session-composer"
      placeholder={t("Message ${name} directly", { name: employeeName })}
      actionLabel={actionLabel}
      // Not `disabled`: the boss may keep typing while a send is in flight, so
      // only the send button is held back.
      sendDisabled={sending}
      error={error}
      resetKey={draftKey}
      onSend={(live) => void send(live)}
      draftAnnotation={draftAnnotation}
      pendingComments={{
        count: pendingComments.length,
        node: (
          <PendingComments
            comments={pendingComments}
            onEdit={(id, note) =>
              appStore.updateSessionComment(draftKey, id, note)
            }
            onRemove={(id) => appStore.removeSessionComment(draftKey, id)}
          />
        ),
      }}
    />
  );
}

/**
 * The composer's chip metadata in the transcript's display shape, so the
 * placeholder row renders exactly like the row that replaces it.
 *
 * Only the fields the view draws: a folder contributes its name, a conversation
 * reference its chat id, a file its name/type/size label. (The prompt's own
 * `[Attachments]` block is what the session view parses; this is the same data
 * from the renderer's side, so the two paths agree without duplicating text.)
 *
 * Exported because the chat module's **direct chat** composer feeds the same
 * placeholder row from a stored-message attachment (`MessageAttachment`).
 */
export function toSessionAttachment(source: {
  name: string;
  size: number;
  type: string;
  kind?: "file" | "folder" | "chat";
  path?: string;
  chatId?: number;
}): AgentSessionAttachment {
  const kind =
    source.kind === "folder" || source.kind === "chat" ? source.kind : "file";
  const attachment: AgentSessionAttachment = { name: source.name, kind };
  if (kind === "file") {
    if (source.type.length > 0) attachment.type = source.type;
    // Same formatter the prompt uses, so the label never changes when the
    // placeholder row is replaced by the transcription.
    attachment.sizeLabel = formatAttachmentSize(source.size);
  }
  if (typeof source.path === "string" && source.path.length > 0) {
    attachment.path = source.path;
  }
  if (kind === "chat" && typeof source.chatId === "number") {
    attachment.chatId = source.chatId;
  }
  return attachment;
}
