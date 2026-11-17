import { t } from "@shared/l10n";
import type { WorkRoom } from "@shared/types";
import { appStore } from "../../../app-store";
import { ProgressCard } from "../chat/progress-card";

/**
 * What the focused room's wall screen shows: the group's newest progress card,
 * as real DOM (CSS3D), not a texture.
 *
 * Why DOM: the card is text, and a texture would either be blurry (small texture)
 * or require re-implementing the card's layout in canvas (which would then drift
 * from the one in the thread). DOM keeps it crisp at any zoom and reuses the very
 * component the boss already knows. The cost is one extra renderer and one
 * lifecycle rule — a CSS3D element is a DOM node parented to the room's scene
 * graph, so the stage has to re-mount it when the room is rebuilt (handled in
 * `disposeEntry`/`buildScreen`).
 *
 * The whole screen is the click target, as the boss asked: the progress card is
 * *displayed* here, not operated (its own links/buttons are switched off), and a
 * click anywhere on the glass opens the task group.
 */
export function FocusScreen({ room }: { room: WorkRoom }): React.JSX.Element {
  const openGroup = (): void => {
    void appStore.openChatById(room.chatId);
  };

  return (
    <div
      className="imb-ws-screen-body"
      role="button"
      tabIndex={0}
      aria-label={`${t("Open task group")}: ${room.title}`}
      onClick={openGroup}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openGroup();
      }}
    >
      {/* The card is inert here: one screen, one action. */}
      <div className="imb-ws-screen-content">
        {room.progress !== null ? (
          <ProgressCard
            title={room.progress.title}
            steps={room.progress.steps}
            groupChatId={room.chatId}
            showHalt={false}
            showTime={false}
          />
        ) : (
          <div className="imb-ws-screen-empty">
            <span className="imb-ws-screen-empty-title">{room.title}</span>
            <span>{t("No progress yet")}</span>
          </div>
        )}
      </div>
      <span className="imb-ws-screen-open">{t("Open task group")}</span>
    </div>
  );
}
