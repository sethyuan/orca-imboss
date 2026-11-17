import { t } from "@shared/l10n";
import type { WorkRoom } from "@shared/types";
import { cls } from "reactutils";
import { appStore } from "../../../app-store";
import { EmployeeAvatar } from "../../employee-avatar";
import { Markdown } from "../../markdown";
import { useMentionResolver } from "../../markdown/use-mention";
import { ProgressCard } from "../chat/progress-card";

/**
 * The 2D board: the whole work-status view as cards, with no WebGL at all.
 *
 * This is not only a safety net for machines without a usable GPU — it is also
 * the shape the E2E suite can assert on (a hidden window has no reliable WebGL),
 * and the shape a screen reader can read. It therefore has to carry the same
 * information as the rooms: which task groups are in progress, who is working,
 * what the progress screen says, and who last woke whom.
 */

export interface RoomBoardProps {
  rooms: WorkRoom[];
}

export function RoomBoard({ rooms }: RoomBoardProps): React.JSX.Element {
  return (
    <div className="imb-ws-board">
      {rooms.map((room) => (
        <RoomCard key={room.chatId} room={room} />
      ))}
    </div>
  );
}

function RoomCard({ room }: { room: WorkRoom }): React.JSX.Element {
  const working = room.members.filter((member) => member.running).length;
  const bubbles = new Map(
    room.bubbles.map((bubble) => [bubble.employeeId, bubble] as const),
  );
  // Same rendering as a thread bubble: Markdown with `@id` mentions resolved.
  const { resolveMention } = useMentionResolver(room.chatId, false);

  return (
    <article className="imb-ws-card" data-room={room.chatId}>
      <header className="imb-ws-card-head">
        <button
          type="button"
          className="imb-ws-card-title"
          onClick={() => {
            void appStore.openChatById(room.chatId);
          }}
        >
          {room.title}
        </button>
        <span className="imb-ws-card-state">
          {working > 0
            ? t("${count} working").replace("${count}", String(working))
            : t("Idle")}
        </span>
      </header>

      <div className="imb-ws-card-roster">
        {room.members.map((member) => {
          const bubble = bubbles.get(member.employeeId);
          return (
            <div
              key={member.employeeId}
              className={cls(
                "imb-ws-card-person",
                member.running && "imb-is-working",
              )}
            >
              <EmployeeAvatar employeeId={member.employeeId} size={22} />
              <span className="imb-ws-card-name">{member.name}</span>
              <span className="imb-ws-card-task">
                {bubble !== undefined ? (
                  <Markdown
                    content={bubble.content}
                    inline
                    resolveMention={resolveMention}
                  />
                ) : member.running ? (
                  t("Working…")
                ) : (
                  ""
                )}
              </span>
            </div>
          );
        })}
      </div>

      {room.progress !== null ? (
        <ProgressCard
          title={room.progress.title}
          steps={room.progress.steps}
          groupChatId={room.chatId}
          showHalt={false}
          showTime={false}
        />
      ) : (
        <div className="imb-ws-card-empty">{t("No progress yet")}</div>
      )}
    </article>
  );
}
