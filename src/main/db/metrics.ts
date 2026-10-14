import { getDB } from "./index";

/**
 * Read-only aggregate metrics per employee, used by the employees dashboard
 * (recent activity, message/report counts). Pure SQL aggregation, no writes.
 */

export interface EmployeeMessageMetrics {
  employeeId: number;
  /** Non-ack messages authored by this employee. */
  messages: number;
  /** `report`-kind messages (completed deliverables). */
  reports: number;
  /** Latest non-ack message content, or null. */
  lastText: string | null;
  /** Latest non-ack message epoch seconds, or null. */
  lastAt: number | null;
}

export function listEmployeeMessageMetrics(): EmployeeMessageMetrics[] {
  const rows = getDB()
    .prepare(
      `SELECT m.sender_employee_id AS eid,
              COUNT(*) AS messages,
              SUM(CASE WHEN m.kind = 'report' THEN 1 ELSE 0 END) AS reports,
              (SELECT content FROM messages
                 WHERE sender_employee_id = m.sender_employee_id AND kind <> 'ack'
                 ORDER BY id DESC LIMIT 1) AS last_text,
              (SELECT created_at FROM messages
                 WHERE sender_employee_id = m.sender_employee_id AND kind <> 'ack'
                 ORDER BY id DESC LIMIT 1) AS last_at
         FROM messages m
        WHERE m.sender_employee_id IS NOT NULL AND m.kind <> 'ack'
        GROUP BY m.sender_employee_id`,
    )
    .all() as Array<{
    eid: number;
    messages: number;
    reports: number;
    last_text: string | null;
    last_at: number | null;
  }>;

  return rows.map((row) => ({
    employeeId: row.eid,
    messages: row.messages,
    reports: row.reports,
    lastText: row.last_text,
    lastAt: row.last_at,
  }));
}
