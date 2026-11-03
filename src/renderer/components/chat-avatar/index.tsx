import { ASSISTANT_ID } from "@shared/constants/employees";
import { EmployeeAvatar } from "../employee-avatar";
import { GroupAvatar } from "../group-avatar";

export interface ChatAvatarProps {
  /** Participants of the conversation (`Chat.participants`). */
  participants: readonly number[];
  /** `null` = a root conversation (the boss's own chat with the assistant). */
  fromChatId: number | null;
  /** The employee of an employee direct chat, or `null`/absent for any other. */
  directEmployeeId?: number | null;
  size?: number;
  /** Tooltip of a composite group avatar (ignored by single-avatar kinds). */
  title?: string;
  className?: string;
}

/**
 * The avatar of one **conversation**, in the single place that decides it:
 *
 * - an **employee direct chat** (`chats.direct_employee_id`) → that employee;
 * - a **root chat** (`fromChatId === null`) → the assistant (id 0): the assistant
 *   is the other side of the boss's own conversations, and its bundled image is
 *   what identifies them (a letter taken from the title was the old, misleading
 *   fallback);
 * - a **task group chat** → the composite group avatar, unchanged — it still
 *   ignores the assistant and shows the member employees.
 *
 * Sized/rounded exactly like the plain `Avatar`/`EmployeeAvatar` it replaces, so
 * a caller only passes its own `size`/`className`.
 */
export function ChatAvatar({
  participants,
  fromChatId,
  directEmployeeId = null,
  size = 30,
  title,
  className,
}: ChatAvatarProps): React.JSX.Element {
  if (directEmployeeId !== null) {
    return (
      <EmployeeAvatar
        employeeId={directEmployeeId}
        size={size}
        className={className}
      />
    );
  }
  if (fromChatId === null) {
    return (
      <EmployeeAvatar
        employeeId={ASSISTANT_ID}
        size={size}
        className={className}
      />
    );
  }
  return (
    <GroupAvatar
      participants={participants}
      size={size}
      title={title}
      className={className}
    />
  );
}
