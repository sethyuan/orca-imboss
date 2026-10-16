import { t } from "@shared/l10n";
import type { SkillPreview } from "@shared/types";
import { useState } from "react";
import { cls } from "reactutils";
import { Button } from "../../../../button";
import { Field } from "../../../../field";
import { Input } from "../../../../input";
import { Modal } from "../../../../modal";
import "./index.css";

/**
 * Settings › Skills — import a skill from a link or a `.zip`, and look at what
 * arrived before it is installed.
 *
 * The main process holds the unpacked skill in memory until
 * `skills:commitInstall`, so cancelling here leaves nothing on disk. Mounted
 * only while open, so every visit starts on the link step.
 */
export function SkillImport({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  /** Re-read the installed list after a successful install. */
  onInstalled: () => void | Promise<void>;
}): React.JSX.Element {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<SkillPreview[] | null>(null);

  const installable = (previews ?? []).filter(
    (preview) => preview.problem === null && preview.id.length > 0,
  );
  const reviewing = previews !== null;

  async function inspect(
    run: () => Promise<SkillPreview[] | null>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const found = await run();
      if (found === null) return; // the file picker was cancelled
      if (found.length === 0) {
        setError(t("Nothing to install."));
        return;
      }
      setPreviews(found);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (installable.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await imb.skills.commitInstall(installable.map((preview) => preview.id));
      await onInstalled();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  function cancel(): void {
    const ids = (previews ?? [])
      .map((preview) => preview.id)
      .filter((id) => id.length > 0);
    if (ids.length > 0) void imb.skills.discardInstall(ids);
    onClose();
  }

  return (
    <Modal
      open
      onClose={cancel}
      title={reviewing ? t("Review skills") : t("Import a skill")}
      error={error}
      size={reviewing ? "lg" : "md"}
      actions={
        reviewing ? (
          <>
            <Button variant="secondary" loading={busy} onClick={cancel}>
              {t("Cancel")}
            </Button>
            <Button
              loading={busy}
              disabled={installable.length === 0}
              onClick={() => void confirm()}
            >
              {t("Install")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" loading={busy} onClick={cancel}>
              {t("Cancel")}
            </Button>
            <Button
              loading={busy}
              disabled={link.trim().length === 0}
              onClick={() => void inspect(() => imb.skills.inspectUrl(link))}
            >
              {t("Fetch")}
            </Button>
          </>
        )
      }
    >
      {reviewing ? (
        <ReviewList previews={previews ?? []} />
      ) : (
        <>
          <Field
            label={t("Link")}
            hint={t(
              "A .zip archive, a SKILL.md, or a GitHub repository or folder.",
            )}
          >
            <Input
              autoFocus
              mono
              value={link}
              placeholder="https://github.com/owner/repo"
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && link.trim().length > 0) {
                  void inspect(() => imb.skills.inspectUrl(link));
                }
              }}
            />
          </Field>
          <div className="imb-skill-import-archive">
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => void inspect(() => imb.skills.inspectArchive())}
            >
              {t("Choose a .zip file…")}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The files each skill brings, and anything worth a second look. */
function ReviewList({
  previews,
}: {
  previews: SkillPreview[];
}): React.JSX.Element {
  return (
    <div className="imb-skill-review">
      <p className="imb-module-note">
        {t("Review what arrived before it is installed.")}
      </p>
      {previews.map((preview) => (
        <div key={preview.id || preview.name} className="imb-skill-review-card">
          <div className="imb-skill-review-head">
            <span className="imb-skill-review-name">{preview.name}</span>
            <span className="imb-skill-review-meta">
              {`${preview.files.length} · ${formatBytes(preview.totalBytes)}`}
            </span>
          </div>
          {preview.description !== null && (
            <p className="imb-skill-review-desc">{preview.description}</p>
          )}
          {preview.problem !== null && (
            <p className="imb-skill-review-warn">{preview.problem}</p>
          )}
          {preview.problem === null && preview.replaces && (
            <p className="imb-skill-review-warn">
              {t("Already installed; installing replaces it.")}
            </p>
          )}
          {preview.scripts.length > 0 && (
            <p className="imb-skill-review-warn">
              {`${t("Contains scripts")}: ${preview.scripts.join(", ")}`}
            </p>
          )}
          <ul className="imb-skill-review-files">
            {preview.files.map((file) => (
              <li
                key={file.path}
                className={cls(
                  "imb-skill-review-file",
                  file.kind === "script" && "imb-skill-review-script",
                )}
              >
                <span className="imb-skill-review-path">{file.path}</span>
                <span className="imb-skill-review-size">
                  {formatBytes(file.size)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Electron wraps a failed `ipcMain.handle` as
 * "Error invoking remote method 'skills:inspectUrl': Error: <message>" — keep
 * the message the user can act on.
 */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}
