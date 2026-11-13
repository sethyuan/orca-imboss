import { isAttachmentOnlyBlurb } from "@shared/attachment-blurb";
import { t } from "@shared/l10n";
import type { AgentSessionViewEntry } from "@shared/types";
import { useCallback, useEffect, useState } from "react";
import { cls } from "reactutils";
import { appStore } from "../../../../app-store";
import type { CommentSurface } from "../../../../comment-draft";
import { IconButton } from "../../../icon-button";
import { IconChevronDown, IconChevronUp } from "../../../icons";
import { Markdown } from "../../../markdown";
import { CommentCards } from "../../chat/comment-card";
import { CommentLayer } from "../../chat/comment-layer";
import {
  ImageAnnotationContext,
  type ImageAnnotationApi,
} from "../../chat/image-annotation/context";
import { ThreadFindBar } from "../../chat/thread-find";
import {
  isMediaOnlyAttachments,
  SessionAttachments,
} from "../session-attachments";
import type {
  PendingFeedback,
  PendingSend,
} from "../agent-session-module/pending-sends";
import type {
  JumpAvailability,
  LiveBlock,
  SessionView,
} from "./use-session-view";

/**
 * Wording of a row's one-shot report (see `PendingFeedback`).
 *
 * Withdrawal is a normal outcome, not an error: Pi may already have injected the
 * text, or the queue may no longer hold it. The row says which, and then removes
 * itself (`FEEDBACK_MS`) — the one thing that must never happen is the boss
 * believing a message was taken back when the model has already read it.
 */
function pendingFeedbackLabel(feedback: PendingFeedback): string {
  switch (feedback) {
    case "delivered":
      return t("Delivered — cannot withdraw");
    case "gone":
      return t("No longer pending — cannot withdraw");
    case "lost":
      // Not a withdrawal: the run ended / was interrupted / the session was torn
      // down while the text was still queued, so it may never arrive.
      return t("Not confirmed — the agent may not have received this");
    default:
      return t("Withdrawal status unknown");
  }
}

/** How long a one-shot feedback line stays before the row removes itself. */
const FEEDBACK_MS = 4000;

/**
 * Content roots a comment may be anchored in, inside one session row.
 *
 * An assistant `text` entry (`.imb-session-text`) and the boss's own prompt
 * (`.imb-session-user-text`). Thinking blocks, tool arguments and compaction
 * summaries are deliberately absent: they are transcript chrome, and an
 * annotation of a folded thinking block could not be read back after a reload.
 */
const COMMENT_CONTENT_SELECTOR = ".imb-session-text, .imb-session-user-text";

/**
 * The session transcript: history entries, the live tail, the sent-but-not-yet
 * visible rows, the in-thread find bar and the divider jump buttons.
 *
 * Purely presentational — every piece of state comes from `useSessionView()` in
 * the host, which is what keeps the two hosts (the agent-session module and an
 * employee direct chat inside the chat module) byte-identical in behaviour.
 */
export function SessionThread({
  view,
  comments,
  annotation = null,
}: {
  view: SessionView;
  /**
   * Comments of this transcript (pending drafts plus the sent ones) and the
   * mutations the comment layer needs. `undefined` disables commenting, which is
   * how a host without a composer for this session states that.
   */
  comments?: CommentSurface;
  /**
   * Annotation surface for the pictures in this transcript (`null` ⇒ they are
   * inert). The host owns it because only the host knows which store the batch
   * lives in — an agent-session prompt and a chat message use different ones even
   * though this component renders both.
   */
  annotation?: ImageAnnotationApi | null;
}): React.JSX.Element {
  const {
    employeeId,
    chatId,
    resolveMention,
    entries,
    loading,
    liveBlocks,
    pending,
    threadRef,
    handleScroll,
    dividerCount,
    threadFind,
    jump,
    jumpTo,
    isThinkingOpen,
    onToggleThinking,
    dismissPending,
    withdrawPending,
    openConversationById,
  } = view;

  return (
    <ImageAnnotationContext.Provider value={annotation}>
      <>
        {/* The thread and the floating jump control share a positioned wrapper so
          the control can sit above the composer without a fixed offset. */}
        <div className="imb-session-thread-wrap">
          <div
            className={cls(
              "imb-thread imb-session-thread",
              dividerCount > 0 && "imb-has-jumps",
            )}
            ref={threadRef}
            // Focus target after the find bar closes (nothing to restore when the
            // composer was not the trigger).
            tabIndex={-1}
            onScroll={handleScroll}
          >
            {!loading &&
            entries.length === 0 &&
            liveBlocks.length === 0 &&
            pending.length === 0 ? (
              <div className="imb-chat-empty-detail">
                {t("No session content yet")}
              </div>
            ) : (
              <>
                {entries.map((entry, index) => (
                  <SessionEntry
                    key={entry.id}
                    entry={entry}
                    first={index === 0}
                    resolveMention={resolveMention}
                    employeeId={employeeId}
                    chatId={chatId}
                    isThinkingOpen={isThinkingOpen}
                    onToggleThinking={onToggleThinking}
                  />
                ))}
                {liveBlocks.map((block) => (
                  <LiveBlockView
                    key={block.key}
                    block={block}
                    resolveMention={resolveMention}
                    isThinkingOpen={isThinkingOpen}
                    onToggleThinking={onToggleThinking}
                  />
                ))}
              </>
            )}
            {pending.map((item) => (
              <PendingSendRow
                key={item.id}
                item={item}
                onDismiss={dismissPending}
                onWithdraw={withdrawPending}
                onOpenConversation={openConversationById}
              />
            ))}
          </div>
          {threadFind.open && <ThreadFindBar find={threadFind} />}
          {comments !== undefined && (
            // Mounted inside the positioned wrapper (not the scrolling thread) so
            // the portaled toolbar survives scrolling. Commenting only applies to
            // **settled** rows: a live streaming block carries no
            // `data-commentable`, because its text is still growing and its id is
            // replaced by the persisted entry id when the run ends — an anchor
            // written there could never be resolved again.
            <CommentLayer
              threadRef={threadRef}
              comments={comments}
              contentSelector={COMMENT_CONTENT_SELECTOR}
              revision={entries}
            />
          )}
          {dividerCount > 0 && (
            <SessionJumpButtons availability={jump} onJump={jumpTo} />
          )}
        </div>
      </>
    </ImageAnnotationContext.Provider>
  );
}

/** Render one projected history entry. */
function SessionEntry({
  entry,
  first,
  resolveMention,
  employeeId,
  chatId,
  isThinkingOpen,
  onToggleThinking,
}: {
  entry: AgentSessionViewEntry;
  /** True for the first rendered entry (some markers are skipped there). */
  first: boolean;
  resolveMention: (id: number) => string | null;
  /** Session identity, for the user row's attachment reveal IPC. */
  employeeId: number;
  chatId: number;
  /** Whether a thinking block renders expanded (forced by find, then the
   *  boss's own choice, then the streaming default). */
  isThinkingOpen: (key: string, fallback: boolean) => boolean;
  onToggleThinking: (key: string, next: boolean) => void;
}): React.JSX.Element | null {
  switch (entry.kind) {
    case "wake":
      // A batch boundary above the first entry has nothing to separate.
      return first ? null : <SessionDivider />;
    case "user":
      return (
        <SessionUserRow entry={entry} employeeId={employeeId} chatId={chatId} />
      );
    case "text":
      return (
        <div
          className="imb-session-text"
          data-message-id={entry.id}
          data-commentable="1"
        >
          <Markdown content={entry.text} resolveMention={resolveMention} />
        </div>
      );
    case "thinking":
      return (
        <ThinkingBlock
          messageId={entry.id}
          text={entry.text}
          streaming={false}
          open={isThinkingOpen(entry.id, false)}
          onToggle={() =>
            onToggleThinking(entry.id, !isThinkingOpen(entry.id, false))
          }
        />
      );
    case "interrupted":
      return <InterruptedDivider />;
    case "tool":
      return (
        <ToolBlock
          messageId={entry.id}
          name={entry.name}
          status={entry.status}
          summary={entry.argsSummary}
          detail={entry.argsDetail}
        />
      );
    case "compaction":
      return (
        <CompactionBlock
          messageId={entry.id}
          summary={entry.summary}
          resolveMention={resolveMention}
        />
      );
  }
}

/**
 * One prompt in the transcript: what the boss wrote plus the attachments it
 * carried.
 *
 * The attachments are chips, not the `[Attachments]` text block the model reads
 * (the main process splits that block off and only reports it when it can be
 * read back byte-for-byte — see `splitAttachmentPrompt`). A file-only send has
 * no text at all, so the chips are then the whole bubble.
 *
 * A chip that points at the disk reveals in the OS file manager through the
 * trusted `sessions:revealAttachment` (main resolves the path from its own
 * transcript; the renderer never passes one), so a failure shows inline here.
 */
function SessionUserRow({
  entry,
  employeeId,
  chatId,
}: {
  entry: Extract<AgentSessionViewEntry, { kind: "user" }>;
  employeeId: number;
  chatId: number;
}): React.JSX.Element {
  const [revealError, setRevealError] = useState<string | null>(null);
  const attachments = entry.attachments ?? [];

  const reveal = useCallback(
    (index: number): void => {
      setRevealError(null);
      // Wrapped in an async IIFE (not `.catch()` on the returned value) so a
      // bridge that is missing the method degrades to the inline error instead
      // of throwing out of the click handler.
      void (async (): Promise<void> => {
        try {
          await imb.sessions.revealAttachment(
            employeeId,
            chatId,
            entry.id,
            index,
          );
        } catch (err) {
          setRevealError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [chatId, employeeId, entry.id],
  );

  const openConversation = useCallback((targetChatId: number): void => {
    void appStore.openConversationById(targetChatId);
  }, []);

  // An attachment-only prompt shows just the image deck, so the bubble chrome is
  // dropped exactly like an image-only chat bubble does. A prompt whose stored text is
  // only the generated `Attached: …` blurb counts as attachment-only: the line is a
  // duplicate of the chips above it (and English baked into the transcript).
  const blurbOnly = isAttachmentOnlyBlurb(entry.text, attachments);
  const body = blurbOnly ? "" : entry.text;
  const mediaOnly = isMediaOnlyAttachments(attachments, body.length);

  return (
    <div
      className={cls("imb-session-user", mediaOnly && "imb-session-user-media")}
      data-message-id={entry.id}
      data-commentable="1"
    >
      {attachments.length > 0 && (
        <SessionAttachments
          attachments={attachments}
          source={{ kind: "entry", entryId: entry.id }}
          onReveal={reveal}
          onOpenConversation={openConversation}
        />
      )}
      <CommentCards
        comments={entry.comments ?? []}
        carrier={{ kind: "entry", entryId: entry.id }}
        surface="session"
      />
      {body.length > 0 && <div className="imb-session-user-text">{body}</div>}
      {revealError !== null && (
        <div className="imb-session-attachment-error" role="alert">
          {revealError}
        </div>
      )}
    </div>
  );
}

/**
 * Placeholder for a message sent from the composer that the transcript cannot
 * show yet: nothing is written to the conversation (by design) and Pi persists
 * a steer only at the next turn boundary, so without this row a successful send
 * would look like nothing happened.
 *
 * Styled as the boss's own bubble but dimmed. What sits next to it depends on
 * what the row actually is:
 * - **interjection** (`steerId` set, still `pending`): one 「撤回」 button. The
 *   text has not reached the model, so it can still be taken back; the button
 *   itself is the state — no explanatory line (boss's call).
 * - **interjection, settled** (`lost` / `unknown`): a one-shot reason line and no
 *   button. The row removes itself after `FEEDBACK_MS`.
 * - **queued** send (v1 cannot withdraw those) or a legacy steer with no handle:
 *   the old status line plus a `×` that only dismisses the placeholder.
 */
function PendingSendRow({
  item,
  onDismiss,
  onWithdraw,
  onOpenConversation,
}: {
  item: PendingSend;
  onDismiss: (id: number) => void;
  onWithdraw: (item: PendingSend) => void;
  /** A `kind: "chat"` chip opens its conversation (no reveal: the row has no
   *  session entry to address yet). */
  onOpenConversation: (chatId: number) => void;
}): React.JSX.Element {
  const feedback = item.feedback;
  // A one-shot line must not stay forever: the row is only there to report one
  // outcome, and leaving it behind would suggest a live state that is gone.
  useEffect(() => {
    if (feedback === undefined) return;
    const timer = window.setTimeout(() => onDismiss(item.id), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback, item.id, onDismiss]);

  const withdrawable =
    item.steerId !== undefined && item.phase === "pending" && !feedback;
  const label = withdrawable
    ? null
    : feedback !== undefined
      ? pendingFeedbackLabel(feedback)
      : item.unconfirmed
        ? t("Not confirmed — the agent may not have received this")
        : item.mode === "steer"
          ? t("Interjected — handled after the current turn")
          : t("Queued — handled as soon as the agent is free");
  const withdrawLabel = t("Withdraw");
  const dismissLabel = t("Dismiss");
  return (
    <div className="imb-session-pending">
      <div
        className={cls(
          "imb-session-user imb-session-pending-bubble",
          (item.unconfirmed || feedback !== undefined) && "imb-is-unconfirmed",
        )}
      >
        {item.attachments !== undefined && item.attachments.length > 0 && (
          <SessionAttachments
            attachments={item.attachments}
            onOpenConversation={onOpenConversation}
          />
        )}
        {item.text.length > 0 && (
          <div className="imb-session-user-text">{item.text}</div>
        )}
      </div>
      {withdrawable ? (
        <div className="imb-session-pending-hint">
          <button
            type="button"
            className="imb-session-pending-action"
            aria-label={withdrawLabel}
            disabled={item.busy === true}
            onClick={() => onWithdraw(item)}
          >
            {withdrawLabel}
          </button>
        </div>
      ) : (
        <div
          className={cls(
            "imb-session-pending-hint",
            (item.unconfirmed || feedback !== undefined) &&
              "imb-is-unconfirmed",
          )}
          role={feedback !== undefined ? "alert" : undefined}
        >
          <span>{label}</span>
          {/* A settled interjection has nothing left to dismiss: it reports an
              outcome and removes itself. Only the queued/legacy rows keep an
              explicit "I don't care anymore". */}
          {feedback === undefined && item.steerId === undefined && (
            <button
              type="button"
              className="imb-session-pending-dismiss"
              aria-label={dismissLabel}
              title={dismissLabel}
              onClick={() => onDismiss(item.id)}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Separator for a turn the boss interrupted. Structurally identical to
 * `SessionDivider` (same muted line + centered label) and only tinted with the
 * danger colour, so it reads as one of the app's system separators.
 *
 * Deliberately **not** a jump anchor (no `data-session-divider`): the prev/next
 * buttons walk the "new messages" batch dividers only. No timestamp either — the
 * marker is a boundary, not an event log line.
 */
function InterruptedDivider(): React.JSX.Element {
  const label = t("Interrupted");
  return (
    <div
      className="imb-session-divider imb-session-divider-interrupted"
      role="separator"
      aria-label={label}
    >
      <span className="imb-session-divider-label">{label}</span>
    </div>
  );
}

/**
 * Batch separator: a muted line with a centered label, drawn where an internal
 * "you have new messages" wake prompt sits in the session. One divider per
 * batch of processed messages (see `session-view.ts`).
 *
 * `data-session-divider` is the jump-anchor hook read by `readAnchors`
 * (`.imb-session-jumps` buttons); it is not used for styling.
 */
function SessionDivider(): React.JSX.Element {
  const label = t("New messages");
  return (
    <div
      className="imb-session-divider"
      role="separator"
      aria-label={label}
      data-session-divider=""
    >
      <span className="imb-session-divider-label">{label}</span>
    </div>
  );
}

/**
 * Floating "previous / next new message" control, fixed to the bottom-right of
 * the content pane (this view has no composer, and it is portaled into
 * `.imb-contentpane`, which is flush with the window edge).
 *
 * The up arrow sits above the down arrow. Each button first walks the wake
 * dividers, and once there is none left in that direction it keeps going to the
 * very top / bottom of the transcript. A direction is only disabled when the
 * view is already at that edge and no divider remains; the whole control is
 * only rendered when the session has at least one divider.
 */
function SessionJumpButtons({
  availability,
  onJump,
}: {
  availability: JumpAvailability;
  onJump: (direction: "prev" | "next") => void;
}): React.JSX.Element {
  return (
    <div className="imb-session-jumps">
      <IconButton
        className="imb-session-jump"
        label={t("Previous new message")}
        size={16}
        boxSize={32}
        disabled={!availability.prev}
        onClick={() => onJump("prev")}
      >
        <IconChevronUp />
      </IconButton>
      <IconButton
        className="imb-session-jump"
        label={t("Next new message")}
        size={16}
        boxSize={32}
        disabled={!availability.next}
        onClick={() => onJump("next")}
      >
        <IconChevronDown />
      </IconButton>
    </div>
  );
}

/** Render one reconstructed live block. */
function LiveBlockView({
  block,
  resolveMention,
  isThinkingOpen,
  onToggleThinking,
}: {
  block: LiveBlock;
  resolveMention: (id: number) => string | null;
  isThinkingOpen: (key: string, fallback: boolean) => boolean;
  onToggleThinking: (key: string, next: boolean) => void;
}): React.JSX.Element {
  switch (block.kind) {
    case "text":
      return (
        <div className="imb-session-text">
          <Markdown content={block.text} resolveMention={resolveMention} />
        </div>
      );
    case "thinking":
      return (
        <ThinkingBlock
          text={block.text}
          streaming={!block.done}
          // A live block stays open while it streams and folds once it ends,
          // unless the boss (or a find jump) opened it by hand.
          open={isThinkingOpen(block.key, block.done !== true)}
          onToggle={() =>
            onToggleThinking(
              block.key,
              !isThinkingOpen(block.key, block.done !== true),
            )
          }
        />
      );
    case "tool":
      return (
        <ToolBlock
          name={block.name ?? t("Tool")}
          status={block.status ?? "running"}
          summary={block.argsSummary}
          detail={block.argsDetail}
        />
      );
  }
}

/**
 * Collapsible assistant reasoning. Expanded/collapsed state lives in the module
 * (`thinkingOpen`), not here, because two things outside this component decide
 * it: the streaming lifecycle (open while streaming, folded once it ends — the
 * caller passes that as `open`) and find, which must be able to open a block
 * whose text a query matches (the body is not even mounted while folded, so
 * folded reasoning would otherwise be unsearchable).
 *
 * `messageId` is the find/jump row contract (`data-message-id`): it addresses
 * this block for the landing flash and for my-messages jumps.
 */
function ThinkingBlock({
  messageId,
  text,
  streaming,
  open,
  onToggle,
}: {
  /** Entry id (persisted blocks only; a live block has none). */
  messageId?: string;
  text: string;
  streaming: boolean;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div
      className={cls("imb-session-thinking", open && "imb-is-open")}
      data-message-id={messageId}
    >
      <button
        type="button"
        className="imb-session-thinking-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <IconChevronDown className="imb-icon imb-sm" />
        <span>{streaming ? t("Thinking…") : t("Thinking")}</span>
      </button>
      {open && <div className="imb-session-thinking-body">{text}</div>}
    </div>
  );
}

/** A tool call: name, a compact argument summary, and expandable args detail. */
function ToolBlock({
  messageId,
  name,
  status,
  summary,
  detail,
}: {
  /** Entry id, for the row contract (`data-message-id`). */
  messageId?: string;
  name: string;
  status: "running" | "ok" | "error";
  summary?: string;
  detail?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = detail !== undefined && detail.length > 0;
  const row = (
    <>
      <span className="imb-session-tool-dot" aria-hidden="true" />
      <span className="imb-session-tool-name">{name}</span>
      {summary !== undefined && summary.length > 0 && (
        <span className="imb-session-tool-args" title={summary}>
          {summary}
        </span>
      )}
      <span className="imb-session-tool-status">
        {status === "running"
          ? t("Running")
          : status === "error"
            ? t("Failed")
            : t("Done")}
      </span>
    </>
  );
  return (
    <div
      className={cls(
        "imb-session-tool",
        `imb-is-${status}`,
        expandable && "imb-is-expandable",
        open && "imb-is-open",
      )}
      data-message-id={messageId}
    >
      {expandable ? (
        <button
          type="button"
          className="imb-session-tool-head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {row}
        </button>
      ) : (
        <div className="imb-session-tool-head">{row}</div>
      )}
      {expandable && open && (
        <pre className="imb-session-tool-detail">{detail}</pre>
      )}
    </div>
  );
}

/** A compaction marker with its summary. */
function CompactionBlock({
  messageId,
  summary,
  resolveMention,
}: {
  /** Entry id, for the row contract (`data-message-id`). */
  messageId?: string;
  summary: string;
  resolveMention: (id: number) => string | null;
}): React.JSX.Element {
  return (
    <div className="imb-session-compaction" data-message-id={messageId}>
      <div className="imb-session-compaction-head">{t("Compacted")}</div>
      <div className="imb-session-compaction-body">
        <Markdown content={summary} resolveMention={resolveMention} />
      </div>
    </div>
  );
}
