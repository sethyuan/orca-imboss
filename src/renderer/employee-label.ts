/**
 * One convention for showing an employee everywhere: the **name** (falling back
 * to role, then `#id`) as the primary label, with the `#id` shown as a small
 * secondary badge wherever there is room. Mentions are the one exception and
 * keep the explicit `@工号 名称` form.
 */

export interface LabeledEmployee {
  readonly id: number;
  readonly name?: string;
  readonly role?: string;
}

/** Primary display label: name → role → `#id`. */
export function employeeLabel(
  employee: LabeledEmployee | null | undefined,
  fallbackId?: number,
): string {
  const name = employee?.name?.trim();
  if (name) return name;
  const role = employee?.role?.trim();
  if (role) return role;
  const id = employee?.id ?? fallbackId;
  return id !== undefined ? `#${id}` : "";
}

/** The `#id` badge text for an employee id. */
export function employeeBadge(id: number): string {
  return `#${id}`;
}

/**
 * Resolve a model-authored step/assignee name to a canonical label + badge.
 * Accepts a bare id (`12` / `#12`), an exact name, an exact role, or an explicit
 * `employeeId`; anything unresolved is shown verbatim with no badge.
 */
export function resolveEmployeeLabel(
  raw: string,
  employees: readonly LabeledEmployee[],
  employeeId?: number,
): { label: string; badge: string | null } {
  const text = (raw ?? "").trim();
  let employee: LabeledEmployee | undefined;

  if (employeeId !== undefined) {
    employee = employees.find((e) => e.id === employeeId);
  }
  const numeric = /^#?(\d+)$/.exec(text);
  if (!employee && numeric) {
    employee = employees.find((e) => e.id === parseInt(numeric[1], 10));
  }
  if (!employee) {
    employee = employees.find(
      (e) =>
        (e.name && e.name.trim() === text) ||
        (e.role && e.role.trim() === text),
    );
  }

  if (employee) {
    return { label: employeeLabel(employee), badge: employeeBadge(employee.id) };
  }
  return {
    label: text,
    badge: employeeId !== undefined ? employeeBadge(employeeId) : null,
  };
}
