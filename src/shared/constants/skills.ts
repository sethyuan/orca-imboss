/**
 * Master switch for importing skills from a URL or an archive.
 *
 * The feature has three parts, all gated by this constant:
 * - the download / unpack / staging pipeline (`src/main/skill-import.ts`,
 *   `src/main/zip.ts`);
 * - the `skills:inspect*` / `skills:commitInstall` IPC and the preload API;
 * - the "Import from URL" button and the review dialog in Settings › Skills.
 *
 * With it off, importing a local folder still works exactly as before; set it
 * to `false` and the extra entry point and the review dialog disappear.
 */
export const SKILL_IMPORT_ENABLED = true;

/**
 * What the boss is shown before a downloaded skill is written to disk. Kept in
 * one place so the dialog and the pipeline agree on the limit.
 */
export const SKILL_ARCHIVE_MAX_BYTES = 40 * 1024 * 1024;
