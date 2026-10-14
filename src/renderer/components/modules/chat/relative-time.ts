/**
 * Relative chat timestamp formatting (prototype list times):
 * today → "HH:mm"; yesterday → 昨天/“Yesterday”; within a week → 周X / Tue;
 * else yyyy/M/d.
 */

import { replaceMentions } from "../../markdown/mention";
import { toPlainText } from "../../markdown/plain-text";

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayDiff(a: Date, b: Date): number {
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((startB - startA) / 86_400_000);
}

export function formatChatTime(
  secs: number | null | undefined,
  locale: string,
): string {
  if (secs == null) return "";
  const date = new Date(secs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (sameDay(date, now)) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(date, yesterday)) {
    return locale === "zh-CN" ? "昨天" : "Yesterday";
  }
  const diff = dayDiff(date, now);
  if (diff < 7 && diff >= 0) {
    const names = locale === "zh-CN" ? WEEKDAYS_ZH : WEEKDAYS_EN;
    return names[date.getDay()];
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** Full timestamp for message rows (locale-aware, no relative logic). */
export function formatMessageTime(secs: number, locale: string): string {
  const date = new Date(secs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (locale === "zh-CN") {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

/** Truncate a long preview for the chat list (fixed max width, CSS ellipsis). */
export function previewText(
  content: string,
  max = 80,
  resolveMention?: (id: number) => string | null,
): string {
  // Messages are Markdown; show a plain-text teaser so formatting markers and
  // math source do not leak into the list.
  const plain = toPlainText(content).replace(/\s+/g, " ").trim();
  // The preview is plain text: mentions become names without theme color.
  const collapsed = resolveMention
    ? replaceMentions(plain, resolveMention)
    : plain;
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Compact duration label, e.g. `42s`, `7m`, `1h20m`. */
export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}
