import { MAX_USER_ATTACHMENTS } from "@shared/constants/attachments";
import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { cls } from "reactutils";
import {
  clearAskDraft,
  pruneAskDraft,
  readAskDraft,
  removeAskDraftAttachment,
  setAskDraftAttachments,
  setAskDraftSelection,
  setAskDraftText,
} from "../../../../ask-draft";
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
  toPlainAttachment,
  type PendingAttachment,
} from "../../../../chat-draft";
import { EmployeeAvatar } from "../../../employee-avatar";
import { Markdown } from "../../../markdown";
import { DraftAttachmentChips } from "../attachment-draft";
import { AttachMenuButton } from "../attachment-draft/attach-menu";
import { type AnswerItem, parseAnswer } from "../ask-answer";
import {
  MessageAttachments,
  useMessageAttachments,
} from "../message-attachments";
import { MessageBubble } from "../message-bubble";
import { MessageTime } from "../message-time";
import "./index.css";

export interface AskCardProps {
  message: Message;
  /** Read-only rendering: inputs are disabled and the submit button is hidden. */
  readonly?: boolean;
  /** Called after a successful answer so the chat thread can reload. */
  onAnswered: () => void;
  /**
   * The answer message folded into this card, when the question has already
   * been answered. Seeds the retained options/text and marks the card answered.
   */
  answer?: Message;
  /** Click handler for the sender avatar (opens the agent session). */
  onAvatarClick?: () => void;
  /** Resolve `@<id>` mentions in question/option text (non-interactive here). */
  resolveMention?: (id: number) => string | null;
  /** Exact send time, revealed on hover at the card's bottom-right corner. */
  timeLabel?: string | null;
}

interface AskQuestion {
  id: string;
  text: string;
  type?: "single" | "multiple" | "free";
  options?: string[];
}

interface AskPayload {
  questions: AskQuestion[];
}

interface AnswerDraft {
  questionId: string;
  selected?: string[];
  text?: string;
}

/**
 * Interactive inline ask card (kind=`ask`). Parses the message `content` as a
 * JSON question set, renders candidate options and/or free-form inputs per
 * question, and submits the answers via `messages:answer`. A parse failure or
 * an empty set degrades to the generic message bubble.
 */
export function AskCard({
  message,
  readonly = false,
  onAnswered,
  answer,
  onAvatarClick,
  resolveMention,
  timeLabel,
}: AskCardProps): React.JSX.Element {
  const self = message.senderEmployeeId === null;
  // Memoised so the question set keeps its identity across re-renders (the
  // draft reconciliation effect depends on it).
  const payload = useMemo(() => parseAsk(message.content), [message.content]);
  const persisted = useMemo(
    () => (answer ? parseAnswer(answer.content) : null),
    [answer],
  );
  // Unsubmitted input is written through to `ask-draft` on every edit: a page or
  // chat switch unmounts the whole module, so only that store survives.
  const [selectedByQuestion, setSelectedByQuestion] = useState<
    Record<string, string[]>
  >(() => {
    if (persisted) return seedSelected(persisted.answers);
    return seedDraftSelected(readAskDraft(message.id)?.selected);
  });
  const [textByQuestion, setTextByQuestion] = useState<Record<string, string>>(
    () => {
      if (persisted) return seedText(persisted.answers);
      return seedDraftText(readAskDraft(message.id)?.text);
    },
  );
  // Files attached to the pending answer. Seeded from the retained draft so a
  // module switch (which unmounts the card) does not lose them.
  const [draftAttachments, setDraftAttachments] = useState<PendingAttachment[]>(
    () => (persisted ? [] : [...(readAskDraft(message.id)?.attachments ?? [])]),
  );
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(persisted !== null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Attachments travel on the ask message itself (`imb_ask` accepts them), so
  // the card must render them too — the question set is usually *about* them.
  // The hook is called before the parse-failure fallback below, because hooks
  // cannot sit behind an early return; the fallback's `MessageBubble` keeps its
  // own independent copy of this state.
  const attachmentView = useMessageAttachments({
    messageId: message.id,
    attachments: message.attachments,
    attachmentsTotal: message.attachmentsTotal,
  });
  // The files the boss attached to *this* answer. They live on the answer
  // message, so this view must be bound to that message's id (the reveal IPC
  // resolves the path from it). Hooks cannot be called conditionally, so the
  // idle case passes the ask message id with no attachments: it renders
  // nothing.
  const answerAttachmentView = useMessageAttachments({
    messageId: answer?.id ?? message.id,
    attachments: answer?.attachments ?? null,
    attachmentsTotal: answer?.attachmentsTotal ?? null,
  });

  // Rehydrate when the folded answer arrives after mount (thread reload).
  useEffect(() => {
    if (!persisted) return;
    setSelectedByQuestion(seedSelected(persisted.answers));
    setTextByQuestion(seedText(persisted.answers));
    setSubmitted(true);
    // An answered card has no draft any more: a retained one would be a ghost
    // from the moment before the answer landed (e.g. a submit followed by a
    // reload that arrived before the store was cleared). Dropping it also drops
    // whatever the unsubmitted chips owned — they were never sent.
    setDraftAttachments([]);
    clearAskDraft(message.id);
  }, [persisted, message.id]);

  // Drop retained answers to questions this payload no longer declares.
  useEffect(() => {
    if (!payload) return;
    pruneAskDraft(
      message.id,
      new Set(payload.questions.map((question) => question.id)),
    );
  }, [message.id, payload]);

  if (!payload) {
    return (
      <MessageBubble
        self={self}
        messageId={message.id}
        content={message.content}
        attachments={message.attachments}
        attachmentsTotal={message.attachmentsTotal}
        resolveMention={resolveMention}
        avatar={
          <EmployeeAvatar
            employeeId={message.senderEmployeeId}
            size={34}
            onClick={onAvatarClick}
          />
        }
      />
    );
  }

  /**
   * Record the chosen options of one question — in the card (instant feedback)
   * and in the retained draft (survives an unmount). No-ops once the card is
   * answered or read-only, mirroring the disabled inputs.
   */
  const applySelection = (questionId: string, selected: string[]): void => {
    if (submitted || readonly) return;
    setSelectedByQuestion((previous) => ({
      ...previous,
      [questionId]: selected,
    }));
    setAskDraftSelection(message.id, message.chatId, questionId, selected);
  };

  /** Record the free-form text of one question (card + retained draft). */
  const applyText = (questionId: string, text: string): void => {
    if (submitted || readonly) return;
    setTextByQuestion((previous) => ({ ...previous, [questionId]: text }));
    setAskDraftText(message.id, message.chatId, questionId, text);
  };

  /**
   * Replace the pending attachments (draft store + card state in one step), so
   * the store — the only thing that survives an unmount — always agrees with
   * what is on screen.
   */
  const commitAttachments = (next: PendingAttachment[]): void => {
    setDraftAttachments(next);
    setAskDraftAttachments(message.id, message.chatId, next);
  };

  /** Cap a requested count to the free slots, warning on overflow. */
  const capCount = (count: number): number => {
    const remaining = Math.max(
      MAX_USER_ATTACHMENTS - draftAttachments.length,
      0,
    );
    if (count > remaining) {
      setAttachNotice(
        t("Up to ${count} attachments allowed.", {
          count: String(MAX_USER_ATTACHMENTS),
        }),
      );
    }
    return remaining;
  };

  /** Append chips, re-checking the cap against the live list. */
  const addAttachments = (items: PendingAttachment[]): void => {
    if (items.length === 0) return;
    const accepted = acceptWithinCap(
      items,
      draftAttachments.length,
      MAX_USER_ATTACHMENTS,
    );
    if (accepted.length === 0) return;
    commitAttachments([...draftAttachments, ...accepted]);
  };

  const removeAttachment = (id: number): void => {
    setAttachNotice(null);
    removeAskDraftAttachment(message.id, message.chatId, id);
    setDraftAttachments((previous) =>
      previous.filter((item) => item.id !== id),
    );
  };

  /**
   * Attach picked/dropped entries (files and folders). A folder rides along by
   * absolute path only — the agent reads the directory in place — and a folder
   * without a resolvable path is reported instead of becoming a dead chip.
   */
  const addEntries = (entries: readonly FileEntry[]): void => {
    if (entries.length === 0) return;
    setAttachNotice(null);
    const { items, failedFolders } = pendingFromEntries(
      entries,
      capCount(entries.length),
    );
    if (failedFolders > 0) {
      setAttachNotice(
        failedFolders === 1
          ? t("Could not attach the folder.")
          : t("Could not attach ${count} folders.", {
              count: String(failedFolders),
            }),
      );
    }
    addAttachments(items);
  };

  /** Attach files chosen in the native picker. */
  const addFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    addEntries(files.map((file) => ({ file, kind: "file" as const })));
  };

  /**
   * Attach folders chosen in the native directory dialog (multi-select; each
   * folder counts as one attachment toward the cap).
   */
  const chooseFolders = async (): Promise<void> => {
    setAttachNotice(null);
    let items: PendingAttachment[];
    try {
      items = await chooseFolderAttachments();
    } catch {
      setAttachNotice(t("Could not attach the folder."));
      return;
    }
    if (items.length === 0) return;
    addAttachments(items.slice(0, capCount(items.length)));
  };

  /**
   * Attach files from a paste. Clipboard-synthesized files have no backing
   * path, so their bytes are persisted first (giving the agent a readable
   * `path`); files already on disk keep their original path. Same rule as the
   * chat composer.
   */
  const addPastedFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setAttachNotice(null);
    const next: PendingAttachment[] = [];
    let failed = 0;
    for (const file of files.slice(0, capCount(files.length))) {
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
          toPendingAttachment(
            file,
            await persistPastedFile(message.chatId, file),
          ),
        );
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      setAttachNotice(
        failed === 1
          ? t("Could not attach the pasted file.")
          : t("Could not attach ${count} pasted files.", {
              count: String(failed),
            }),
      );
    }
    addAttachments(next);
  };

  /**
   * Paste inside the card attaches files. Text pastes are untouched: only a
   * clipboard that actually carries files is intercepted (and consumed, so an
   * accompanying text representation is not also typed into a question field).
   */
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (submitted || readonly) return;
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addPastedFiles(files);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (submitted || readonly) return;
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    // Moving over a child fires dragleave on the parent; ignore those.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDropActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    setDropActive(false);
    if (submitted || readonly) return;
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    // Files and folders alike: a folder is attached by path (the shared helper
    // tells them apart and rejects a folder whose path cannot be resolved).
    addEntries(dropEntries(event.dataTransfer));
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitted || submitting) return;
    const answers = buildAnswers(
      payload.questions,
      selectedByQuestion,
      textByQuestion,
    );
    if (answers.length === 0) {
      setError(t("Please answer at least one question first."));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Plain objects: chips come out of the valtio-free draft store, but keep
      // the same pinning the composer does so an IPC clone can never see a
      // proxy (or an unexpected field).
      const attachments = draftAttachments.map((item) =>
        toPlainAttachment(item.attachment),
      );
      await imb.messages.answer(
        message.chatId,
        message.id,
        { answers },
        attachments.length > 0 ? attachments : undefined,
      );
      setSubmitted(true);
      // The answer is persisted now: the draft has become the answer message.
      // `keepFiles` — those attachments are referenced by the new message, so
      // only the thumbnail URLs may be released.
      clearAskDraft(message.id, { keepFiles: true });
      setDraftAttachments([]);
      setAttachNotice(null);
      onAnswered();
    } catch (err) {
      // Keep the draft (selections, text *and* chips): a failed submit must not
      // lose anything the boss attached or typed.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={cls("imb-msg", self ? "imb-self" : "imb-other")}
      // Row anchor for jumps (the row-anchoring contract, see `../message-item`).
      data-message-id={message.id}
    >
      <EmployeeAvatar
        employeeId={message.senderEmployeeId}
        size={34}
        onClick={onAvatarClick}
      />
      <div
        className={cls(
          "imb-ask-card",
          submitted && "imb-ask-card-submitted",
          dropActive && "imb-drop-active",
        )}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dropActive && (
          <div className="imb-drop-hint">
            {t("Drop files or folders to attach")}
          </div>
        )}
        <div className="imb-ask-card-title">{t("Question")}</div>
        {/* Material above, questions below: the attachments are what the boss
            is being asked to look at before choosing. */}
        <MessageAttachments view={attachmentView} self={self} />
        {payload.questions.map((q) => (
          <div className="imb-ask-question" key={q.id}>
            <div className="imb-ask-q-text">
              <Markdown
                content={q.text}
                inline
                resolveMention={resolveMention}
              />
            </div>
            {isFreeForm(q) ? (
              <textarea
                className="imb-ask-free"
                value={textByQuestion[q.id] ?? ""}
                disabled={submitted || readonly}
                onChange={(e) => applyText(q.id, e.target.value)}
                placeholder={t("Type your answer")}
              />
            ) : q.type === "single" ? (
              <div className="imb-ask-options">
                {q.options!.map((opt) => (
                  <label className="imb-ask-option" key={opt}>
                    <input
                      type="radio"
                      name={`imb-${message.id}-q-${q.id}`}
                      checked={selectedByQuestion[q.id]?.includes(opt) ?? false}
                      disabled={submitted || readonly}
                      onChange={() => {
                        applySelection(q.id, [opt]);
                        applyText(q.id, "");
                      }}
                    />
                    <span>
                      <Markdown
                        content={opt}
                        inline
                        resolveMention={resolveMention}
                      />
                    </span>
                  </label>
                ))}
                <input
                  className="imb-ask-other"
                  value={textByQuestion[q.id] ?? ""}
                  disabled={submitted || readonly}
                  onChange={(e) => {
                    applyText(q.id, e.target.value);
                    applySelection(q.id, []);
                  }}
                  placeholder={t("Other (type a free-form answer)")}
                />
              </div>
            ) : (
              <div className="imb-ask-options">
                {q.options!.map((opt) => (
                  <label className="imb-ask-option" key={opt}>
                    <input
                      type="checkbox"
                      checked={selectedByQuestion[q.id]?.includes(opt) ?? false}
                      disabled={submitted || readonly}
                      onChange={() => {
                        const current = selectedByQuestion[q.id] ?? [];
                        applySelection(
                          q.id,
                          current.includes(opt)
                            ? current.filter((option) => option !== opt)
                            : [...current, opt],
                        );
                      }}
                    />
                    <span>
                      <Markdown
                        content={opt}
                        inline
                        resolveMention={resolveMention}
                      />
                    </span>
                  </label>
                ))}
                <input
                  className="imb-ask-other"
                  value={textByQuestion[q.id] ?? ""}
                  disabled={submitted || readonly}
                  onChange={(e) => applyText(q.id, e.target.value)}
                  placeholder={t("Other (type a free-form answer)")}
                />
              </div>
            )}
          </div>
        ))}
        {!readonly && !submitted && (
          <div className="imb-ask-attach">
            <AttachMenuButton
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onPickFiles={() => fileInputRef.current?.click()}
              onPickFolder={() => void chooseFolders()}
            />
            <DraftAttachmentChips
              items={draftAttachments}
              onRemove={(item) => removeAttachment(item.id)}
              // No caret to hand back: the card has no single input.
            />
            <input
              ref={fileInputRef}
              className="imb-ask-file-input"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                addFiles(
                  event.target.files ? Array.from(event.target.files) : [],
                );
                // Allow re-picking the same file (the input keeps its value).
                event.target.value = "";
              }}
            />
            {attachNotice !== null && (
              <div className="imb-ask-attach-notice">{attachNotice}</div>
            )}
          </div>
        )}
        {answerAttachmentView.hasAttachments && (
          <div className="imb-ask-answer-attachments">
            <MessageAttachments view={answerAttachmentView} self={self} />
          </div>
        )}
        {!readonly &&
          (submitted ? (
            <div className="imb-ask-submitted">{t("Answered")}</div>
          ) : (
            <button
              type="button"
              className="imb-ask-submit"
              disabled={submitting}
              onClick={() => void handleSubmit()}
            >
              {t("Submit answer")}
            </button>
          ))}
        {!readonly && error !== null && (
          <div className="imb-ask-error">{error}</div>
        )}
        <MessageTime label={timeLabel} />
      </div>
    </div>
  );
}

/** Defensive parse of the ask payload; returns null on any invalid shape. */
function parseAsk(content: string): AskPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const questions = record["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const result: AskQuestion[] = [];
  for (const item of questions) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    if (typeof q["id"] !== "string" || q["id"].length === 0) continue;
    if (typeof q["text"] !== "string") continue;
    const type = q["type"];
    const options = q["options"];
    result.push({
      id: q["id"],
      text: q["text"],
      type:
        type === "single" || type === "multiple" || type === "free"
          ? type
          : undefined,
      options: Array.isArray(options)
        ? options.filter((o): o is string => typeof o === "string")
        : undefined,
    });
  }
  return result.length > 0 ? { questions: result } : null;
}

/** A question is free-form when it declares `free` or provides no candidates. */
function isFreeForm(q: AskQuestion): boolean {
  return q.type === "free" || !q.options || q.options.length === 0;
}

/** Seed the selected-option state from a persisted answer's items. */
function seedSelected(answers: AnswerItem[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const item of answers) {
    if (item.selected !== undefined && item.selected.length > 0) {
      result[item.questionId] = [...item.selected];
    }
  }
  return result;
}

/** Seed the free-text state from a persisted answer's items. */
function seedText(answers: AnswerItem[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of answers) {
    if (item.text !== undefined && item.text.length > 0) {
      result[item.questionId] = item.text;
    }
  }
  return result;
}

/** Seed the free-text state from a retained draft (defensive copies). */
function seedDraftText(
  text: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [questionId, value] of Object.entries(text ?? {})) {
    if (value.length > 0) result[questionId] = value;
  }
  return result;
}

/** Seed the selected-option state from a retained draft (defensive copies). */
function seedDraftSelected(
  selected: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [questionId, options] of Object.entries(selected ?? {})) {
    if (options.length > 0) result[questionId] = [...options];
  }
  return result;
}

/** Build the `{ answers: [...] }` payload from the current UI state. */
function buildAnswers(
  questions: AskQuestion[],
  selectedByQuestion: Record<string, string[]>,
  textByQuestion: Record<string, string>,
): AnswerDraft[] {
  const answers: AnswerDraft[] = [];
  for (const q of questions) {
    const free = (textByQuestion[q.id] ?? "").trim();
    const selected = selectedByQuestion[q.id] ?? [];
    if (isFreeForm(q)) {
      if (free) answers.push({ questionId: q.id, text: free });
      continue;
    }
    if (q.type === "single") {
      if (selected.length > 0) {
        answers.push({ questionId: q.id, selected });
      } else if (free) {
        answers.push({ questionId: q.id, text: free });
      }
      continue;
    }
    const draft: AnswerDraft = { questionId: q.id };
    if (selected.length > 0) draft.selected = selected;
    if (free) draft.text = free;
    if (selected.length > 0 || free) answers.push(draft);
  }
  return answers;
}
