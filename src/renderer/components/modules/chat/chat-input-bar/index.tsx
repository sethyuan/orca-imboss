import { t } from "@shared/l10n";
import { wrapRefName } from "@shared/ref-names";
import type {
  ChatSummary,
  CommonProject,
  MessageAttachment,
} from "@shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { appStore, useAppSync } from "../../../../app-store";
import {
  EMPTY_DRAFT,
  nextAttachmentId,
  toPlainAttachment,
} from "../../../../chat-draft";
import { IconFolder } from "../../../icons";
import {
  ComposerCard,
  type ComposerDraftBinding,
  type ComposerHandle,
} from "../composer-card";
import { displayTitle } from "../relative-time";
import { RefPopup, type RefCandidate, type RefTrigger } from "./ref-popup";

/**
 * The reference triggers, in match order. Both are only recognised at the start
 * of the line or after whitespace (see `TRIGGER_PATTERNS`), so a `@` inside an
 * email address or a `#` inside a tag never opens a popup.
 */
const REF_TRIGGERS: readonly RefTrigger[] = ["@", "#"];

/**
 * `<trigger>query-to-the-caret`, anchored at the caret. The query class excludes
 * whitespace and the trigger itself, so the whole reference stays one token.
 */
const TRIGGER_PATTERNS: Record<RefTrigger, RegExp> = {
  "@": /(?:^|\s)@([^\s@]*)$/,
  "#": /(?:^|\s)#([^\s#]*)$/,
};

/**
 * One-shot "reset this composer" request, minted by the chat module right after
 * it created a new chat. It is deliberately not a bare counter: the `chatId`
 * pins which conversation the reset belongs to, and `seq` makes the reset a
 * single event the composer applies **at most once** and then acknowledges
 * (`onComposerResetApplied`), so an ordinary chat switch or a remount can never
 * replay it.
 */
export interface ComposerResetRequest {
  /** Chat the reset is for; applied only while that chat is the edited one. */
  chatId: number;
  /** Monotonic id of the request (`newChat()` bumps it per creation). */
  seq: number;
}

export interface ChatInputBarProps {
  disabled?: boolean;
  /** Chat whose draft this composer edits (drafts are per chat, on appStore). */
  chatId: number;
  /**
   * Pending "a new chat was just created" request: resets the composer's
   * transient UI and focuses the textarea. `null` (the default) leaves the
   * composer alone — switching chats must never reset anything.
   */
  composerReset?: ComposerResetRequest | null;
  /**
   * Called once the request in `composerReset` was applied (or dropped because
   * its chat is no longer the edited one), so the parent can clear it and a
   * later remount cannot replay it.
   */
  onComposerResetApplied?: (seq: number) => void;
  onSend: (text: string, attachments: MessageAttachment[]) => void;
  /**
   * Whether the reference popups are offered (default `true`): `@` for an
   * employee and `#` for a task group this conversation created.
   *
   * An employee direct chat targets exactly one employee and spawns no task
   * groups of its own, so both references would be meaningless there; that
   * composer turns the popups off and `@` / `#` stay plain text.
   */
  mentions?: boolean;
  /**
   * Called after the composer wrote tags to the conversation (a common-project
   * pick). Lets the chat module refresh its tag candidates and paged list.
   */
  onTagsApplied?: (chatId: number) => void;
}

/**
 * The chat composer: the shared `ComposerCard` (chips, textarea, attach menu,
 * send button) bound to this chat's draft, plus everything only a chat message
 * needs.
 *
 * Chat-only here, in one place:
 * - the `@`-mention / `#`-task-group reference popup and its key/caret handling
 *   (a session send has no mention semantics);
 * - the common-project rows in the attach menu — they attach a folder **and**
 *   write the project's tags into the conversation (`chats:addTags`), which is
 *   a chat side effect; the agent-session composer passes no
 *   `attachMenuExtra`, so it simply never shows them;
 * - the one-shot "a new chat was created" reset/focus;
 * - the draft lives in `appStore.chatDrafts` (per chat), so a module switch
 *   never loses it.
 */
export function ChatInputBar({
  disabled = false,
  chatId,
  composerReset = null,
  onComposerResetApplied,
  onSend,
  onTagsApplied,
  mentions = true,
}: ChatInputBarProps): React.JSX.Element {
  // The draft is per chat and lives on appStore so it survives the chat module
  // being unmounted on a module switch.
  const snap = useAppSync();
  const draft = snap.chatDrafts[chatId] ?? EMPTY_DRAFT;
  const { text, attachments } = draft;

  const cardRef = useRef<ComposerHandle>(null);
  // Common projects: loaded when the attach menu opens and rendered as flat
  // menu items alongside File / Folder / Conversation.
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const [projects, setProjects] = useState<CommonProject[]>([]);

  // Reference popups: one state says which trigger is live, so `@` and `#`
  // can never both be open (a single overlay slot, and `ArrowDown` must move
  // exactly one list).
  const [refTrigger, setRefTrigger] = useState<RefTrigger | null>(null);
  const [refQuery, setRefQuery] = useState("");
  const [refIndex, setRefIndex] = useState(0);
  // Caret span of the typed trigger token (from the `@`/`#` up to the caret),
  // replaced as a whole when a candidate is picked.
  const [refCaret, setRefCaret] = useState({ start: 0, end: 0 });

  const allEmployees = snap.data.employees.items;

  // Task groups of this conversation: loaded when the `#` popup opens (so a
  // group created since the last look is pickable without remounting the
  // composer, exactly like the common-project rows).
  const [taskChats, setTaskChats] = useState<ChatSummary[]>([]);
  const [taskChatsLoading, setTaskChatsLoading] = useState(false);
  useEffect(() => {
    if (!mentions || refTrigger !== "#") return;
    let alive = true;
    setTaskChatsLoading(true);
    void imb.chats
      .taskGroups(chatId)
      .then((list) => {
        if (!alive) return;
        setTaskChats(list);
        setTaskChatsLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        // Defensive: a failed read leaves an empty list (the boss can still
        // type the reference by hand), and is reported rather than swallowed.
        console.error(
          "[chat-input-bar] task groups",
          err instanceof Error ? err.message : err,
        );
        setTaskChats([]);
        setTaskChatsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mentions, refTrigger, chatId]);

  const candidates = useMemo<RefCandidate[]>(() => {
    if (refTrigger === null) return [];
    const q = refQuery.toLowerCase().trim();
    if (refTrigger === "@") {
      return allEmployees
        .filter(
          (e) =>
            q.length === 0 ||
            e.name.toLowerCase().includes(q) ||
            e.role.toLowerCase().includes(q) ||
            String(e.id).includes(q),
        )
        .map((e) => ({
          kind: "employee" as const,
          id: e.id,
          name: e.name,
          role: e.role,
        }));
    }
    // `#`: the task groups this conversation spawned, most recently active
    // first (main sorts them). The current chat can never be one of them —
    // main filters by `from_chat_id` — but the id check keeps a stale list from
    // offering the composer its own conversation.
    return taskChats
      .filter((chat) => chat.id !== chatId && chat.fromChatId !== null)
      .filter((chat) => q.length === 0 || chat.title.toLowerCase().includes(q))
      .map((chat) => ({
        kind: "taskChat" as const,
        id: chat.id,
        title: chat.title,
        participants: chat.participants,
        // Non-null for every task group; the fallback only keeps the avatar
        // rendering sane if that ever changes.
        fromChatId: chat.fromChatId ?? chatId,
      }));
  }, [refTrigger, refQuery, allEmployees, taskChats, chatId]);
  // A brand-new chat resets the composer's transient UI and lands the caret in
  // the input. Only an explicit request does this: a plain `chatId` change (a
  // chat switch) must never reset anything, because the draft — text *and*
  // attachments — lives on appStore precisely so it survives switching chats.
  // The request is acknowledged after applying it, so remounting the composer
  // later in the same module mount cannot replay the focus/reset.
  //
  // Never clear any chat's draft here: doing that from an effect that also runs
  // on a `chatId` change is what used to lose the draft a chat switch was
  // supposed to keep (`composer-draft-lost-on-chat-switch.md`).
  const appliedResetSeqRef = useRef(0);
  useEffect(() => {
    if (!composerReset) return;
    if (composerReset.seq === appliedResetSeqRef.current) return;
    if (composerReset.chatId !== chatId) {
      // The selection already moved on: drop the request instead of applying it
      // to a chat the boss did not create (and never clear another chat's
      // draft on the way).
      onComposerResetApplied?.(composerReset.seq);
      return;
    }
    appliedResetSeqRef.current = composerReset.seq;
    // A fresh chat has no draft (its parent cleared it defensively); read the
    // store anyway so this stays correct if that ever changes. Writing the text
    // through the card also resets its transient UI (notice / open menu / drop
    // state) for the new draft identity.
    cardRef.current?.setText(appStore.chatDrafts[chatId]?.text ?? "");
    cardRef.current?.focus();
    onComposerResetApplied?.(composerReset.seq);
  }, [composerReset, chatId, onComposerResetApplied]);

  // Load the configured common projects whenever the attach menu opens, so a
  // Settings edit is picked up without remounting the composer. No projects →
  // no project items (and no leading separator) are rendered at all.
  useEffect(() => {
    if (!projectsMenuOpen) return;
    let alive = true;
    void imb.projects
      .list()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch(() => {
        if (alive) setProjects([]);
      });
    return () => {
      alive = false;
    };
  }, [projectsMenuOpen]);

  /**
   * Apply a common project: attach its folder (deduped, capped like any other
   * attachment) and merge its tags into the conversation. Tags are written
   * immediately through the atomic `chats:addTags` (union), so the renderer
   * never has to read-modify-write the tag set.
   */
  const applyProject = async (project: CommonProject): Promise<void> => {
    const card = cardRef.current;
    card?.notify(null);
    const folder = project.folder;
    if (folder !== null) {
      const live = appStore.chatDrafts[chatId]?.attachments ?? [];
      const alreadyAttached = live.some(
        (item) =>
          item.attachment.kind === "folder" &&
          item.attachment.path === folder.path,
      );
      if (alreadyAttached) {
        card?.notify(t("Folder already attached."));
      } else {
        card?.addAttachments([
          {
            id: nextAttachmentId(),
            attachment: {
              name: folder.name,
              size: 0,
              type: "folder",
              path: folder.path,
              kind: "folder",
            },
          },
        ]);
      }
    }
    if (project.tags.length > 0) {
      try {
        await imb.chats.addTags(chatId, project.tags);
        onTagsApplied?.(chatId);
      } catch (err) {
        card?.notify(err instanceof Error ? err.message : String(err));
      }
    }
    card?.closeAttachMenu();
  };

  const send = (live: string): void => {
    const value = live.trim();
    if (!value && attachments.length === 0) return;
    // Rebuild each attachment as a plain object: `attachments` comes from the
    // Valtio snapshot, and its proxies cannot cross the IPC boundary.
    onSend(
      value,
      attachments.map((item) => toPlainAttachment(item.attachment)),
    );
    // Clear the per-chat draft; the store revokes its preview URLs.
    cardRef.current?.clear();
  };

  /**
   * Reference keys are handled before the card's Enter-to-send. `true` means
   * the key was consumed by the popup.
   *
   * An open popup with no candidates consumes nothing but `Escape`: `Enter`
   * must still send and every character must still be typed, so an empty list
   * can never swallow the boss's input.
   */
  const onKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (refTrigger === null) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setRefTrigger(null);
      return true;
    }
    if (candidates.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setRefIndex((i) => (i + 1) % candidates.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setRefIndex((i) => (i - 1 + candidates.length) % candidates.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const chosen = candidates[refIndex] ?? candidates[0];
      if (chosen) insertRef(chosen);
      return true;
    }
    return false;
  };

  /**
   * Open / close the reference popup for the token the caret sits in. `@` is
   * tried before `#`; only one of them can match a given caret position because
   * the trigger characters differ.
   */
  const checkRefTrigger = (val: string, cursor: number): void => {
    if (!mentions) return;
    const before = val.slice(0, cursor);
    for (const trigger of REF_TRIGGERS) {
      const match = TRIGGER_PATTERNS[trigger].exec(before);
      if (!match) continue;
      // `match[0]` also contains the leading whitespace (or nothing at line
      // start); the token starts at the trigger character itself.
      const atStart =
        (match.index ?? 0) + (match[0].startsWith(trigger) ? 0 : 1);
      setRefTrigger(trigger);
      setRefQuery(match[1]);
      setRefCaret({ start: atStart, end: cursor });
      setRefIndex(0);
      return;
    }
    setRefTrigger(null);
  };

  const onCaretMove = (): void => {
    if (!mentions) return;
    const textarea = cardRef.current?.textarea() ?? null;
    if (textarea) {
      checkRefTrigger(textarea.value, textarea.selectionStart ?? 0);
    }
  };

  /**
   * Replace the typed trigger token with the candidate's reference.
   *
   * The message gets the **name alone**, wrapped in backticks: `` `名字` ``
   * (`shared/ref-names.ts`). The trigger character is not written — it only
   * opened the popup — and the backticks are what keep a name with spaces one
   * token (`@John Doe` could not be told apart from `@John` plus prose). A
   * trailing space is added so typing continues outside the reference, unless
   * the text already continues with whitespace there.
   */
  const insertRef = (candidate: RefCandidate): void => {
    const card = cardRef.current;
    // The textarea is uncontrolled: the DOM owns the live value, so rebuild the
    // text from it rather than from the (possibly one frame stale) snapshot.
    const prevText = card?.textarea()?.value ?? text;
    const rest = prevText.slice(refCaret.end);
    const tag = refTagName(candidate) + (/^\s/.test(rest) ? "" : " ");
    const nextText = prevText.slice(0, refCaret.start) + tag + rest;
    const newCursor = refCaret.start + tag.length;
    // Writing through the card updates both the DOM value and the draft.
    card?.setText(nextText, newCursor);
    setRefTrigger(null);
  };

  const binding: ComposerDraftBinding = {
    draft,
    storageChatId: chatId,
    setText: (value) => appStore.setChatDraftText(chatId, value),
    addAttachments: (items) => appStore.addChatDraftAttachments(chatId, items),
    removeAttachment: (index) =>
      appStore.removeChatDraftAttachment(chatId, index),
    clearDraft: () => appStore.clearChatDraft(chatId),
    // Live store read (never the snapshot): a cap re-check must see a chip that
    // an async add committed after this render.
    attachmentCount: () => appStore.chatDrafts[chatId]?.attachments.length ?? 0,
  };

  // Common projects behind a separator, below the icon rows. Nothing (not even
  // the separator) renders when none is configured.
  const attachMenuExtra =
    projects.length > 0 ? (
      <>
        <div className="imb-attach-popup-sep imb-menu-sep" role="separator" />
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            role="menuitem"
            className="imb-attach-popup-item imb-menu-row"
            onClick={() => void applyProject(project)}
          >
            <IconFolder />
            <span className="imb-attach-project-name">{project.name}</span>
            {project.tags.length > 0 && (
              <span className="imb-attach-project-tags">
                {project.tags.map((tag) => `#${tag}`).join(" ")}
              </span>
            )}
          </button>
        ))}
      </>
    ) : null;

  return (
    <ComposerCard
      ref={cardRef}
      binding={binding}
      // The reference hints only where both are actually offered: an employee
      // direct chat keeps the plain prompt (it has no `@` / `#`).
      placeholder={
        mentions
          ? t("Type @ to mention an employee, # to reference a task chat")
          : t("What are your instructions?")
      }
      actionLabel={t("Send")}
      disabled={disabled}
      resetKey={chatId}
      onSend={send}
      attachMenuExtra={attachMenuExtra}
      attachMenuOpenChange={setProjectsMenuOpen}
      overlay={
        mentions ? (
          <RefPopup
            trigger={refTrigger}
            candidates={candidates}
            selectedIndex={refIndex}
            onSelect={insertRef}
            onHoverIndex={setRefIndex}
            loading={refTrigger === "#" && taskChatsLoading}
          />
        ) : null
      }
      onKeyDown={onKeyDown}
      onTextChanged={(value, caret) => checkRefTrigger(value, caret)}
      onCaretMove={onCaretMove}
    />
  );
}

/**
 * The text a candidate contributes to the message: its name as an inline code
 * span, `` `名字` `` (see `shared/ref-names.ts` for the normalization rules and
 * why the trigger character is not part of it).
 */
function refTagName(candidate: RefCandidate): string {
  const raw =
    candidate.kind === "employee"
      ? candidate.name || candidate.role || String(candidate.id)
      : displayTitle(candidate.title);
  return wrapRefName(raw, candidate.id);
}
