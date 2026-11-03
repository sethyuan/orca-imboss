import { t } from "@shared/l10n";
import type { CommonProject, MessageAttachment } from "@shared/types";
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
import { MentionPopup } from "./mention-popup";

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
 * - the `@`-mention popup and its key/caret handling (a session send has no
 *   mention semantics);
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

  // Mention state
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionCaret, setMentionCaret] = useState({ start: 0, end: 0 });

  const allEmployees = snap.data.employees.items;
  const filteredEmployees = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.toLowerCase().trim();
    if (!q) return allEmployees;
    return allEmployees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.role.toLowerCase().includes(q) ||
        String(e.id).includes(q),
    );
  }, [mentionOpen, mentionQuery, allEmployees]);
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
   * Mention keys are handled before the card's Enter-to-send. `true` means the
   * key was consumed by the popup.
   */
  const onKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (!mentionOpen || filteredEmployees.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((i) => (i + 1) % filteredEmployees.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex(
        (i) => (i - 1 + filteredEmployees.length) % filteredEmployees.length,
      );
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const chosen = filteredEmployees[mentionIndex] ?? filteredEmployees[0];
      if (chosen) insertMention(chosen);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionOpen(false);
      return true;
    }
    return false;
  };

  const checkMentionTrigger = (val: string, cursor: number): void => {
    const before = val.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (match) {
      const query = match[1];
      const atStart = match.index + (match[0].startsWith("@") ? 0 : 1);
      setMentionQuery(query);
      setMentionCaret({ start: atStart, end: cursor });
      setMentionOpen(true);
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
    }
  };

  const onCaretMove = (): void => {
    const textarea = cardRef.current?.textarea() ?? null;
    if (textarea) {
      checkMentionTrigger(textarea.value, textarea.selectionStart ?? 0);
    }
  };

  const insertMention = (employee: {
    id: number;
    name?: string;
    role?: string;
  }): void => {
    const card = cardRef.current;
    // The textarea is uncontrolled: the DOM owns the live value, so rebuild the
    // text from it rather than from the (possibly one frame stale) snapshot.
    const prevText = card?.textarea()?.value ?? text;
    const mentionTag = `@${employee.name || employee.role || employee.id} `;
    const nextText =
      prevText.slice(0, mentionCaret.start) +
      mentionTag +
      prevText.slice(mentionCaret.end);
    const newCursor = mentionCaret.start + mentionTag.length;
    // Writing through the card updates both the DOM value and the draft.
    card?.setText(nextText, newCursor);
    setMentionOpen(false);
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
      placeholder={t("What are your instructions?")}
      actionLabel={t("Send")}
      disabled={disabled}
      resetKey={chatId}
      onSend={send}
      attachMenuExtra={attachMenuExtra}
      attachMenuOpenChange={setProjectsMenuOpen}
      overlay={
        <MentionPopup
          open={mentionOpen}
          employees={filteredEmployees}
          selectedIndex={mentionIndex}
          onSelect={insertMention}
          onHoverIndex={setMentionIndex}
        />
      }
      onKeyDown={onKeyDown}
      onTextChanged={(value, caret) => checkMentionTrigger(value, caret)}
      onCaretMove={onCaretMove}
    />
  );
}
