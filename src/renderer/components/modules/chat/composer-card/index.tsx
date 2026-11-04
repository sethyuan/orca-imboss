import { MAX_USER_ATTACHMENTS } from "@shared/constants/attachments";
import { t } from "@shared/l10n";
import type { ChatSummary } from "@shared/types";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { cls } from "reactutils";
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
  nextAttachmentId,
  type ComposerDraftView,
  type PendingAttachment,
} from "../../../../chat-draft";
import { ChatAvatar } from "../../../chat-avatar";
import { IconChat, IconSend } from "../../../icons";
import { useMentionResolver } from "../../../markdown/use-mention";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { Textarea } from "../../../textarea";
import { DraftAttachmentChips } from "../attachment-draft";
import { AttachMenuButton } from "../attachment-draft/attach-menu";
import { formatChatPreview } from "../preview-text";
import { displayTitle } from "../relative-time";
import "../chat-input-bar/index.css";

/**
 * The draft one composer edits, plus the four mutations it needs.
 *
 * The card never touches a store: the chat composer edits
 * `appStore.chatDrafts` (per chat) and the agent-session composer edits
 * `appStore.sessionDrafts` (per `(employee, chat)`), so which store is behind a
 * draft is the caller's business. `attachmentCount` deliberately reads the
 * **live** store value (not the render snapshot) so an async add can never
 * overshoot the cap against a snapshot that is one frame behind.
 */
export interface ComposerDraftBinding {
  /**
   * Draft being edited, as currently rendered (text + pending attachments).
   * Deeply readonly on purpose: this is a valtio snapshot, and the card must
   * never mutate it — every change goes through the mutations below (which
   * write to the store and notify subscribers).
   */
  draft: ComposerDraftView;
  /**
   * Chat the pasted-file store is keyed by: main writes clipboard-synthesized
   * files to `<dataRoot>/attachments/<chatId>/…` (and remote mode uploads per
   * conversation). Both composers have a real chat to point at.
   */
  storageChatId: number;
  setText(text: string): void;
  addAttachments(items: PendingAttachment[]): void;
  removeAttachment(index: number): void;
  /** Drop the whole draft; the store revokes its preview URLs. */
  clearDraft(): void;
  /** Current number of chips in the live draft (cap re-check). */
  attachmentCount(): number;
}

/** Imperative surface the call sites need (uncontrolled textarea + notices). */
export interface ComposerHandle {
  /** The live textarea (DOM value is the truth, React never rewrites it). */
  textarea(): HTMLTextAreaElement | null;
  focus(): void;
  /** Write the textarea **and** the draft, optionally placing the caret. */
  setText(text: string, caret?: number): void;
  /** Clear the textarea and the draft (after a send was accepted). */
  clear(): void;
  /** Append chips through the shared cap rules (a project's folder, etc.). */
  addAttachments(items: PendingAttachment[]): void;
  /** Show (or clear, with `null`) the card's one-shot notice slot. */
  notify(message: string | null): void;
  /** Close the attach menu (a caller-owned row was picked). */
  closeAttachMenu(): void;
}

export interface ComposerCardProps {
  binding: ComposerDraftBinding;
  placeholder: string;
  /** Send-button label/title: `Send`, or `Interject` while a run streams. */
  actionLabel: string;
  /** Disables the textarea and the attach/send controls. */
  disabled?: boolean;
  /** Disables sending only (e.g. a send is already in flight). */
  sendDisabled?: boolean;
  /** Caller-owned error line rendered above the input. */
  error?: string | null;
  /**
   * Draft identity. Changing it resets the transient UI (notice, open menu,
   * drop state, conversation picker) and syncs the DOM text from the draft. It
   * must never clear the draft itself.
   */
  resetKey: string | number;
  /** The live text of the textarea; sending/closing is the caller's decision. */
  onSend: (liveText: string) => void;
  /** Extra attach-menu rows after File/Folder (chat: the common projects). */
  attachMenuExtra?: ReactNode;
  /**
   * Called when the attach menu opens or closes. A caller whose extra rows come
   * from a store that Settings can change (the common projects) loads them on
   * open, so a settings edit is picked up without remounting the composer.
   */
  attachMenuOpenChange?: (open: boolean) => void;
  /** Panel min width, raised by a caller whose rows are wider. */
  attachMenuMinWidth?: number;
  /** Offer the "Conversation" reference row + its picker (default true). */
  attachConversations?: boolean;
  /** Overlay drawn above the textarea (chat: the `@`/`#` reference popup). */
  overlay?: ReactNode;
  /** Extra class on the outer wrapper (context-specific spacing). */
  className?: string;
  /**
   * Called for every keydown **before** the built-in Enter-to-send handling;
   * `true` means the caller consumed the key (e.g. reference-popup navigation).
   */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Called after the draft text was written (chat: `@` / `#` trigger detection). */
  onTextChanged?: (value: string, caret: number) => void;
  /** Called when the caret moved (chat: re-check the `@` / `#` trigger). */
  onCaretMove?: () => void;
}

/**
 * The composer card: pending attachment chips, the textarea and the
 * "attach + send" row — one implementation shared by the chat composer and the
 * agent-session composer.
 *
 * Extracted verbatim from `ChatInputBar` when the boss asked for the same
 * input in the agent-session view (minus the common projects). A second copy
 * would drift, and the rules living here — attachment cap, clipboard files
 * persisted before they can be sent, folders attached by path, chip removal
 * cleaning up the pasted copy — are exactly the kind of logic that drifts
 * silently.
 *
 * What stays with the call sites (and is therefore **not** here):
 * - the draft store (chat: per chat, session: per `(employee, chat)`);
 * - the send itself (chat: `chat:send` writes a message; session:
 *   `agentSession:send` only injects into that employee's Pi session);
 * - chat-only extras: the common-project rows (`attachMenuExtra`, whose pick
 *   also writes tags into the conversation), the `@`-mention / `#`-task-group popup
 *   (`overlay` + `onKeyDown` + `onTextChanged`) and the one-shot "a new chat
 *   was created" reset.
 *
 * The "Conversation" reference row is offered here because it is a generic
 * composer affordance (a `kind: "chat"` chip pointing at a chat id), used by
 * both composers.
 */
export function ComposerCard({
  binding,
  placeholder,
  actionLabel,
  disabled = false,
  sendDisabled = false,
  error = null,
  resetKey,
  onSend,
  attachMenuExtra,
  attachMenuOpenChange,
  attachMenuMinWidth,
  attachConversations = true,
  overlay,
  className,
  onKeyDown,
  onTextChanged,
  onCaretMove,
  ref,
}: ComposerCardProps & { ref?: Ref<ComposerHandle> }): React.JSX.Element {
  const draft = binding.draft;
  const attachments = draft.attachments;
  const [notice, setNotice] = useState<string | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  // Conversation picker: root chats selectable as `kind: "chat"` attachments.
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [chatQuery, setChatQuery] = useState("");
  const [chatOptions, setChatOptions] = useState<ChatSummary[]>([]);
  const [chatPickerError, setChatPickerError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The draft text as of the latest render, for effects that must not re-run on
  // every keystroke (the uncontrolled textarea is synced from it on reset).
  const draftTextRef = useRef(draft.text);
  draftTextRef.current = draft.text;

  // The card spawns no side effects on its own; the parent decides what a send
  // means. Read from the DOM (the truth) with the draft as a fallback.
  const liveText = (): string => textareaRef.current?.value ?? draft.text;

  const send = (): void => {
    if (disabled || sendDisabled) return;
    const value = liveText();
    if (value.trim().length === 0 && attachments.length === 0) return;
    onSend(value);
  };

  // Per-draft transient UI: a notice, an open menu or a drop highlight must
  // never carry over to another draft. Same rule as the chat composer had — the
  // draft itself is never touched here (that is what kept a chat switch from
  // losing the draft).
  useEffect(() => {
    setNotice(null);
    setPopupOpen(false);
    setDropActive(false);
    setChatPickerOpen(false);
    setChatPickerError(null);
    // Uncontrolled textarea: manually sync the DOM value to this draft (React
    // never rewrites it, so IME composition is never interrupted).
    if (textareaRef.current) textareaRef.current.value = draftTextRef.current;
  }, [resetKey]);

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

  // The menu's open state is the card's (it owns the trigger), but a caller may
  // need to load its own rows for it — report every change, including the
  // internal closes (a picked File/Folder row closes it too).
  useEffect(() => {
    attachMenuOpenChange?.(popupOpen);
  }, [attachMenuOpenChange, popupOpen]);

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
          chat.id !== binding.storageChatId,
      )
      .filter((chat) => q.length === 0 || chat.title.toLowerCase().includes(q));
  }, [chatOptions, chatQuery, binding.storageChatId]);

  // Plain-text previews of the picker rows resolve `@<id>` mentions exactly
  // like the chat list (non-interactive).
  const { resolveMention } = useMentionResolver(binding.storageChatId, false);

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
    const accepted = acceptWithinCap(
      items,
      binding.attachmentCount(),
      MAX_USER_ATTACHMENTS,
    );
    if (accepted.length > 0) {
      binding.addAttachments(accepted);
    }
  };

  /**
   * Attach an existing conversation as a `kind: "chat"` chip (a reference, not
   * a file). Deduped and capped like every other attachment; the title is
   * snapshotted now so a later rename cannot desync the chip label.
   */
  const attachChat = (chat: ChatSummary): void => {
    setChatPickerOpen(false);
    const live = draft.attachments;
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
    void addEntries(
      Array.from(files).map((file) => ({ file, kind: "file" as const })),
    );
  };

  const addEntries = async (entries: readonly FileEntry[]): Promise<void> => {
    if (entries.length === 0) return;
    setNotice(null);
    const { items, failedFolders } = await pendingFromEntries(
      entries,
      capCount(entries.length),
      binding.storageChatId,
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
        try {
          next.push(
            toPendingAttachment(
              file,
              await fileAttachment(file, binding.storageChatId),
            ),
          );
        } catch {
          failed += 1;
        }
        continue;
      }
      // Reject oversized payloads before reading their bytes into memory.
      if (isOversizedFile(file)) {
        failed += 1;
        continue;
      }
      try {
        next.push(
          toPendingAttachment(
            file,
            await persistPastedFile(binding.storageChatId, file),
          ),
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
    void addEntries(dropEntries(dataTransfer));
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

  const onKeyDownInternal = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    // The caller's keys first: a picker navigation must win over "Enter sends".
    if (onKeyDown?.(event) === true) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    // Never send mid-composition (Enter commits an IME candidate). `Textarea`
    // already swallows keydowns while composing; this is a second guard.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  useImperativeHandle(ref, () => ({
    textarea: () => textareaRef.current,
    focus: () => textareaRef.current?.focus(),
    setText: (value: string, caret?: number): void => {
      const textarea = textareaRef.current;
      // Write through the DOM directly: React never rewrites an uncontrolled
      // value, so updating only the store would leave the visible input
      // unchanged.
      if (textarea) {
        textarea.value = value;
        textarea.focus();
        if (caret !== undefined) textarea.setSelectionRange(caret, caret);
      }
      binding.setText(value);
    },
    clear: (): void => {
      if (textareaRef.current) textareaRef.current.value = "";
      binding.clearDraft();
      setNotice(null);
    },
    addAttachments: (items: PendingAttachment[]): void => {
      // Same cap path as an OS pick: warn on overflow instead of silently
      // dropping the caller's chips.
      const room = capCount(items.length);
      if (room <= 0) return;
      commitPending(items.slice(0, room));
    },
    notify: (message: string | null): void => setNotice(message),
    closeAttachMenu: (): void => setPopupOpen(false),
  }));

  const sendDisabledInternal =
    disabled ||
    sendDisabled ||
    (draft.text.trim().length === 0 && attachments.length === 0);

  return (
    <div
      className={cls(
        "imb-chat-input-wrap",
        dropActive && "imb-drop-active",
        className,
      )}
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
          onRemove={(_item, index) => binding.removeAttachment(index)}
          onViewerClose={() => {
            // Hand the caret back to the composer: closing the viewer returns
            // the boss to typing, not to a dead close button.
            textareaRef.current?.focus();
          }}
        />
        {error !== null && (
          <p className="imb-composer-error" role="alert">
            {error}
          </p>
        )}
        {notice !== null && <div className="imb-attach-notice">{notice}</div>}
        {overlay}
        <Textarea
          ref={textareaRef}
          className="imb-chat-input-textarea"
          rows={1}
          // Uncontrolled: React never rewrites the DOM value, so IME
          // composition and first keystrokes / pastes are never interrupted.
          defaultValue={draft.text}
          placeholder={placeholder}
          disabled={disabled}
          minHeight={0}
          onInput={(e) => {
            const value = e.currentTarget.value;
            binding.setText(value);
            onTextChanged?.(value, e.currentTarget.selectionStart);
          }}
          onChange={(e) => {
            const value = e.target.value;
            binding.setText(value);
            onTextChanged?.(value, e.target.selectionStart ?? value.length);
          }}
          onValueCommit={(value) => {
            binding.setText(value);
            onTextChanged?.(
              value,
              textareaRef.current?.selectionStart ?? value.length,
            );
          }}
          onSelect={() => onCaretMove?.()}
          onKeyDown={onKeyDownInternal}
        />
        <div className="imb-chat-input-actions">
          <AttachMenuButton
            open={popupOpen}
            onOpenChange={setPopupOpen}
            onPickFiles={() => fileInputRef.current?.click()}
            onPickFolder={() => void chooseFolders()}
            minWidth={attachMenuMinWidth}
          >
            {attachConversations && (
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
            )}
            {attachMenuExtra}
          </AttachMenuButton>
          <button
            type="button"
            className="imb-send-btn-circle"
            aria-label={actionLabel}
            title={actionLabel}
            disabled={sendDisabledInternal}
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
                  <ChatAvatar
                    participants={chat.participants}
                    fromChatId={chat.fromChatId}
                    directEmployeeId={chat.directEmployeeId}
                    size={30}
                    title={title}
                  />
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
