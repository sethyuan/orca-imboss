import { t } from "@shared/l10n";
import type { AssetCategory, AssetRef, AssetSummary } from "@shared/types";
import type { SVGProps } from "react";
import {
  IconArchive,
  IconFile,
  IconImage,
  IconMedia,
  IconSheet,
} from "../../../icons";

/** A hand-drawn inline SVG icon component (see `components/icons`). */
export type CategoryIcon = (
  props: SVGProps<SVGSVGElement>,
) => React.JSX.Element;

/** Readonly slice of `Employee` needed to resolve sender names. */
export interface EmployeeLike {
  readonly id: number;
  readonly name: string;
}

/** Readonly slice of `ChatSummary` needed for the chat filter/labels. */
export interface ChatLike {
  readonly id: number;
  readonly title: string;
}

/**
 * Stable identity for a deduplicated asset: its on-disk path when known,
 * otherwise a name/size/type fingerprint (path-less assets cannot be deduped
 * by main either, so this mirrors that grouping closely enough for the UI).
 */
export function assetKey(asset: AssetSummary): string {
  return asset.path ?? `${asset.name}|${asset.size}|${asset.type}`;
}

/** Trusted locator for one occurrence (file ops always go through this). */
export function refOf(asset: AssetSummary): AssetRef {
  return { messageId: asset.messageId, index: asset.index };
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable byte size ("1.2 MB", "840 B"). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${SIZE_UNITS[0]}`;
  const exp = Math.min(
    SIZE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exp;
  const text =
    exp === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1);
  return `${text} ${SIZE_UNITS[exp]}`;
}

const CATEGORY_LABEL_KEYS: Record<AssetCategory, string> = {
  image: "Image",
  document: "Document",
  sheet: "Sheet",
  archive: "Archive",
  media: "Media",
  other: "Other",
};

/** English label key for a category (translated at render time). */
export function categoryLabelKey(category: AssetCategory): string {
  return CATEGORY_LABEL_KEYS[category];
}

/** Icon glyph representing a category. */
export function categoryIcon(category: AssetCategory): CategoryIcon {
  switch (category) {
    case "image":
      return IconImage;
    case "sheet":
      return IconSheet;
    case "archive":
      return IconArchive;
    case "media":
      return IconMedia;
    default:
      return IconFile;
  }
}

/** Lowercased extension (without the dot) of a filename, or "". */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Last path segment (works for both POSIX and Windows separators). */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Full local timestamp for metadata rows ("2026-10-13 09:30"). */
export function formatDateTime(secs: number): string {
  const date = new Date(secs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Display name for a message sender (null = the local user). */
export function senderLabel(
  senderEmployeeId: number | null,
  employees: readonly EmployeeLike[],
): string {
  if (senderEmployeeId === null) return t("User");
  const employee = employees.find((e) => e.id === senderEmployeeId);
  return employee?.name ?? t("Unnamed");
}

/** Display title for a chat (untitled chats fall back to the default). */
export function chatLabel(title: string): string {
  return title.trim().length > 0 ? title : t("New Chat");
}
