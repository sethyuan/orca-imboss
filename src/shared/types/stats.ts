/** One day's accumulated per-employee counters (survives chat deletion). */
export interface StatDaily {
  /** Local date, `yyyy-MM-dd`. */
  day: string;
  employeeId: number;
  /** Agent run time accumulated that day (ms). */
  runMs: number;
  /** Non-ack messages authored that day. */
  messages: number;
  /** Report-kind messages authored that day. */
  reports: number;
}
