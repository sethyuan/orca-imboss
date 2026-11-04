import { t } from "@shared/l10n";
import { useEffect, useRef } from "react";
import { cls } from "reactutils";
import { ChatAvatar } from "../../../../chat-avatar";
import { EmployeeAvatar } from "../../../../employee-avatar";
import { displayTitle } from "../../relative-time";
import "./index.css";

/**
 * One candidate of the composer's reference popups.
 *
 * Both triggers share this shape on purpose: `@` offers employees, `#` offers
 * the task groups this conversation created, and the popup's look, filtering
 * feedback and keyboard contract must not drift between them.
 */
export type RefCandidate =
  | {
      kind: "employee";
      id: number;
      /** Display name; may be empty (then `role` / the id is shown instead). */
      name: string;
      role: string;
    }
  | {
      kind: "taskChat";
      /** Chat id of the referenced task group (drives the avatar only). */
      id: number;
      /**
       * Raw group title. The label and the inserted text both fall back to the
       * app's "New Chat" placeholder for an untitled group, computed at render
       * time so a live language switch applies immediately.
       */
      title: string;
      participants: readonly number[];
      /** The chat that spawned this group; never `null` for a task group. */
      fromChatId: number;
    };

/** Which trigger opened the popup; `null` closes it. */
export type RefTrigger = "@" | "#";

export interface RefPopupProps {
  trigger: RefTrigger | null;
  candidates: readonly RefCandidate[];
  selectedIndex: number;
  onSelect: (candidate: RefCandidate) => void;
  onHoverIndex?: (index: number) => void;
  /**
   * True while the candidates are still being fetched (`#` lists task groups
   * over IPC). Suppresses the "nothing found" message so the popup cannot claim
   * an empty result before it has one.
   */
  loading?: boolean;
}

/** The label a candidate is drawn with (employees may have no name). */
function candidateName(candidate: RefCandidate): string {
  if (candidate.kind === "taskChat") return displayTitle(candidate.title);
  return candidate.name || candidate.role || `#${candidate.id}`;
}

/**
 * The composer's reference popup: the `@`-mention list and the `#` task-group
 * list, rendered by one component so the two triggers keep exactly the same
 * interaction (arrow navigation with a highlighted row, hover highlighting, an
 * empty state, auto-scroll of the selected row).
 */
export function RefPopup({
  trigger,
  candidates,
  selectedIndex,
  onSelect,
  onHoverIndex,
  loading = false,
}: RefPopupProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the selected option into view during keyboard navigation.
  useEffect(() => {
    if (trigger === null || selectedIndex < 0 || !listRef.current) return;
    const selectedEl = listRef.current.children[selectedIndex] as
      HTMLElement | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [trigger, selectedIndex]);

  if (trigger === null) return null;

  if (candidates.length === 0) {
    // Nothing to pick (yet): `#` still lets the boss type the text by hand, and
    // an empty popup that says "no results" while loading would be a lie.
    if (loading) return null;
    return (
      <div className="imb-ref-popup" ref={listRef}>
        <div className="imb-ref-empty">
          {trigger === "@"
            ? t("No employees found")
            : t("No task groups found")}
        </div>
      </div>
    );
  }

  return (
    <div className="imb-ref-popup" ref={listRef} role="listbox">
      {candidates.map((candidate, index) => {
        const isSelected = index === selectedIndex;
        const name = candidateName(candidate);

        return (
          <button
            key={`${candidate.kind}:${candidate.id}`}
            type="button"
            className={cls("imb-ref-item", isSelected && "imb-is-selected")}
            role="option"
            aria-selected={isSelected}
            data-ref-kind={candidate.kind}
            onClick={() => onSelect(candidate)}
            onMouseEnter={() => onHoverIndex?.(index)}
          >
            <div className="imb-ref-avatar">
              {candidate.kind === "employee" ? (
                <EmployeeAvatar employeeId={candidate.id} size={28} />
              ) : (
                <ChatAvatar
                  participants={candidate.participants}
                  fromChatId={candidate.fromChatId}
                  size={28}
                />
              )}
            </div>
            <div className="imb-ref-info">
              <span className="imb-ref-name">{name}</span>
              {/* `#` rows need no second line: the group avatar and the title
                  already say everything the popup can. */}
              {candidate.kind === "employee" &&
              candidate.role.length > 0 &&
              candidate.role !== name ? (
                <span className="imb-ref-detail">{candidate.role}</span>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}
