import { ASSISTANT_ID } from "@shared/constants/employees";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@shared/constants/paged";
import {
  isThinkingLevel,
  type ThinkingLevel,
} from "@shared/constants/thinking";
import type {
  Employee,
  EmployeeDeleteResult,
  EmployeeInput,
  EmployeeRow,
  EmployeeUpsertInput,
  PageQuery,
  PageResult,
  PurgedEmployee,
} from "@shared/types";
import { avatarVersion } from "../avatars";
import { getDB } from "./index";
import { parseNumberArray, parseStringArray, stringifyArray } from "./json";
import { escapeLike } from "./text-search";

const MAX_BATCH_SIZE = 50;

export function listEmployees(): Employee[] {
  return (
    getDB()
      .prepare(
        "SELECT * FROM employees WHERE disabled = 0 AND remote_agent_id IS NULL AND remote_caller_id IS NULL ORDER BY id ASC",
      )
      .all() as EmployeeRow[]
  ).map(toEmployee);
}

/**
 * One page of employees, ordered `id ASC`. Regular employees (id ≠ 0) are
 * fetched via keyset search on `name OR role` (LIKE, ESCAPE-safe); the
 * built-in assistant (id 0) is excluded from that query and instead pinned as
 * the first row of page 1 (no cursor) whenever it matches the needle — so it
 * shows at the very top of the list and is omitted on pages 2+.
 */
export function listEmployeesPage(page: PageQuery = {}): PageResult<Employee> {
  const limit = Math.min(
    Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const needle = (page.query ?? "").trim();
  const db = getDB();
  const conditions: string[] = [
    "id <> ?",
    "disabled = 0",
    "remote_agent_id IS NULL",
    "remote_caller_id IS NULL",
  ];
  const params: Array<string | number> = [ASSISTANT_ID];

  if (page.cursor) {
    const cursorId = Number(page.cursor);
    if (Number.isSafeInteger(cursorId) && cursorId > 0) {
      conditions.push("id > ?");
      params.push(cursorId);
    }
  }
  if (needle.length > 0) {
    const pattern = `%${escapeLike(needle)}%`;
    conditions.push("(name LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  const rows = db
    .prepare(
      `SELECT * FROM employees
       WHERE ${conditions.join(" AND ")}
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as EmployeeRow[];

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toEmployee);
  const last = items[items.length - 1];

  // Pin the built-in assistant at the top of page 1 (only when the search term
  // matches it). hasMore/nextCursor still derive from the regular rows.
  let pagedItems = items;
  if (!page.cursor) {
    const assistant = getAssistant();
    if (assistant && matchesNeedle(assistant, needle)) {
      pagedItems = [assistant, ...items];
    }
  }

  return {
    items: pagedItems,
    nextCursor: hasMore && last ? String(last.id) : null,
    hasMore,
  };
}

export function getEmployee(id: number): Employee | null {
  const row = getDB()
    .prepare("SELECT * FROM employees WHERE id = ?")
    .get(id) as EmployeeRow | undefined;
  return row ? toEmployee(row) : null;
}

export function getAssistant(): Employee | null {
  return getEmployee(ASSISTANT_ID);
}

export function createEmployee(input: EmployeeInput): Employee {
  const result = getDB()
    .prepare(
      "INSERT INTO employees (name, role, system_prompt, mcp, skills, model_id, thinking_level) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      validateName(input.name) ?? "",
      validateRole(input.role) ?? "",
      validatePrompt(input.systemPrompt) ?? "",
      stringifyArray(validateRefList(input.mcp, "mcp") ?? []),
      stringifyArray(validateRefList(input.skills, "skills") ?? []),
      validateModelId(input.modelId),
      validateThinkingLevel(input.thinkingLevel),
    );
  const created = getEmployee(Number(result.lastInsertRowid));
  if (!created) throw new Error("Failed to create employee.");
  return created;
}

export function updateEmployee(
  id: number,
  input: EmployeeInput,
): Employee | null {
  const current = getEmployee(id);
  if (!current) return null;

  if (id === ASSISTANT_ID) {
    // The assistant's profile is restricted: name, systemPrompt (appended to
    // ASSISTANT_SYSTEM_PROMPT), skills, modelId and thinkingLevel are editable;
    // role and mcp are immutable and defensively rejected if provided. Skills
    // are user-selectable so the assistant can be taught additional work
    // methods beyond its code-shipped built-in skills.
    const immutable: Array<keyof EmployeeInput> = ["role", "mcp"];
    if (immutable.some((key) => input[key] !== undefined)) {
      throw new Error(
        "The built-in assistant's role and MCP cannot be modified.",
      );
    }
    const skills =
      input.skills !== undefined
        ? (validateRefList(input.skills, "skills") ?? [])
        : current.skills;
    getDB()
      .prepare(
        "UPDATE employees SET name = ?, system_prompt = ?, skills = ?, model_id = ?, thinking_level = ? WHERE id = ?",
      )
      .run(
        input.name !== undefined ? validateName(input.name) : current.name,
        input.systemPrompt !== undefined
          ? validatePrompt(input.systemPrompt)
          : current.systemPrompt,
        stringifyArray(skills),
        input.modelId !== undefined
          ? validateModelId(input.modelId)
          : current.modelId,
        input.thinkingLevel !== undefined
          ? validateThinkingLevel(input.thinkingLevel)
          : current.thinkingLevel,
        id,
      );
    return getEmployee(id);
  }

  // Merge patch over current values; helpers validate only changed fields.
  const mcp =
    input.mcp !== undefined ? validateRefList(input.mcp, "mcp") : current.mcp;
  const skills =
    input.skills !== undefined
      ? validateRefList(input.skills, "skills")
      : current.skills;

  getDB()
    .prepare(
      "UPDATE employees SET name = ?, role = ?, system_prompt = ?, mcp = ?, skills = ?, model_id = ?, thinking_level = ? WHERE id = ?",
    )
    .run(
      input.name !== undefined ? validateName(input.name) : current.name,
      input.role !== undefined ? validateRole(input.role) : current.role,
      input.systemPrompt !== undefined
        ? validatePrompt(input.systemPrompt)
        : current.systemPrompt,
      stringifyArray(mcp ?? []),
      stringifyArray(skills ?? []),
      input.modelId !== undefined
        ? validateModelId(input.modelId)
        : current.modelId,
      input.thinkingLevel !== undefined
        ? validateThinkingLevel(input.thinkingLevel)
        : current.thinkingLevel,
      id,
    );
  return getEmployee(id);
}

/**
 * Create and/or update multiple employees in one atomic transaction.
 *
 * Each item: omit `id` to create, pass `id` to update. Returns the ordered
 * list of resulting employee ids (created or updated). A thrown error (bad
 * field or unknown id) rolls back the whole batch — no partial writes. Reuses
 * the single-item validators/helpers.
 *
 * The built-in assistant (id 0) is editable here too: an id-0 item routes to
 * `updateEmployee`, which enforces the assistant whitelist (name, systemPrompt,
 * skills, modelId, thinkingLevel; `role`/`mcp` immutable). This is how the
 * assistant edits its own profile through `imb_set_employees`.
 */
export function upsertEmployees(items: EmployeeUpsertInput[]): number[] {
  if (items.length === 0) throw new Error("At least one employee is required.");
  if (items.length > MAX_BATCH_SIZE) {
    throw new Error(`Too many employees in one batch (max ${MAX_BATCH_SIZE}).`);
  }
  const db = getDB();
  const ids: number[] = [];
  db.transaction(() => {
    for (const item of items) {
      if (item.id !== undefined) {
        const updated = updateEmployee(item.id, item);
        if (!updated) throw new Error(`Employee ${item.id} not found.`);
        ids.push(updated.id);
      } else {
        ids.push(createEmployee(item).id);
      }
    }
  })();
  return ids;
}

/**
 * Update the stored avatar file path (owner: avatar IPC handler). The
 * assistant's avatar is mutable, unlike its row-level persistence guards.
 */
export function updateEmployeeAvatar(
  id: number,
  avatarPath: string | null,
): Employee | null {
  getDB()
    .prepare("UPDATE employees SET avatar = ? WHERE id = ?")
    .run(avatarPath, id);
  return getEmployee(id);
}

/**
 * Delete a non-reserved employee.
 *
 * - **In chat** → the employee is a participant of at least one chat, so it is
 *   *disabled* (soft-delete) instead of removed: it stays in every
 *   `chats.participants` array, the sessions FK remains intact, and the
 *   employee disappears from active lists. Returns `"disabled"`.
 * - **Not in chat** → hard delete; the id is stripped from any chat's
 *   participants (defensive, should be none) and the sessions FK cascades.
 *   Returns `"deleted"`.
 * - **Missing** → `null`.
 *
 * Disk session-file cleanup is coordinated above this service (see IPC wiring).
 */
export function deleteEmployee(id: number): EmployeeDeleteResult {
  if (id === ASSISTANT_ID) {
    throw new Error("The built-in assistant cannot be deleted.");
  }
  const db = getDB();
  if (!getEmployee(id)) return null;

  if (isEmployeeInAnyChat(id)) {
    db.prepare("UPDATE employees SET disabled = 1 WHERE id = ?").run(id);
    return "disabled";
  }

  const removed = db.transaction(() => {
    stripFromAllChats(db, id);
    return db.prepare("DELETE FROM employees WHERE id = ?").run(id).changes > 0;
  })();
  return removed ? "deleted" : null;
}

/**
 * Hard-delete every employee that is `disabled = 1` AND no longer a participant
 * of any chat. Returns the purged employees plus their recorded session file
 * paths so the caller can unlink session files and avatar files (the `sessions`
 * rows themselves are removed by the FK cascade). Best-effort at startup.
 */
export function purgeDisabledEmployees(): PurgedEmployee[] {
  const db = getDB();
  const disabled = db
    .prepare(
      "SELECT id FROM employees WHERE disabled = 1 AND remote_agent_id IS NULL AND remote_caller_id IS NULL",
    )
    .all() as Array<{ id: number }>;
  const purged: PurgedEmployee[] = [];

  for (const { id } of disabled) {
    if (isEmployeeInAnyChat(id)) continue; // still a chat participant → keep
    const sessionPaths = (
      db
        .prepare("SELECT session FROM sessions WHERE employee_id = ?")
        .all(id) as Array<{ session: string }>
    ).map((row) => row.session);
    db.transaction(() => {
      stripFromAllChats(db, id);
      db.prepare("DELETE FROM employees WHERE id = ?").run(id);
    })();
    purged.push({ employeeId: id, sessionPaths });
  }
  return purged;
}

function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    name: row.name ?? "",
    role: row.role ?? "",
    systemPrompt: row.system_prompt ?? "",
    mcp: parseStringArray(row.mcp),
    skills: parseStringArray(row.skills),
    modelId: row.model_id,
    thinkingLevel: isThinkingLevel(row.thinking_level)
      ? row.thinking_level
      : null,
    avatar: row.avatar,
    avatarVersion: avatarVersion(row.avatar),
    disabled: row.disabled === 1,
  };
}

/** Case-insensitive name/role match used to decide whether the assistant is pinned. */
function matchesNeedle(employee: Employee, needle: string): boolean {
  const lower = needle.toLowerCase();
  return (
    employee.name.toLowerCase().includes(lower) ||
    employee.role.toLowerCase().includes(lower)
  );
}

function validateName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (name.length > 200) throw new Error("Name is too long.");
  return name;
}

function validateRole(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  if (role.length > 200) throw new Error("Role is too long.");
  return role;
}

function validatePrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  if (prompt.length > 100_000) throw new Error("System prompt is too long.");
  return prompt;
}

/**
 * Validate an MCP/skill reference list defensively: strings only, sane length
 * caps, deduplicated preserving first-seen order. Names used for filesystem
 * operations are validated more strictly where those operations happen.
 */
function validateRefList(
  values: string[] | undefined,
  field: "mcp" | "skills",
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  if (values.length > 256) throw new Error(`Too many ${field} entries.`);
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error(`${field} entries must be strings.`);
    }
    if (value.length === 0 || value.length > 256) {
      throw new Error(`${field} entry has invalid length.`);
    }
  }
  return [...new Set(values)];
}

/** Validate `model_id` — either NULL/empty or valid model identifier form. */
function validateModelId(modelId: string | null | undefined): string | null {
  if (modelId == null || modelId === "") return null;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new Error("Invalid model id length.");
  }
  const valid = /^[A-Za-z0-9._/@:-]+$/.test(trimmed);
  if (!valid) {
    throw new Error(
      'Model id must look like "provider/model" or a valid model identifier.',
    );
  }
  return trimmed;
}

/**
 * Validate `thinking_level` — either NULL/empty (follow the global default)
 * or one of the app's thinking levels. Anything else (corrupt row, untyped
 * tool input) falls back to null instead of throwing, matching the lenient
 * parsing used elsewhere in this layer.
 */
function validateThinkingLevel(
  level: ThinkingLevel | null | undefined,
): ThinkingLevel | null {
  if (level == null || !isThinkingLevel(level)) return null;
  return level;
}

/** True when the employee id appears in at least one chat's participants array. */
function isEmployeeInAnyChat(id: number): boolean {
  const rows = getDB()
    .prepare("SELECT participants FROM chats")
    .all() as Array<{ participants: string }>;
  return rows.some((row) => parseNumberArray(row.participants).includes(id));
}

/** Strip an employee id from every chat's participants array. */
function stripFromAllChats(db: ReturnType<typeof getDB>, id: number): void {
  // Desktop scale: scan all chats and filter exactly rather than guessing
  // with LIKE patterns that can mis-candidate overlapping digits.
  const rows = db.prepare("SELECT id, participants FROM chats").all() as Array<{
    id: number;
    participants: string;
  }>;
  for (const chat of rows) {
    const participants = parseNumberArray(chat.participants);
    if (participants.includes(id)) {
      db.prepare("UPDATE chats SET participants = ? WHERE id = ?").run(
        stringifyArray(participants.filter((pid) => pid !== id)),
        chat.id,
      );
    }
  }
}

/** `id`/`name`/`role` of one employee (spend attribution). */
export interface EmployeeIdentity {
  id: number;
  name: string;
  role: string;
}

/**
 * `id`/`name`/`role` for every employee, including soft-deleted ones: their
 * recorded session files still hold spend, and dropping them would make that
 * usage unattributable.
 */
export function listEmployeeIdentities(): EmployeeIdentity[] {
  return getDB()
    .prepare("SELECT id, name, role FROM employees ORDER BY id ASC")
    .all() as EmployeeIdentity[];
}

