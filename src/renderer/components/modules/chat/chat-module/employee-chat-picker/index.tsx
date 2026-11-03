import { t } from "@shared/l10n";
import { useCallback, useEffect, useRef, useState } from "react";
import { appStore, useApp } from "../../../../../app-store";
import { EmployeeAvatar } from "../../../../employee-avatar";
import { Select, type SelectOption } from "../../../../select";
import { Tooltip } from "../../../../tooltip";
import "./index.css";

/**
 * "Start a chat with an employee" — the caret button beside the list's New Chat
 * button.
 *
 * Picking an employee immediately creates and opens an **employee direct chat**,
 * through exactly the same path the employee detail page's "New Chat" uses
 * (`appStore.openDirectChat`): create → reload the list → select it in the Chat
 * module → put the caret in its composer. There is no second "go" step and no
 * persistent selection: the trigger shows no value at all, so it can never look
 * like "this is the conversation I am in".
 *
 * The trigger is icon-only (a 14px upward caret in a 30px hit area), so it has
 * no text to state an action or a reason: both come from the tooltip and the
 * accessible name — "chat with employee" normally, and the reason when the
 * picker is unavailable ("no employees to chat with"). It is never silently
 * disabled.
 *
 * The list is a `Select` (the app's one combobox: portaled shared menu surface,
 * keyboard + Escape + popup layer) with its searchable panel: the filter matches
 * the **name** (option label) and the **role** (option note), case-insensitive.
 */
export function EmployeeChatPicker(): React.JSX.Element {
  const { data } = useApp();
  /** Creation in flight; the picker is unclickable until it settles. */
  const [busy, setBusy] = useState(false);
  /** Failure of the last attempt (a deleted/disabled employee, an IPC error). */
  const [error, setError] = useState<string | null>(null);
  /** Synchronous mirror of `busy` (guards two picks in one frame). */
  const busyRef = useRef(false);

  // The employee collection is lazily loaded per module; the picker is often the
  // first thing on screen that needs it.
  useEffect(() => {
    appStore.ensureEmployees();
  }, []);

  // Only real, active, chattable employees: the assistant already has the New
  // Chat button (it is the boss's own conversation), and `employees:list`
  // already drops disabled/deleted ones.
  const employees = data.employees.items.filter(
    (employee) => employee.id !== 0,
  );
  const options: SelectOption[] = employees.map((employee) => ({
    value: String(employee.id),
    label: employee.name.trim() || t("Unnamed"),
    // The role doubles as the panel's gloss and as the filter's second field.
    ...(employee.role.trim().length > 0 ? { note: employee.role.trim() } : {}),
  }));

  const start = useCallback(async (value: string): Promise<void> => {
    if (busyRef.current) return;
    const employeeId = Number(value);
    if (!Number.isSafeInteger(employeeId) || employeeId <= 0) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Create + jump: the same store path the employee detail page uses.
      await appStore.openDirectChat(employeeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // The collection loads lazily: before it has, the picker must not claim
  // "nobody to chat with" (that message is for a team that really has none).
  const loading = !data.employees.loaded;
  const empty = !loading && employees.length === 0;
  const reason = empty
    ? t("No employees to chat with")
    : loading
      ? t("Loading…")
      : t("Chat with employee");

  return (
    <>
      {/* The tooltip is the only place the action (or the reason it is
          unavailable) is written down: the trigger itself is just a caret. It
          wraps the trigger instead of sitting on the button, because a disabled
          button dispatches no mouse events — the wrapper still does. */}
      <Tooltip content={reason} placement="right">
        <span className="imb-employee-picker-trigger">
          <Select
            // Never a value: picking is an action, not a selection (see above).
            value=""
            options={options}
            onChange={(value) => void start(value)}
            // `label` is the icon-only trigger's whole accessible name.
            label={reason}
            disabled={loading || empty || busy}
            variant="icon"
            searchable
            searchPlaceholder={t("Search employees")}
            emptyMessage={
              empty ? t("No employees to chat with") : t("No employees found")
            }
            // Avatar + name + role need more room than this trigger has.
            panelMinWidth={260}
            renderOption={(option) => (
              // The option value is the employee id (see `options` above).
              <span className="imb-employee-picker-option">
                <EmployeeAvatar employeeId={Number(option.value)} size={20} />
                <span className="imb-employee-picker-name">{option.label}</span>
                {option.note !== undefined && (
                  <span className="imb-employee-picker-role">
                    {option.note}
                  </span>
                )}
              </span>
            )}
          />
        </span>
      </Tooltip>
      {error !== null && (
        // A failure must be visible, not only announced: it takes its own line
        // under the footer row (the trigger has no room for text).
        <p className="imb-error-text imb-employee-picker-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
