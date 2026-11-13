import { t } from "@shared/l10n";
import { useCallback, useMemo, useRef, useState } from "react";
import { appStore, IS_MAC, sessionKey, useApp } from "../../../../app-store";
import { EMPTY_COMMENTS, nextCommentId } from "../../../../comment-draft";
import type { CommentSurface } from "../../../../comment-draft";
import { ModuleView } from "../../../app-shell";
import { EmployeeAvatar } from "../../../employee-avatar";
import { HaltButton } from "../../../halt-button";
import { IconButton } from "../../../icon-button";
import { IconHalt, IconSearch } from "../../../icons";
import { Tooltip } from "../../../tooltip";
import { MyMessageJump } from "../../chat/my-message-jump";
import { SessionComposer } from "../session-composer";
import {
  useSessionImageAnnotations,
  type AnnotatableRow,
} from "../../chat/image-annotation/use-image-annotations";
import { SessionThread } from "../agent-session-view/session-thread";
import { useSessionView } from "../agent-session-view/use-session-view";
import "./index.css";

export interface AgentSessionModuleProps {
  employeeId: number;
  chatId: number;
}

/**
 * Read-only view of one `(employee, chat)` agent session, opened from the Nav.
 *
 * The state, streaming, scroll and find behaviour lives in `useSessionView()`
 * and the transcript itself in `<SessionThread>` — both shared with the chat
 * module's employee direct chat, so the two can never drift into two different
 * session views. This module only adds the single-pane chrome: the session
 * header (employee + conversation links, interrupt, my messages, find), the
 * in-flow error line and the session composer.
 */
export function AgentSessionModule({
  employeeId,
  chatId,
}: AgentSessionModuleProps): React.JSX.Element {
  const { data, openedItems, sessionComments } = useApp();
  /**
   * Failure of the header's "open this session's conversation" link. Kept apart
   * from the session's own `error`/`runError` because it says nothing about the
   * session.
   */
  const [linkError, setLinkError] = useState<string | null>(null);
  /** The link's IPC round-trip is in flight (also disables the button). */
  const [linkBusy, setLinkBusy] = useState(false);
  /** Synchronous mirror of `linkBusy` (guards double clicks in one frame). */
  const linkBusyRef = useRef(false);

  const view = useSessionView(employeeId, chatId);
  const {
    streaming,
    threadRef,
    myEntries,
    jumpToEntry,
    jumpToLatest,
    threadFind,
  } = view;

  // --- Comments --------------------------------------------------------------
  // A session prompt is never written to `messages`, so the `[Comments]` block of
  // the prompt **is** the storage of a comment written here: the projection reads
  // it back (`entry.comments`) and the layer draws both the cards and the tints
  // from it. Drafts live on the store per session key, like this composer's text.
  const draftKey = sessionKey(employeeId, chatId);
  const pendingComments = sessionComments[draftKey] ?? EMPTY_COMMENTS;
  const sentComments = useMemo(
    () =>
      view.entries.flatMap((entry) =>
        entry.kind === "user" ? (entry.comments ?? []) : [],
      ),
    [view.entries],
  );
  const commentSurface = useMemo<CommentSurface>(
    () => ({
      kind: "session",
      pending: pendingComments,
      sent: sentComments,
      add: (anchor, note) =>
        appStore.addSessionComment(draftKey, {
          id: nextCommentId(),
          anchor,
          note,
        }),
      remove: (id) => appStore.removeSessionComment(draftKey, id),
    }),
    [draftKey, pendingComments, sentComments],
  );

  /**
   * Image annotations of this transcript: the batch is the session composer's
   * (`draftKey`), so the pictures join the very same list the text annotations do.
   */
  const annotationRows = useMemo<AnnotatableRow[]>(
    () =>
      view.entries.flatMap((entry) =>
        entry.kind === "user"
          ? [
              {
                source: { kind: "entry" as const, entryId: entry.id },
                comments: entry.comments ?? null,
              },
            ]
          : [],
      ),
    [view.entries],
  );
  const chatAnnotation = useSessionImageAnnotations(draftKey, annotationRows);

  const sessionItem = openedItems.find(
    (item) =>
      item.kind === "session" &&
      item.employeeId === employeeId &&
      item.chatId === chatId,
  );
  const session = sessionItem?.kind === "session" ? sessionItem : null;
  const employee = data.employees.items.find((e) => e.id === employeeId);
  const employeeName = employee?.name ?? t("Unnamed");
  const chatTitle = session?.chatTitle ?? t("Conversation");
  /** Label of the header's interrupt action (also its accessible name). */
  const interruptLabel = t("Interrupt current turn");

  /**
   * Jump to the conversation this session belongs to (the chat title in the
   * header). Root chats open in the Chat module, task group chats in their own
   * view — `appStore.openConversationById` owns that routing (it is the same
   * rule the chat cards and cron jobs use); here we only report failures.
   *
   * The session itself stays in the Nav and a running turn is untouched: this
   * view merely unmounts, and `agentSession.unbind` keeps main-side runs going.
   */
  const openConversation = useCallback(async (): Promise<void> => {
    // Ref-guarded, not just `disabled`: two clicks inside one frame would both
    // pass a state check and fire two IPC round-trips.
    if (linkBusyRef.current) return;
    linkBusyRef.current = true;
    setLinkBusy(true);
    setLinkError(null);
    try {
      const opened = await appStore.openConversationById(chatId);
      if (!opened) setLinkError(t("Conversation unavailable"));
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      linkBusyRef.current = false;
      setLinkBusy(false);
    }
  }, [chatId]);

  const content = (
    <>
      <div className="imb-chat-header">
        <div className="imb-chat-header-avatar">
          <EmployeeAvatar employeeId={employeeId} size={30} showName />
        </div>
        <div className="imb-session-heading">
          {/* The employee's name links to their detail pane (Employees module).
              Plain text while the employee collection does not resolve the id
              (a deleted employee has no detail page to open). */}
          {employee !== undefined ? (
            <Tooltip placement="bottom" content={t("View employee details")}>
              <button
                type="button"
                className="imb-chat-title imb-session-employee-link"
                // The tooltip is the visible hint; drop the native duplicate.
                title=""
                aria-label={`${t("View employee details")}: ${employeeName}`}
                onClick={() => void appStore.openEmployeeDetail(employeeId)}
              >
                {employeeName}
              </button>
            </Tooltip>
          ) : (
            <div className="imb-chat-title">{employeeName}</div>
          )}
          {/* The conversation this session belongs to — a button, because the
              boss wants "click the group title → go to that group". Muted at
              rest (it is a caption) and accent on hover only: no underline, no
              permanent icon (boss's call). The tooltip carries the full title,
              which the row itself may ellipsize. */}
          <Tooltip placement="bottom" content={chatTitle} disabled={linkBusy}>
            <button
              type="button"
              className="imb-session-subtitle imb-session-chat-link"
              // The Tooltip is the visible hint; drop the native duplicate.
              title=""
              aria-label={`${t("Open chat")}: ${chatTitle}`}
              disabled={linkBusy}
              onClick={() => void openConversation()}
            >
              {chatTitle}
            </button>
          </Tooltip>
        </div>
        {/* Header trailing actions: the boss's messages, find, and interrupt.
            One `margin-left: auto` on the group keeps all three pinned right
            (two auto margins would split the free space and float the group's
            first control towards the middle). Same order and styling as the
            chat views: the panel entry sits immediately left of find. */}
        <div className="imb-session-header-actions">
          {/* Interrupts the current turn of *this* session only (queued work is
            kept, the session stays alive). One click, no confirmation: stopping
            a single turn is cheap and simply talking again resumes the work.
            Disabled while the session is idle — `interruptTurn` is a no-op
            then, and a greyed chip states that honestly.

            Deliberately independent from the composer's send/interject button:
            steer keeps the running turn, interrupt throws it away, so the
            destructive action must not share the highest-traffic control. */}
          <HaltButton
            className="imb-session-interrupt"
            label={interruptLabel}
            confirm={false}
            disabled={!streaming}
            onInterrupt={() =>
              imb.agentSession.interruptTurn(employeeId, chatId)
            }
          >
            <IconHalt />
          </HaltButton>
          <MyMessageJump
            threadRef={threadRef}
            entries={myEntries}
            onSelect={jumpToEntry}
            onLatest={jumpToLatest}
          />
          {/* Find entry: the same action as ⌘F (open + focus, or re-select the
              term when the bar is already up). `aria-pressed` states whether
              the bar is open; it never toggles it closed — that would make the
              button behave differently from the shortcut. */}
          <Tooltip
            placement="bottom"
            content={`${t("Find in chat")} · ${IS_MAC ? "⌘F" : "Ctrl+F"}`}
          >
            <IconButton
              className="imb-chat-find"
              label={t("Find in chat")}
              aria-pressed={threadFind.open}
              // The bubble above is the hint; an empty `title` suppresses the
              // native (duplicate) one the component would otherwise add.
              title=""
              boxSize={28}
              size={16}
              onClick={threadFind.openFind}
            >
              <IconSearch />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <SessionThread
        view={view}
        comments={commentSurface}
        annotation={chatAnnotation}
      />
      {view.error !== null || view.runError !== null || linkError !== null ? (
        // In flow, above the composer: the shared `.imb-chat-error` is a fixed
        // toast that would land on top of the composer here.
        <p className="imb-error-text imb-session-error" role="alert">
          {view.error ?? view.runError ?? linkError}
        </p>
      ) : null}
      {/* The view's only write affordance — injects into this very session
          (nothing is written to the conversation). */}
      <SessionComposer
        employeeId={employeeId}
        chatId={chatId}
        employeeName={employeeName}
        streaming={streaming}
        refill={view.refill}
        onSent={view.handleSent}
      />
    </>
  );

  return <ModuleView content={content} />;
}
