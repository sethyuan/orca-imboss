import {
  MAX_ATTACHMENT_BYTES,
  MAX_USER_ATTACHMENTS,
} from "@shared/constants/attachments";
import { t } from "@shared/l10n";
import type { MessageAttachment } from "@shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import { appStore, useAppSync } from "../../../../app-store";
import {
  EMPTY_DRAFT,
  nextAttachmentId,
  toPlainAttachment,
  type PendingAttachment,
} from "../../../../chat-draft";
import { useClickOutside } from "../../../../hooks/use-click-outside";
import { useDropdownPosition } from "../../../../hooks/use-dropdown-position";
import { useEscapeKey } from "../../../../hooks/use-escape-key";
import {
  IconAttach,
  IconFile,
  IconFolder,
  IconImage,
  IconSend,
} from "../../../icons";
import { Textarea } from "../../../textarea";
import { Tooltip } from "../../../tooltip";
import { joinQuoteTexts } from "../quote-text";
import "./index.css";
import { MentionPopup } from "./mention-popup";

export interface ChatInputBarProps {
  disabled?: boolean;
  /** Chat whose draft this composer edits (drafts are per chat, on appStore). */
  chatId: number;
  /**
   * Bumped by the parent when a new chat is created. A non-zero change resets
   * the composer and focuses the textarea; `0` (the initial value) never
   * steals focus on mount.
   */
  focusToken?: number;
  /**
   * Bumped to move focus into the textarea without resetting the draft (used
   * after a selection is quoted). Unlike `focusToken`, it never clears input.
   */
  focusRequest?: number;
  onSend: (
    text: string,
    attachments: MessageAttachment[],
    quotedText?: string,
  ) => void;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|heic|heif)$/i;

/**
 * Best-effort image detection: prefer the MIME type the picker/drag source
 * supplies, falling back to the extension because some drag sources report an
 * empty type.
 */
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
}

/** True when a drag payload carries OS files (ignores text/link drags). */
function hasDroppedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes("Files");
}

/**
 * Collect clipboard files synchronously. `DataTransferItem`s are only valid
 * during the paste event, so this must not be deferred behind an await. Falls
 * back to `clipboardData.files` for sources without `items`.
 */
function filesFromClipboard(data: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0 && data.files.length > 0) {
    files.push(...Array.from(data.files));
  }
  return files;
}

/** Safe extension for a pasted file: its name first, then its MIME subtype. */
function extensionFor(file: File): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(file.name);
  if (match) return match[1].toLowerCase();
  const slash = file.type.indexOf("/");
  if (slash < 0) return "";
  const subtype = file.type.slice(slash + 1).toLowerCase();
  if (subtype === "jpeg") return "jpg";
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : "";
}

/** `pasted-YYYYMMDD-HHmmss.<ext>` name for a clipboard-synthesized file. */
function pastedName(file: File): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = extensionFor(file);
  return `pasted-${date}-${time}${ext.length > 0 ? `.${ext}` : ""}`;
}

/** Small quotation-mark glyph for a composer quote chip. */
function QuoteGlyph(): React.JSX.Element {
  return (
    <svg
      className="imb-quote-chip-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.4 6.2C5.2 7.7 4 9.9 4 12.8V18h5.7v-5.7H7.1c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
      <path d="M16.4 6.2c-2.2 1.5-3.4 3.7-3.4 6.6V18h5.7v-5.7h-2.6c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
    </svg>
  );
}

export function ChatInputBar({
  disabled = false,
  chatId,
  focusToken = 0,
  focusRequest = 0,
  onSend,
}: ChatInputBarProps): React.JSX.Element {
  // The draft is per chat and lives on appStore so it survives the chat module
  // being unmounted on a module switch. `sync: true` keeps the controlled
  // textarea's value/caret in step with the store.
  const snap = useAppSync();
  const draft = snap.chatDrafts[chatId] ?? EMPTY_DRAFT;
  const { text, attachments, quotes } = draft;

  const [notice, setNotice] = useState<string | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);

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
  const popupRef = useRef<HTMLDivElement>(null);
  const popupMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { panelStyle, positionPanel } = useDropdownPosition(popupRef);

  // A selection was quoted: move focus into the textarea without resetting the
  // draft (unlike `focusToken`).
  useEffect(() => {
    if (focusRequest === 0) return;
    textareaRef.current?.focus();
  }, [focusRequest]);

  // A new chat resets the composer (draft/attachments) and lands the caret in
  // the input. `focusToken` starts at `0`, so mounting with an existing chat
  // never steals focus.
  useEffect(() => {
    if (focusToken === 0) return;
    appStore.clearChatDraft(chatId);
    setNotice(null);
    setPopupOpen(false);
    setDropActive(false);
    if (textareaRef.current) textareaRef.current.value = "";
    textareaRef.current?.focus();
  }, [focusToken, chatId]);

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

  // The menu is portaled to `document.body`, so it lives outside `popupRef`;
  // both count as "inside" for click-outside purposes.
  const popupOutsideRefs = useMemo(() => [popupRef, popupMenuRef], []);
  useClickOutside(popupOutsideRefs, () => setPopupOpen(false), popupOpen);
  useEscapeKey(() => setPopupOpen(false), popupOpen);

  // Reposition the portaled menu if the viewport scrolls/resizes while open.
  useEffect(() => {
    if (!popupOpen) return;
    const reposition = (): void => positionPanel();
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [popupOpen, positionPanel]);

  const send = (): void => {
    const value = text.trim();
    if (disabled) return;
    if (!value && attachments.length === 0 && quotes.length === 0) return;
    // The quote rides as its own field on the message (never mixed into the
    // body) so the bubble shows it separately and the model still gets it.
    onSend(
      value,
      attachments.map((item) => toPlainAttachment(item.attachment)),
      joinQuoteTexts(quotes),
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

  /** Build a chip for a file, minting a thumbnail URL for images. */
  const buildPending = (
    file: File,
    attachment: MessageAttachment,
  ): PendingAttachment => {
    const previewUrl = isImageFile(file)
      ? URL.createObjectURL(file)
      : undefined;
    return {
      id: nextAttachmentId(),
      attachment,
      ...(previewUrl ? { previewUrl } : {}),
    };
  };

  /**
   * Append chips, re-checking the cap against the live draft so an async add
   * cannot overshoot a concurrent one. Preview URLs for dropped chips are
   * revoked so they never leak.
   */
  const commitPending = (items: PendingAttachment[]): void => {
    if (items.length === 0) return;
    const liveCount = appStore.chatDrafts[chatId]?.attachments.length ?? 0;
    const room = Math.max(MAX_USER_ATTACHMENTS - liveCount, 0);
    for (const item of items.slice(room)) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      // A persisted pasted file whose chip did not fit is now unreferenced.
      if (item.attachment.path) {
        void imb.files.deletePastedFile(item.attachment.path);
      }
    }
    const accepted = items.slice(0, room);
    if (accepted.length > 0) {
      appStore.addChatDraftAttachments(chatId, accepted);
    }
  };

  const addFiles = (files: readonly File[] | null): void => {
    if (!files || files.length === 0) return;
    addEntries(
      Array.from(files).map((file) => ({ file, kind: "file" as const })),
    );
  };

  const addEntries = (
    entries: readonly { file: File; kind: "file" | "folder" }[],
  ): void => {
    if (entries.length === 0) return;
    setNotice(null);
    const next: PendingAttachment[] = [];
    let failedFolders = 0;
    for (const { file, kind } of entries.slice(0, capCount(entries.length))) {
      // `webUtils.getPathForFile` (preload) yields "" for JS-constructed files;
      // only persist a real on-disk path so the chip is revealable.
      const path = imb.files.getPath(file);
      if (kind === "folder") {
        // A folder is only useful through its absolute path: the model reads
        // the directory in place and the chip has no bytes to preview. A
        // folder without a resolvable path is rejected rather than attached.
        if (!path) {
          failedFolders += 1;
          continue;
        }
        next.push({
          id: nextAttachmentId(),
          attachment: {
            name: file.name || path,
            size: 0,
            type: "folder",
            path,
            kind: "folder",
          },
        });
        continue;
      }
      next.push(
        buildPending(file, {
          name: file.name || pastedName(file),
          size: file.size,
          type: file.type,
          ...(path ? { path } : {}),
        }),
      );
    }
    if (failedFolders > 0) {
      setNotice(
        failedFolders === 1
          ? t("Could not attach the folder.")
          : t("Could not attach ${count} folders.", {
              count: String(failedFolders),
            }),
      );
    }
    commitPending(next);
    setPopupOpen(false);
  };

  /**
   * Attach folders chosen through the native directory dialog. The absolute
   * path originates in main, so it is authoritative; a folder counts as one
   * attachment toward the cap but has no bytes to preview.
   */
  const chooseFolders = async (): Promise<void> => {
    setNotice(null);
    let directories: { name: string; path: string }[] | null;
    try {
      directories = await imb.files.chooseDirectories();
    } catch {
      setNotice(t("Could not attach the folder."));
      return;
    }
    if (!directories || directories.length === 0) return;
    const next: PendingAttachment[] = [];
    for (const directory of directories.slice(
      0,
      capCount(directories.length),
    )) {
      next.push({
        id: nextAttachmentId(),
        attachment: {
          name: directory.name,
          size: 0,
          type: "folder",
          path: directory.path,
          kind: "folder",
        },
      });
    }
    commitPending(next);
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
      const path = imb.files.getPath(file);
      if (path) {
        next.push(
          buildPending(file, {
            name: file.name || pastedName(file),
            size: file.size,
            type: file.type,
            path,
          }),
        );
        continue;
      }
      // Reject oversized images before reading their bytes into memory.
      if (file.size > MAX_ATTACHMENT_BYTES) {
        failed += 1;
        continue;
      }
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const saved = await imb.files.savePastedFile(
          chatId,
          pastedName(file),
          file.type,
          data,
        );
        next.push(buildPending(file, saved));
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

  // Folders dropped from the OS are attached by path (kind = "folder"); a
  // `File` alone cannot be told apart from an empty file, so Chromium's entry
  // API distinguishes them synchronously (no IPC).
  const addDropped = (dataTransfer: DataTransfer): void => {
    const entries: { file: File; kind: "file" | "folder" }[] = [];
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      let isDirectory = false;
      try {
        isDirectory = item.webkitGetAsEntry()?.isDirectory === true;
      } catch {
        // Some sources throw; treat the entry as a regular file.
        isDirectory = false;
      }
      entries.push({ file, kind: isDirectory ? "folder" : "file" });
    }
    // Sources without `items` (or with only string items) fall back to `files`.
    if (entries.length === 0) {
      for (const file of Array.from(dataTransfer.files)) {
        entries.push({ file, kind: "file" });
      }
    }
    addEntries(entries);
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
        {quotes.length > 0 && (
          <div className="imb-quote-chips">
            {quotes.map((quote, index) => (
              <div
                className="imb-quote-chip"
                key={`${quote.messageId ?? "q"}:${index}`}
              >
                <QuoteGlyph />
                <span className="imb-quote-chip-text">{quote.text}</span>
                <button
                  type="button"
                  className="imb-quote-chip-remove"
                  aria-label={t("Remove")}
                  onClick={() => appStore.removeChatDraftQuote(chatId, index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="imb-attached-files">
            {attachments.map((item, index) => {
              // Show the on-disk location so identical-looking chips (and
              // nameless thumbnails) can be told apart. Fall back to the name
              // when no path is available (e.g. a JS-constructed file).
              const location =
                item.attachment.path && item.attachment.path.length > 0
                  ? item.attachment.path
                  : item.attachment.name;
              return (
                <Tooltip
                  key={item.id}
                  placement="top"
                  content={
                    <span className="imb-attach-tooltip-path">{location}</span>
                  }
                >
                  <div className="imb-attached-file-thumb">
                    {item.previewUrl ? (
                      <img src={item.previewUrl} alt={item.attachment.name} />
                    ) : (
                      <div className="imb-file-icon-placeholder">
                        {item.attachment.kind === "folder" ? (
                          <IconFolder />
                        ) : (
                          <IconFile />
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      className="imb-attached-file-remove"
                      aria-label={`${t("Remove")} ${item.attachment.name}`}
                      onClick={() =>
                        appStore.removeChatDraftAttachment(chatId, index)
                      }
                    >
                      ×
                    </button>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        )}
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
          <div className="imb-attach-anchor" ref={popupRef}>
            <button
              type="button"
              className="imb-attach-btn"
              aria-label={t("Attach")}
              title={t("Attach")}
              onClick={() => {
                if (popupOpen) {
                  setPopupOpen(false);
                  return;
                }
                positionPanel();
                setPopupOpen(true);
              }}
            >
              <IconAttach />
            </button>
            {popupOpen &&
              panelStyle &&
              createPortal(
                <div
                  ref={popupMenuRef}
                  className="imb-attach-popup imb-open"
                  role="menu"
                  style={{
                    position: "fixed",
                    top: panelStyle.top,
                    bottom: panelStyle.bottom,
                    left: panelStyle.left,
                    width: panelStyle.width,
                    maxHeight: panelStyle.maxHeight,
                    right: "auto",
                    zIndex: 50,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="imb-attach-popup-item"
                    onClick={() => {
                      setPopupOpen(false);
                      imageInputRef.current?.click();
                    }}
                  >
                    <IconImage />
                    <span>{t("Image")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="imb-attach-popup-item"
                    onClick={() => {
                      setPopupOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <IconFile />
                    <span>{t("File")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="imb-attach-popup-item"
                    onClick={() => {
                      setPopupOpen(false);
                      void chooseFolders();
                    }}
                  >
                    <IconFolder />
                    <span>{t("Folder")}</span>
                  </button>
                </div>,
                document.body,
              )}
          </div>
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
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files ? Array.from(e.target.files) : null);
          e.target.value = "";
        }}
      />
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
    </div>
  );
}
