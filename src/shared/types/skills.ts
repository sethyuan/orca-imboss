/**
 * One file inside a skill that is waiting to be reviewed. `kind` is a coarse
 * hint for the review dialog: a skill is usually Markdown, and anything that
 * looks executable is worth a second look before it is installed.
 */
export interface SkillFileInfo {
  /** Path relative to the skill folder, `/`-separated. */
  path: string;
  size: number;
  kind: "text" | "script" | "other";
}

/**
 * A skill that has been fetched/unpacked but not written anywhere yet. The
 * dialog shows this; only `skills:commitInstall` turns it into an installed
 * skill under `~/.imboss/agent/skills/<name>/`.
 */
export interface SkillPreview {
  /** Handle for `commit`/`discard`; staging lives in main-process memory. */
  id: string;
  name: string;
  description: string | null;
  /** Where it came from, for display: a URL, an archive path, a folder. */
  source: string;
  files: SkillFileInfo[];
  totalBytes: number;
  /** Relative paths of files that look executable. */
  scripts: string[];
  /** A skill with this name is already installed and would be replaced. */
  replaces: boolean;
  /** Non-null when this one cannot be installed (invalid or duplicate name). */
  problem: string | null;
}
