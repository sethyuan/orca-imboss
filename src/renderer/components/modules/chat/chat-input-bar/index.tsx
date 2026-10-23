import { MAX_USER_ATTACHMENTS } from "@shared/constants/attachments";
import { t } from "@shared/l10n";
import type {
  ChatSummary,
  CommonProject,
  MessageAttachment,
} from "@shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { cls } from "reactutils";
import { appStore, useAppSync } from "../../../../app-store";
import {
  acceptWithinCap,
  chooseFolderAttachments,
  dropEntries,
  fileAttachment,
  filesFromClipboard,
  hasDroppedFiles,
  isOversizedFile,
  pendingFromEntries,
  persistPastedFile,
  toPendingAttachment,
  type FileEntry,
} from "../../../../attachment-pick";
import {
  EMPTY_DRAFT,
  nextAttachmentId,
  toPlainAttachment,
  type PendingAttachment,
} from "../../../../chat-draft";
import { Avatar } from "../../../avatar";
import { IconChat, IconFolder, IconSend } from "../../../icons";
import { useMentionResolver } from "../../../markdown/use-mention";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { Textarea } from "../../../textarea";
import { DraftAttachmentChips } from "../attachment-draft";
import { AttachMenuButton } from "../attachment-draft/attach-menu";
import { formatChatPreview } from "../preview-text";
import { displayTitle } from "../relative-time";
import "./index.css";
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

export function ChatInputBar({
  disabled = false,
  chatId,
  composerReset = null,
  onComposerResetApplied,
  onSend,
  onTagsApplied,
}: ChatInputBarProps): React.JSX.Element {
  // The draft is per chat and lives on appStore so it survives the chat module
  // being unmounted on a module switch. `sync: true` keeps the controlled
  // textarea's value/caret in step with the store.
  const snap = useAppSync();
  const draft = snap.chatDrafts[chatId] ?? EMPTY_DRAFT;
  const { text, attachments } = draft;

  const [notice, setNotice] = useState<string | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  // Common projects: loaded when the attach menu opens and rendered as flat
  // menu items alongside Image / File / Folder.
  const [projects, setProjects] = useState<CommonProject[]>([]);
  // Conversation picker: root chats selectable as `kind: "chat"` attachments.
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [chatQuery, setChatQuery] = useState("");
  const [chatOptions, setChatOptions] = useState<ChatSummary[]>([]);
  const [chatPickerError, setChatPickerError] = useState<string | null>(null);

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
  // Same plain-text previews as the chat list: `@<id>` mentions resolve to
  // employee names (non-interactive, exactly like the list rows).
  const { resolveMention } = useMentionResolver(chatId, false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A brand-new chat resets the composer's transient UI and lands the caret in
  // the input. Only an explicit request does this: a plain `chatId` change (a
  // chat switch) must never reset anything, because the draft — text *and*
  // attachments — lives on appStore precisely so it survives switching chats.
  // The request is acknowledged after applying it, so remounting the composer
  // later in the same module mount cannot replay the focus/reset.
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
    setNotice(null);
    setPopupOpen(false);
    setDropActive(false);
    if (textareaRef.current) {
      // A fresh chat has no draft (its parent cleared it defensively); read the
      // store anyway so this stays correct if that ever changes.
      textareaRef.current.value = appStore.chatDrafts[chatId]?.text ?? "";
    }
    textareaRef.current?.focus();
    onComposerResetApplied?.(composerReset.seq);
  }, [composerReset, chatId, onComposerResetApplied]);

  // Per-chat drafts: reset transient UI when the edited chat changes so a
  // notice or an open attach menu never carries over to another chat's draft.
  useEffect(() => {
    setNotice(null);
    setPopupOpen(false);
    setDropActive(false);
    // Uncontrolled textarea: manually sync the DOM value to this chat's draft
    // (React never rewrites it, so IME composition is never interrupted).
    if (textareaRef.current) {
      textareaRef.current.value = appStore.chatDrafts[chatId]?.text ?? "";
    }
  }, [chatId]);

  // A file dropped anywhere outside the input bar would otherwise make Chromium
  // navigate the window to it. Neutralize that default globally; the input bar
  // handles its own drop (and calls preventDefault too).
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent): void => {
      if (event.dataTransfer && hasDroppedFiles(event.dataTransfer)) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  // Load the configured common projects whenever the attach menu opens, so a
  // Settings edit is picked up without remounting the composer. No projects →
  // no project items (and no leading separator) are rendered at all.
  useEffect(() => {
    if (!popupOpen) return;
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
  }, [popupOpen]);

  // Load the attachable conversations whenever the picker opens, so a chat
  // created since the last open is selectable without remounting the composer.
  useEffect(() => {
    if (!chatPickerOpen) return;
    let alive = true;
    void imb.chats
      .summaries()
      .then((list) => {
        if (alive) setChatOptions(list);
      })
      .catch((err) => {
        if (!alive) return;
        setChatOptions([]);
        setChatPickerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [chatPickerOpen]);

  // Attachable conversations: local root chats only — no task groups, no
  // platform-bridged chats, and never the chat being composed (self-attach).
  const chatCandidates = useMemo(() => {
    const q = chatQuery.trim().toLowerCase();
    return chatOptions
      .filter(
        (chat) =>
          chat.fromChatId === null &&
          chat.source === null &&
          chat.id !== chatId,
      )
      .filter((chat) => q.length === 0 || chat.title.toLowerCase().includes(q));
  }, [chatOptions, chatQuery, chatId]);

  const send = (): void => {
    const value = text.trim();
    if (disabled) return;
    if (!value && attachments.length === 0) return;
    // Rebuild each attachment as a plain object: `attachments` comes from the
    // Valtio snapshot, and its proxies cannot cross the IPC boundary.
    onSend(
      value,
      attachments.map((item) => toPlainAttachment(item.attachment)),
    );
    // Clear the per-chat draft; the store revokes its preview URLs.
    appStore.clearChatDraft(chatId);
    // Uncontrolled textarea: clear the DOM value directly.
    if (textareaRef.current) textareaRef.current.value = "";
    setNotice(null);
  };

  /** Cap a requested count to the free slots, warning on overflow. */
  const capCount = (count: number): number => {
    const remaining = Math.max(MAX_USER_ATTACHMENTS - attachments.length, 0);
    if (count > remaining) {
      setNotice(
        t("Up to ${count} attachments allowed.", {
          count: String(MAX_USER_ATTACHMENTS),
        }),
      );
    }
    return remaining;
  };

  /**
   * Append chips, re-checking the cap against the live draft so an async add
   * cannot overshoot a concurrent one. Overflow chips are revoked (and their
   * pasted files deleted) by the shared helper.
   */
  const commitPending = (items: PendingAttachment[]): void => {
    if (items.length === 0) return;
    const liveCount = appStore.chatDrafts[chatId]?.attachments.length ?? 0;
    const accepted = acceptWithinCap(items, liveCount, MAX_USER_ATTACHMENTS);
    if (accepted.length > 0) {
      appStore.addChatDraftAttachments(chatId, accepted);
    }
  };

  /**
   * Apply a common project: attach its folder (deduped, capped like any other
   * attachment) and merge its tags into the conversation. Tags are written
   * immediately through the atomic `chats:addTags` (union), so the renderer
   * never has to read-modify-write the tag set.
   */
  const applyProject = async (project: CommonProject): Promise<void> => {
    setNotice(null);
    const folder = project.folder;
    if (folder !== null) {
      const live = appStore.chatDrafts[chatId]?.attachments ?? [];
      const alreadyAttached = live.some(
        (item) =>
          item.attachment.kind === "folder" &&
          item.attachment.path === folder.path,
      );
      if (alreadyAttached) {
        setNotice(t("Folder already attached."));
      } else if (capCount(1) > 0) {
        commitPending([
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
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
    setPopupOpen(false);
  };

  /**
   * Attach an existing conversation as a `kind: "chat"` chip (a reference, not
   * a file). Deduped and capped like every other attachment; the title is
   * snapshotted now so a later rename cannot desync the chip label.
   */
  const attachChat = (chat: ChatSummary): void => {
    setChatPickerOpen(false);
    const live = appStore.chatDrafts[chatId]?.attachments ?? [];
    if (
      live.some(
        (item) =>
          item.attachment.kind === "chat" && item.attachment.chatId === chat.id,
      )
    ) {
      setNotice(t("Conversation already attached."));
      return;
    }
    if (capCount(1) === 0) return;
    commitPending([
      {
        id: nextAttachmentId(),
        attachment: {
          name: displayTitle(chat.title),
          size: 0,
          type: "chat",
          kind: "chat",
          chatId: chat.id,
        },
      },
    ]);
  };

  const addFiles = (files: readonly File[] | null): void => {
    if (!files || files.length === 0) return;
    addEntries(
      Array.from(files).map((file) => ({ file, kind: "file" as const })),
    );
  };

  const addEntries = (entries: readonly FileEntry[]): void => {
    if (entries.length === 0) return;
    setNotice(null);
    const { items, failedFolders } = pendingFromEntries(
      entries,
      capCount(entries.length),
    );
    if (failedFolders > 0) {
      setNotice(
        failedFolders === 1
          ? t("Could not attach the folder.")
          : t("Could not attach ${count} folders.", {
              count: String(failedFolders),
            }),
      );
    }
    commitPending(items);
    setPopupOpen(false);
  };

  /**
   * Attach folders chosen through the native directory dialog. Main owns the
   * absolute path, so it is authoritative; a folder counts as one attachment
   * toward the cap but has no bytes to preview.
   */
  const chooseFolders = async (): Promise<void> => {
    setNotice(null);
    let items: PendingAttachment[];
    try {
      items = await chooseFolderAttachments();
    } catch {
      setNotice(t("Could not attach the folder."));
      return;
    }
    if (items.length === 0) return;
    commitPending(items.slice(0, capCount(items.length)));
    setPopupOpen(false);
  };

  /**
   * Attach files from a paste. Clipboard-synthesized files have no backing
   * path, so their bytes are first persisted to the per-chat folder (giving the
   * agent a readable `path`); files already on disk keep their original path.
   */
  const addPastedFiles = async (files: readonly File[]): Promise<void> => {
    setNotice(null);
    const selected = Array.from(files);
    const next: PendingAttachment[] = [];
    let failed = 0;
    for (const file of selected.slice(0, capCount(selected.length))) {
      // A file that already lives on disk keeps its own path; a clipboard-only
      // one is persisted first (the shared helper owns that rule).
      if (imb.files.getPath(file)) {
        next.push(toPendingAttachment(file, fileAttachment(file)));
        continue;
      }
      // Reject oversized payloads before reading their bytes into memory.
      if (isOversizedFile(file)) {
        failed += 1;
        continue;
      }
      try {
        next.push(
          toPendingAttachment(file, await persistPastedFile(chatId, file)),
        );
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      setNotice(
        failed === 1
          ? t("Could not attach the pasted file.")
          : t("Could not attach ${count} pasted files.", {
              count: String(failed),
            }),
      );
    }
    commitPending(next);
    setPopupOpen(false);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    // Consume the paste so an accompanying text/HTML representation (e.g. an
    // image copied from a web page) is not also inserted into the textarea.
    event.preventDefault();
    void addPastedFiles(files);
  };

  // Folders dropped from the OS are attached by path (kind = "folder"); the
  // shared helper tells them apart from files via Chromium's entry API.
  const addDropped = (dataTransfer: DataTransfer): void => {
    addEntries(dropEntries(dataTransfer));
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    // Moving over a child fires dragleave on the parent; ignore those.
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setDropActive(false);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDropActive(false);
    addDropped(event.dataTransfer);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (mentionOpen && filteredEmployees.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % filteredEmployees.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + filteredEmployees.length) % filteredEmployees.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = filteredEmployees[mentionIndex] ?? filteredEmployees[0];
        if (chosen) insertMention(chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
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

  const syncDraftText = (val: string, cursor?: number): void => {
    appStore.setChatDraftText(chatId, val);
    const pos = cursor ?? textareaRef.current?.selectionStart ?? val.length;
    checkMentionTrigger(val, pos);
  };

  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    syncDraftText(
      e.target.value,
      e.target.selectionStart ?? e.target.value.length,
    );
  };

  const onTextSelect = (): void => {
    const textarea = textareaRef.current;
    if (textarea) {
      checkMentionTrigger(textarea.value, textarea.selectionStart ?? 0);
    }
  };

  const insertMention = (employee: {
    id: number;
    name?: string;
    role?: string;
  }): void => {
    const textarea = textareaRef.current;
    // The textarea is uncontrolled: the DOM owns the live value, so rebuild the
    // text from it rather than from the (possibly one frame stale) snapshot.
    const prevText = textarea?.value ?? text;
    const mentionTag = `@${employee.name || employee.role || employee.id} `;
    const nextText =
      prevText.slice(0, mentionCaret.start) +
      mentionTag +
      prevText.slice(mentionCaret.end);
    const newCursor = mentionCaret.start + mentionTag.length;
    if (textarea) {
      // Write through the DOM directly: React never rewrites an uncontrolled
      // value, so updating only the store would leave the visible input
      // unchanged (the mention would never appear).
      textarea.value = nextText;
      textarea.focus();
      textarea.setSelectionRange(newCursor, newCursor);
    }
    appStore.setChatDraftText(chatId, nextText);
    setMentionOpen(false);
  };

  return (
    <div
      className={cls("imb-chat-input-wrap", dropActive && "imb-drop-active")}
      onPaste={onPaste}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropActive && (
        <div className="imb-drop-hint">
          {t("Drop files or folders to attach")}
        </div>
      )}
      <div className="imb-chat-input-card">
        <DraftAttachmentChips
          items={attachments}
          onRemove={(_item, index) =>
            appStore.removeChatDraftAttachment(chatId, index)
          }
          onViewerClose={() => {
            // Hand the caret back to the composer: closing the viewer returns
            // the boss to typing, not to a dead close button.
            textareaRef.current?.focus();
          }}
        />
        {notice !== null && <div className="imb-attach-notice">{notice}</div>}
        <MentionPopup
          open={mentionOpen}
          employees={filteredEmployees}
          selectedIndex={mentionIndex}
          onSelect={insertMention}
          onHoverIndex={setMentionIndex}
        />
        <Textarea
          ref={textareaRef}
          className="imb-chat-input-textarea"
          rows={1}
          // Uncontrolled: React never rewrites the DOM value, so IME
          // composition and first keystrokes / pastes are never interrupted.
          defaultValue={text}
          placeholder={t("What are your instructions?")}
          disabled={disabled}
          minHeight={0}
          onInput={(e) =>
            syncDraftText(e.currentTarget.value, e.currentTarget.selectionStart)
          }
          onChange={onTextChange}
          onValueCommit={(val) => syncDraftText(val)}
          onSelect={onTextSelect}
          onKeyDown={onKeyDown}
        />
        <div className="imb-chat-input-actions">
          <AttachMenuButton
            open={popupOpen}
            onOpenChange={setPopupOpen}
            onPickFiles={() => fileInputRef.current?.click()}
            onPickFolder={() => void chooseFolders()}
          >
            <button
              type="button"
              role="menuitem"
              className="imb-attach-popup-item imb-menu-row"
              onClick={() => {
                setPopupOpen(false);
                setChatQuery("");
                setChatPickerError(null);
                setChatPickerOpen(true);
              }}
            >
              <IconChat />
              <span>{t("Conversation")}</span>
            </button>
            {/* Common projects: rows behind the separator, below the icon row.
                Nothing (not even the separator) renders when none is
                configured. */}
            {projects.length > 0 && (
              <>
                <div
                  className="imb-attach-popup-sep imb-menu-sep"
                  role="separator"
                />
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitem"
                    className="imb-attach-popup-item imb-menu-row"
                    onClick={() => void applyProject(project)}
                  >
                    <IconFolder />
                    <span className="imb-attach-project-name">
                      {project.name}
                    </span>
                    {project.tags.length > 0 && (
                      <span className="imb-attach-project-tags">
                        {project.tags.map((tag) => `#${tag}`).join(" ")}
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
          </AttachMenuButton>
          <button
            type="button"
            className="imb-send-btn-circle"
            aria-label={t("Send")}
            disabled={disabled || (!text.trim() && attachments.length === 0)}
            onClick={send}
          >
            <IconSend />
          </button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files ? Array.from(e.target.files) : null);
          e.target.value = "";
        }}
      />
      <Modal
        open={chatPickerOpen}
        onClose={() => setChatPickerOpen(false)}
        title={t("Conversation")}
        sub={t("Select a conversation to attach")}
        error={chatPickerError}
      >
        <SearchInput
          value={chatQuery}
          onValueChange={setChatQuery}
          placeholder={t("Search chats")}
        />
        <div className="imb-chat-picker-list">
          {chatCandidates.length === 0 ? (
            <div className="imb-chat-picker-empty">
              {t("No conversations found.")}
            </div>
          ) : (
            chatCandidates.map((chat) => {
              const title = displayTitle(chat.title);
              const preview = formatChatPreview(
                chat.preview,
                80,
                resolveMention,
              );
              return (
                <button
                  key={chat.id}
                  type="button"
                  className="imb-chat-picker-item"
                  onClick={() => attachChat(chat)}
                >
                  <Avatar letter={title.slice(0, 1)} name={title} size={30} />
                  <span className="imb-chat-picker-text">
                    <span className="imb-chat-picker-title">{title}</span>
                    {preview.length > 0 && (
                      <span className="imb-chat-picker-preview">{preview}</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </Modal>
    </div>
  );
}
