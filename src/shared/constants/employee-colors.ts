/**
 * Deterministic accent palette for employees. Each employee gets a stable
 * colour derived from their id, so the same person always reads the same hue
 * across group chats, lists and details. Hues are mid-saturation so they stay
 * legible on both the light and dark surfaces.
 */
export const EMPLOYEE_COLORS = [
  "#2f6fed", // blue
  "#e8740c", // orange
  "#12a150", // green
  "#c026d3", // magenta
  "#0891b2", // cyan
  "#d9236b", // rose
  "#7c5cff", // violet
  "#a16207", // amber
  "#0d9488", // teal
  "#db2777", // pink
  "#4d7c0f", // olive
  "#5b6b7c", // slate
] as const;

/** Stable accent colour for an employee id. */
export function employeeColor(id: number): string {
  const index = Math.abs(Math.trunc(id)) % EMPLOYEE_COLORS.length;
  return EMPLOYEE_COLORS[index];
}
