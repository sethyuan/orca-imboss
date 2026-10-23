import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { Fragment } from "react";
import { MessageItem } from "../message-item";
import { shouldShowTimeSeparator } from "../relative-time";
import { TimeSeparator } from "../time-separator";
import "./index.css";

export interface ProgressRunProps {
  /** At least two cards, oldest first. */
  messages: Message[];
  /** The transcript row above this run, if the run is not at the top. */
  previous: Message | undefined;
  expanded: boolean;
  onToggle: (firstId: number) => void;
  onAnswered: (chatId: number) => void;
}

/**
 * One contiguous progress run. Older cards stay mounted either way: collapsed
 * they are hidden, so in-chat find can still see their text and a hit can
 * open the run. The halt control stays on the latest card only.
 */
export function ProgressRun({
  messages,
  previous,
  expanded,
  onToggle,
  onAnswered,
}: ProgressRunProps): React.JSX.Element | null {
  const first = messages[0];
  const latest = messages[messages.length - 1];
  if (first === undefined || latest === undefined || first.id === latest.id) {
    return null;
  }
  const older = messages.slice(0, -1);
  const beforeLatest = older[older.length - 1];

  return (
    <div className="imb-progress-run">
      <div
        className="imb-progress-run-earlier"
        data-progress-run={first.id}
        hidden={!expanded}
      >
        {older.map((message, index) => {
          const before = index === 0 ? previous : older[index - 1];
          return (
            <Fragment key={message.id}>
              {shouldShowTimeSeparator(before, message) && (
                <TimeSeparator secs={message.createdAt} />
              )}
              <MessageItem
                message={message}
                onAnswered={onAnswered}
                showHalt={false}
              />
            </Fragment>
          );
        })}
      </div>
      {!expanded && shouldShowTimeSeparator(previous, latest) && (
        <TimeSeparator secs={latest.createdAt} />
      )}
      {expanded &&
        beforeLatest !== undefined &&
        shouldShowTimeSeparator(beforeLatest, latest) && (
          <TimeSeparator secs={latest.createdAt} />
        )}
      <div className="imb-progress-run-tail">
        <MessageItem message={latest} onAnswered={onAnswered} showHalt />
        <button
          type="button"
          className="imb-progress-run-toggle"
          aria-expanded={expanded}
          onClick={() => onToggle(first.id)}
        >
          {expanded ? t("Show latest progress only") : t("Show all progress")}
        </button>
      </div>
    </div>
  );
}
