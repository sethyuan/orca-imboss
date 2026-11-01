export type ThemeMode = "light" | "dark" | "system";

/** State pushed/returned by the theme IPC (`theme:get` / `theme:set`). */
export interface ThemeState {
  mode: ThemeMode;
  /** 6-digit hex accent color, e.g. `#07C160`. */
  color: string;
}

/**
 * Which skills folder an entry came from: the app's own
 * (`~/.imboss/agent/skills`) or the shared, read-only one
 * (`~/.agents/skills`). The app's own folder wins when both have the same name.
 */
export type InstalledSkillSource = "imboss" | "agents";

/**
 * An installed skill under `~/.imboss/agent/skills/<name>/SKILL.md` or
 * `~/.agents/skills/<name>/SKILL.md`.
 */
export interface InstalledSkill {
  name: string;
  /** Parsed from SKILL.md frontmatter when available. */
  description: string | null;
  /** Folder the entry was found in (see `InstalledSkillSource`). */
  source: InstalledSkillSource;
}
