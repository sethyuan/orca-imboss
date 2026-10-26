import { t } from "@shared/l10n";
import { useEffect, useRef, useState } from "react";
import { cls } from "reactutils";
import { appStore, useApp } from "../../../../app-store";
import { BrandLogo } from "../../../brand-logo";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { Modal } from "../../../modal";
import "./index.css";

export function SettingsAbout(): React.JSX.Element {
  const { updater, remote } = useApp();
  const [version, setVersion] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  // Ensures the restart prompt is shown once per mount/state transition, not on
  // every render while the update sits downloaded.
  const restartPromptedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void imb.getVersion().then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Prompt to restart as soon as a download completes. Re-arms when the state
  // leaves `downloaded` (e.g. a later re-check) so a fresh download prompts
  // again.
  useEffect(() => {
    if (updater.status === "downloaded") {
      if (!restartPromptedRef.current) {
        restartPromptedRef.current = true;
        setRestartOpen(true);
      }
    } else {
      restartPromptedRef.current = false;
    }
  }, [updater.status]);

  const busy =
    updater.status === "checking" || updater.status === "downloading";
  const canDownload = updater.status === "available";
  const showNew =
    updater.status === "available" ||
    updater.status === "downloading" ||
    updater.status === "downloaded";

  function startDownload(): void {
    if (!canDownload) return;
    void appStore.downloadUpdate();
  }

  async function checkNow(): Promise<void> {
    if (busy) return;
    const result = await appStore.checkForUpdates();
    if (result.status === "available") {
      setConfirmOpen(true);
    }
  }

  function renderUpdateStatus(): React.JSX.Element | null {
    if (updater.status === "downloading") {
      const percent = Math.max(
        0,
        Math.min(100, Math.round(updater.progress?.percent ?? 0)),
      );
      return (
        <div className="imb-update-progress">
          <div className="imb-update-progress-head">
            <span>{t("Downloading update…")}</span>
            <span className="imb-update-percent">{percent}%</span>
          </div>
          <div
            className="imb-progress-track"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="imb-progress-fill"
              style={{ width: `${percent}%` }}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void appStore.cancelDownload()}
          >
            {t("Cancel download")}
          </Button>
        </div>
      );
    }
    if (updater.status === "downloaded") {
      return (
        <div className="imb-update-actions">
          <Button onClick={() => void appStore.installUpdate()}>
            {t("Restart and update")}
          </Button>
        </div>
      );
    }
    if (updater.status === "available") {
      return (
        <div className="imb-update-actions">
          <Button onClick={startDownload}>{t("Download update")}</Button>
        </div>
      );
    }
    if (updater.status === "not-available") {
      const time =
        updater.checkedAt === null
          ? null
          : new Date(updater.checkedAt).toLocaleTimeString();
      return (
        <p className="imb-update-status">
          {t("You're up to date.")}
          {time !== null && ` ${t("Last checked at ${time}", { time })}`}
        </p>
      );
    }
    if (updater.status === "error") {
      return (
        <p className="imb-error-text imb-update-status">
          {updater.error ?? t("Update check failed.")}
        </p>
      );
    }
    return null;
  }

  return (
    <>
      <DetailHead eyebrow="About" title="imboss" sub={t("Version info")} />
      <DetailBody>
        {remote.enabled ? (
          <p className="imb-about-note">
            {t(
              "Running against a remote backend: conversations, agents, cron and integrations live on the server, and files are fetched on demand. Mini Apps need a web server on this machine, so they are hidden in remote mode.",
            )}
          </p>
        ) : null}
        <div className="imb-about-brand">
          <BrandLogo className="imb-about-logo" />
          <span className="imb-about-name">imboss</span>
        </div>
        <div className="imb-about-kv">
          <div className="imb-kv">
            <span className="imb-k">{t("App name")}</span>
            <span className="imb-v">imboss</span>
          </div>
          {remote.enabled ? (
            <div className="imb-kv">
              <span className="imb-k">{t("Backend")}</span>
              <span className="imb-v">
                {remote.incompatibility === null
                  ? t("Remote (compatible)")
                  : t("Remote (API v${shell} ≠ v${backend})", {
                      shell: String(remote.incompatibility.shell),
                      backend: String(remote.incompatibility.backend),
                    })}
              </span>
            </div>
          ) : null}
          <div className="imb-kv">
            <span className="imb-k">{t("Version")}</span>
            <span className="imb-v imb-about-version-cell">
              <button
                type="button"
                className={cls(
                  "imb-about-version",
                  canDownload && "imb-is-clickable",
                )}
                onClick={startDownload}
                disabled={!canDownload}
                title={canDownload ? t("Download and update") : undefined}
              >
                {version ? `v${version}` : "…"}
              </button>
              {showNew && (
                <button
                  type="button"
                  className="imb-about-new"
                  onClick={startDownload}
                  disabled={!canDownload}
                >
                  {t("New")}
                </button>
              )}
            </span>
          </div>
        </div>

        <div className="imb-about-update">
          <Button
            variant="secondary"
            style={{ fontSize: "var(--imb-text-sm)" }}
            onClick={() => void checkNow()}
            loading={updater.status === "checking"}
            disabled={busy}
          >
            {t("Check for updates")}
          </Button>
          {renderUpdateStatus()}
        </div>
      </DetailBody>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("Update available")}
        sub={t("A new version v${version} is available.", {
          version: updater.version ?? "",
        })}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                startDownload();
              }}
            >
              {t("Download and update")}
            </Button>
          </>
        }
      >
        <p>{t("Download and install the new version now?")}</p>
      </Modal>

      <Modal
        open={restartOpen}
        onClose={() => setRestartOpen(false)}
        title={t("Update downloaded")}
        sub={t("Restart to apply the update.")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRestartOpen(false)}>
              {t("Later")}
            </Button>
            <Button onClick={() => void appStore.installUpdate()}>
              {t("Restart and update")}
            </Button>
          </>
        }
      >
        <p>
          {t("The update has been downloaded. Restart imboss now to apply it?")}
        </p>
      </Modal>
    </>
  );
}
