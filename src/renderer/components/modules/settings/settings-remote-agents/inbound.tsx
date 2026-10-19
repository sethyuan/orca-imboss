import { t } from "@shared/l10n";
import type { RemoteCaller, RemoteInboundConfig } from "@shared/types";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../button";
import { EmptyState } from "../../../empty-state";
import { Field } from "../../../field";
import { Input } from "../../../input";
import { Modal } from "../../../modal";
import { Toggle } from "../../../toggle";

/**
 * Settings → Remote agents → "This agent": the inbound half of the A2A bridge.
 *
 * When it is on, other agents can call this imboss over A2A. Each caller gets a
 * bearer token; a caller's request opens a conversation in the chat list, where
 * the boss can watch the exchange and step in.
 */
export function SettingsRemoteInbound(): React.JSX.Element {
  const [config, setConfig] = useState<RemoteInboundConfig | null>(null);
  const [callers, setCallers] = useState<RemoteCaller[]>([]);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const apply = useCallback((next: RemoteInboundConfig): void => {
    setConfig(next);
    setName(next.name);
    setHost(next.host);
    setPort(String(next.port));
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      apply(await imb.remote.inbound.status());
      setCallers(await imb.remote.inbound.callers());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apply]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    config !== null &&
    (name !== config.name ||
      host !== config.host ||
      String(config.port) !== port);

  return (
    <section className="imb-remote-inbound">
      <div className="imb-remote-inbound-head">
        <div>
          <h3 className="imb-remote-section-title">{t("This agent")}</h3>
          <p className="imb-remote-intro">
            {t(
              "Turn this on to let other agents call this imboss over A2A. Each caller needs a token, and their requests open conversations you can follow and join.",
            )}
          </p>
        </div>
        <Toggle
          checked={config?.enabled ?? false}
          disabled={config === null || busy}
          label={t("Accept A2A calls")}
          onChange={(checked) =>
            void run(async () => {
              apply(await imb.remote.inbound.update({ enabled: checked }));
            })
          }
        />
      </div>

      {error && <p className="imb-remote-error">{error}</p>}

      {config === null ? null : (
        <>
          <p className="imb-remote-status-line">
            {config.error
              ? config.error
              : config.running
                ? t("Listening on ${url}", { url: config.url ?? "" })
                : t("Not listening.")}
          </p>

          <div className="imb-remote-grid">
            <Field label={t("Agent name")} hint={t("Advertised to callers.")}>
              <Input
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label={t("Host")}
              hint={t("Use 0.0.0.0 to accept remote calls.")}
            >
              <Input
                value={host}
                mono
                spellCheck={false}
                onChange={(e) => setHost(e.target.value)}
              />
            </Field>
            <Field label={t("Port")}>
              <Input
                value={port}
                mono
                spellCheck={false}
                onChange={(e) => setPort(e.target.value)}
              />
            </Field>
            <div className="imb-remote-grid-action">
              <Button
                variant="secondary"
                loading={busy}
                disabled={!dirty}
                onClick={() =>
                  void run(async () => {
                    const parsed = Number.parseInt(port, 10);
                    apply(
                      await imb.remote.inbound.update({
                        name,
                        host,
                        ...(Number.isSafeInteger(parsed)
                          ? { port: parsed }
                          : {}),
                      }),
                    );
                  })
                }
              >
                {t("Save")}
              </Button>
            </div>
          </div>

          <h3 className="imb-remote-section-title">{t("Callers")}</h3>
          <div className="imb-remote-actions">
            <Button onClick={() => setAddOpen(true)}>{t("Add caller")}</Button>
          </div>

          {callers.length === 0 ? (
            <EmptyState>{t("No callers yet.")}</EmptyState>
          ) : (
            callers.map((caller) => (
              <section key={caller.id} className="imb-remote-card">
                <div className="imb-remote-head">
                  <div className="imb-remote-title">
                    <span className="imb-remote-name">{caller.name}</span>
                    <span className="imb-remote-status">
                      {t("${count} conversations", {
                        count: String(caller.chatCount),
                      })}
                    </span>
                  </div>
                  <div className="imb-remote-controls">
                    <Button
                      variant="secondary"
                      onClick={() => void copy(caller.token)}
                    >
                      {t("Copy token")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const updated =
                            await imb.remote.inbound.regenerateToken(caller.id);
                          setCallers((current) =>
                            current.map((item) =>
                              item.id === updated.id ? updated : item,
                            ),
                          );
                          await copy(updated.token);
                        })
                      }
                    >
                      {t("Regenerate")}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await imb.remote.inbound.removeCaller(caller.id);
                          setCallers((current) =>
                            current.filter((item) => item.id !== caller.id),
                          );
                        })
                      }
                    >
                      {t("Remove")}
                    </Button>
                  </div>
                </div>
                <p className="imb-remote-token">{caller.token}</p>
              </section>
            ))
          )}
        </>
      )}

      <AddCallerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(caller) => {
          setCallers((current) => [...current, caller]);
          void copy(caller.token);
        }}
      />
    </section>
  );
}

/** Best-effort clipboard write: a denied permission must not break the UI. */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Ignore: the token stays visible on screen for a manual copy.
  }
}

interface AddCallerModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: (caller: RemoteCaller) => void;
}

function AddCallerModal({
  open,
  onClose,
  onAdded,
}: AddCallerModalProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onAdded(await imb.remote.inbound.addCaller(name.trim()));
      setName("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) {
          setName("");
          onClose();
        }
      }}
      title={t("Add caller")}
      sub={t("A token is generated and shown once — copy it to the caller.")}
      error={error ?? undefined}
      actions={
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setName("");
              onClose();
            }}
          >
            {t("Cancel")}
          </Button>
          <Button
            loading={busy}
            disabled={name.trim().length === 0}
            onClick={() => void submit()}
          >
            {t("Add")}
          </Button>
        </>
      }
    >
      <Field
        label={t("Caller name")}
        hint={t(
          "A label for the agent that will call you, e.g. Acme Research.",
        )}
      >
        <Input
          value={name}
          data-autofocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
