import { t } from "@shared/l10n";
import type { AgentSessionSendResult } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { appStore, sessionKey, useAppSync } from "../../../../app-store";
import { IconSend } from "../../../icons";
import { Textarea } from "../../../textarea";
// The chat composer's card/textarea/send-button styles are reused verbatim so
// this composer has identical geometry and states; only the pieces that are
// specific to this view (hint line, "to" label, error line) live in the
// module's own stylesheet.
import "../../chat/chat-input-bar/index.css";

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
  /** Called after the main process accepted the text (cleared from the draft). */
  onSent: (text: string, result: AgentSessionSendResult) => void;
}

/**
 * Bottom composer of the read-only agent-session view: the boss types a message
 * and it is injected into **this** `(employee, chat)` Pi session only.
 *
 * Deliberately not the chat composer: no attachments, no tag/mention pickers,
 * no tags or title side effects, and it stays a single row (input + send). The
 * draft lives on the app store per session key so switching modules does not
 * lose it, and the textarea is uncontrolled (React never rewrites the DOM
 * value, so IME composition and the first keystrokes are never disturbed).
 * The only run-state affordance is the send button's label/title
 * (`Send` vs `Interject`).
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
  const text = snap.sessionDrafts[draftKey] ?? "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Guards a double submit before the first render lands (`sending` is async). */
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (): Promise<void> => {
    if (sendingRef.current) return;
    // The DOM owns the live value (uncontrolled), so read it rather than the
    // store: the store may be one input event behind on the very first paste.
    const textarea = textareaRef.current;
    const value = textarea?.value ?? text;
    if (value.trim().length === 0) return;

    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await imb.agentSession.send(employeeId, chatId, value);
      // Accepted: clear the DOM and the draft together, otherwise a remount
      // would resurrect text that is already on its way to the agent.
      if (textarea) textarea.value = "";
      appStore.clearSessionDraft(draftKey);
      onSent(value, result);
      textarea?.focus();
    } catch (err) {
      // Keep the text (nothing typed may be lost) and surface the reason: only
      // an invalid request reaches here — run failures arrive as events.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [chatId, draftKey, employeeId, onSent, text]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // Never send mid-composition (Enter commits an IME candidate). `Textarea`
    // already swallows keydowns while composing; this is a second guard.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const actionLabel = streaming ? t("Interject") : t("Send");
  const disabled = sending || text.trim().length === 0;

  // A withdrawn interjection comes back here. The textarea is uncontrolled (its
  // DOM value is the source of truth), so the value is written imperatively and
  // mirrored into the store — exactly like a paste would. Done in an effect so
  // the write happens after React commits, and guarded by `token` so a re-render
  // never repeats it.
  const refillTokenRef = useRef(0);
  useEffect(() => {
    if (!refill || refill.token === refillTokenRef.current) return;
    refillTokenRef.current = refill.token;
    const textarea = textareaRef.current;
    if (textarea) textarea.value = refill.text;
    appStore.setSessionDraftText(draftKey, refill.text);
    textarea?.focus();
  }, [refill, draftKey]);

  return (
    <div className="imb-chat-input-wrap imb-session-composer">
      <div className="imb-chat-input-card">
        {error !== null && (
          <p className="imb-session-composer-error" role="alert">
            {error}
          </p>
        )}
        {/* One row: the input grows left, the send button sits right, flush with
            the input's last line (so a multi-line draft never moves the button
            into the middle of the text). */}
        <div className="imb-session-composer-row">
          <Textarea
            ref={textareaRef}
            className="imb-chat-input-textarea"
            rows={1}
            minHeight={0}
            defaultValue={text}
            placeholder={t("Message ${name} directly", { name: employeeName })}
            onInput={(event) =>
              appStore.setSessionDraftText(draftKey, event.currentTarget.value)
            }
            onValueCommit={(value) =>
              appStore.setSessionDraftText(draftKey, value)
            }
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="imb-send-btn-circle imb-session-composer-send"
            aria-label={actionLabel}
            title={actionLabel}
            disabled={disabled}
            onClick={() => void send()}
          >
            <IconSend />
          </button>
        </div>
      </div>
    </div>
  );
}
