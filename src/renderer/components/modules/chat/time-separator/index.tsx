import { useApp } from "../../../../app-store";
import { formatTimeSeparator } from "../relative-time";
import "./index.css";

export interface TimeSeparatorProps {
  /** Timestamp (UNIX seconds) of the first message in the group below it. */
  secs: number;
}

/**
 * Centered divider between message groups (WeChat-style rough time), shared
 * by the interactive thread and the read-only group-chat thread. Where one
 * belongs is decided by `shouldShowTimeSeparator`; the exact time of a single
 * message is the bubble's hover time instead.
 */
export function TimeSeparator({ secs }: TimeSeparatorProps): React.JSX.Element {
  const { locale } = useApp();
  return (
    <div className="imb-time-separator">
      {formatTimeSeparator(secs, locale)}
    </div>
  );
}
