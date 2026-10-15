import { t } from "@shared/l10n";
import type {
  BackupInfo,
  BackupStatus,
  PendingRestore,
} from "@shared/types";
import { useCallback, useEffect, useState } from "react";
import { cls } from "reactutils";
import { useApp } from "../../../../app-store";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { Modal } from "../../../modal";
import { Toggle } from "../../../toggle";
import "./index.css";

/**
 * Settings → Backup: write the whole local dataset to a single file, and
 * restore one. A restore replaces every file under the data folder, so it is
 * staged here and swapped in at the next launch — the UI never mutates data
 * out from under the running app.
 */
export function SettingsBackup(): React.JSX.Element {
  const { locale } = useApp();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [busy, setBusy] = useState<"export" | "restore" | "cancel" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<BackupInfo | null>(null);
  const [candidate, setCandidate] = useState<BackupInfo | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await imb.backup.status());
    } catch {
      // The section still works without the status line; a later action
      // surfaces any real failure.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runExport = async (): Promise<void> => {
    setError(null);
    setBusy("export");
    try {
      const info = await imb.backup.export({ includeCredentials });
      if (info !== null) setExported(info);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const pickArchive = async (): Promise<void> => {
    setError(null);
    setBusy("restore");
    try {
      const info = await imb.backup.inspect();
      if (info !== null) setCandidate(info);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const confirmRestore = async (): Promise<void> => {
    if (candidate === null) return;
    setError(null);
    setBusy("restore");
    try {
      await imb.backup.restore(candidate.path);
      setCandidate(null);
      // The app exits here; if it does not, the error below explains why.
      await imb.backup.restart();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const cancelRestore = async (): Promise<void> => {
    setError(null);
    setBusy("cancel");
    try {
      await imb.backup.cancelRestore();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const pending = status?.pending ?? null;
  const kept = status?.keptDataDirs ?? [];

  return (
    <>
      <DetailHead
        eyebrow="Backup"
        title={t("Backup")}
        sub={t("Export and restore all local data")}
      />
      <DetailBody>
        <p className="imb-backup-intro">
          {t(
            "A backup carries your conversations, employees, skills, avatars, attachments and Mini Apps in one file, so you can move the app to another machine or roll back to an earlier state.",
          )}
        </p>

        {pending !== null && (
          <PendingCard
            pending={pending}
            busy={busy === "cancel"}
            onRestart={() => void imb.backup.restart()}
            onCancel={() => void cancelRestore()}
          />
        )}

        <section className="imb-backup-card">
          <h3>{t("Export")}</h3>
          <p className="imb-backup-text">
            {t(
              "Everything is written to a single file you choose. The database is copied live, so the app keeps working while it is exported.",
            )}
          </p>
          <div className="imb-backup-credential-row">
            <Toggle
              checked={includeCredentials}
              onChange={setIncludeCredentials}
              disabled={busy !== null}
              label={t("Include API keys and integration credentials")}
            />
            <div className="imb-backup-credential-copy">
              <span>{t("Include API keys and integration credentials")}</span>
              <span className="imb-backup-hint">
                {t(
                  "Adds agent/auth.json, agent/models.json and integrations.json. The file then contains secrets in plain text — only keep it somewhere you trust.",
                )}
              </span>
            </div>
          </div>
          <div className="imb-backup-actions">
            <Button
              onClick={() => void runExport()}
              loading={busy === "export"}
              disabled={busy !== null && busy !== "export"}
            >
              {t("Export backup…")}
            </Button>
          </div>
          {exported !== null && (
            <p className="imb-backup-result">
              {t("Exported ${files} files (${size}) to ${path}.", {
                files: String(exported.manifest.files),
                size: formatBytes(exported.sizeBytes),
                path: exported.path,
              })}
            </p>
          )}
        </section>

        <section className="imb-backup-card">
          <h3>{t("Restore")}</h3>
          <p className="imb-backup-text">
            {t(
              "Restoring replaces every conversation, employee and file with the contents of the backup. The app restarts to finish, and the data it replaced is kept aside so nothing is lost.",
            )}
          </p>
          <div className="imb-backup-actions">
            <Button
              variant="secondary"
              onClick={() => void pickArchive()}
              loading={busy === "restore"}
              disabled={busy !== null && busy !== "restore"}
            >
              {t("Restore from backup…")}
            </Button>
          </div>
          {kept.length > 0 && (
            <p className="imb-backup-note">
              {t("Data replaced by an earlier restore is kept at ${path}.", {
                path: kept[0],
              })}
            </p>
          )}
        </section>

        {error !== null && <p className="imb-backup-error">{error}</p>}
      </DetailBody>

      <Modal
        open={candidate !== null}
        onClose={() => {
          if (busy === null) setCandidate(null);
        }}
        title={t("Restore this backup?")}
        sub={t("All current data will be replaced, then the app restarts.")}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={busy === "restore"}
              onClick={() => setCandidate(null)}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy === "restore"}
              onClick={() => void confirmRestore()}
            >
              {t("Restore and restart")}
            </Button>
          </>
        }
      >
        {candidate !== null && (
          <ManifestSummary
            info={candidate}
            locale={locale}
          />
        )}
      </Modal>
    </>
  );
}

function PendingCard({
  pending,
  busy,
  onRestart,
  onCancel,
}: {
  pending: PendingRestore;
  busy: boolean;
  onRestart: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <section className="imb-backup-card imb-is-pending">
      <h3>{t("A restore is waiting for a restart")}</h3>
      <p className="imb-backup-text">
        {t(
          "The backup from ${file} is unpacked and will replace all current data the next time imboss starts.",
          { file: pending.source },
        )}
      </p>
      {pending.error !== undefined && (
        <p className="imb-backup-error">
          {t("The last attempt failed: ${message}", {
            message: pending.error,
          })}
        </p>
      )}
      <div className="imb-backup-actions">
        <Button size="sm" onClick={onRestart} disabled={busy}>
          {t("Restart now")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onCancel}
          loading={busy}
        >
          {t("Discard restore")}
        </Button>
      </div>
    </section>
  );
}

function ManifestSummary({
  info,
  locale,
}: {
  info: BackupInfo;
  locale: string;
}): React.JSX.Element {
  const { manifest } = info;
  const counts = manifest.counts;
  return (
    <div className="imb-backup-summary">
      <SummaryRow
        label={t("Created")}
        value={new Date(manifest.createdAt).toLocaleString(locale)}
      />
      <SummaryRow label={t("App version")} value={manifest.appVersion} />
      <SummaryRow
        label={t("Contents")}
        value={[
          t("${count} chats", { count: String(counts.chats) }),
          t("${count} messages", { count: String(counts.messages) }),
          t("${count} employees", { count: String(counts.employees) }),
          t("${count} skills", { count: String(counts.skills) }),
          t("${count} Mini Apps", { count: String(counts.miniApps) }),
        ].join(" · ")}
      />
      <SummaryRow
        label={t("Files")}
        value={`${manifest.files} (${formatBytes(info.sizeBytes)})`}
      />
      <SummaryRow
        label={t("Credentials")}
        value={
          manifest.includeCredentials
            ? t("Included — this file contains secrets")
            : t("Not included")
        }
      />
      <SummaryRow label={t("Source")} value={info.path} mono />
    </div>
  );
}

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="imb-backup-summary-row">
      <span className="imb-backup-summary-label">{label}</span>
      <span className={cls("imb-backup-summary-value", mono && "imb-is-mono")}>
        {value}
      </span>
    </div>
  );
}

/** Human-readable size for the export result and the confirmation dialog. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Electron wraps a failed `ipcMain.handle` as
 * "Error invoking remote method 'backup:export': Error: <message>" — keep the
 * message the user can act on.
 */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}
