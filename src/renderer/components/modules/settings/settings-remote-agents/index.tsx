import { t } from "@shared/l10n";
import type { RemoteAgent } from "@shared/types";
import { useCallback, useEffect, useState } from "react";
import { cls } from "reactutils";
import { appStore } from "../../../../app-store";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { EmptyState } from "../../../empty-state";
import { Field } from "../../../field";
import { Input } from "../../../input";
import { Modal } from "../../../modal";
import { SettingsRemoteInbound } from "./inbound";
import "./index.css";

/**
 * Settings → Remote agents: add and manage A2A peers.
 *
 * A peer is another agent reachable over the A2A protocol — typically another
 * imboss on a different machine. Adding one resolves its agent card and creates
 * a conversation for it; the conversation is where you actually talk to it.
 */
export function SettingsRemoteAgents(): React.JSX.Element {
  const [agents, setAgents] = useState<RemoteAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setAgents(await imb.remote.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(id: number, task: () => Promise<void>): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <DetailHead
        eyebrow="Settings"
        title={t("Remote agents")}
        sub={t("Collaborate with agents on other machines over A2A")}
      />
      <DetailBody>
        <p className="imb-remote-intro">
          {t(
            "Add a peer by its agent card URL. Each peer gets a conversation in the chat list, and everything you send there goes to that agent over the Agent2Agent protocol.",
          )}
        </p>

        {error && <p className="imb-remote-error">{error}</p>}

        <div className="imb-remote-actions">
          <Button onClick={() => setAddOpen(true)}>
            {t("Add remote agent")}
          </Button>
        </div>

        {loading ? null : agents.length === 0 ? (
          <EmptyState>{t("No remote agents yet.")}</EmptyState>
        ) : (
          agents.map((agent) => (
            <section key={agent.id} className="imb-remote-card">
              <div className="imb-remote-head">
                <div className="imb-remote-title">
                  <span className="imb-remote-name">{agent.name}</span>
                  <span
                    className={cls(
                      "imb-remote-status",
                      agent.status === "ok" && "imb-is-ok",
                      agent.status === "error" && "imb-is-error",
                    )}
                  >
                    {agent.status === "ok" ? t("Reachable") : t("Unreachable")}
                  </span>
                </div>
                <div className="imb-remote-controls">
                  <Button
                    variant="secondary"
                    onClick={() => void appStore.focusChat(agent.chatId)}
                  >
                    {t("Open chat")}
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busyId === agent.id}
                    onClick={() =>
                      void run(agent.id, async () => {
                        const updated = await imb.remote.refresh(agent.id);
                        setAgents((current) =>
                          current.map((item) =>
                            item.id === updated.id ? updated : item,
                          ),
                        );
                      })
                    }
                  >
                    {t("Refresh")}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busyId === agent.id}
                    onClick={() =>
                      void run(agent.id, async () => {
                        await imb.remote.remove(agent.id);
                        setAgents((current) =>
                          current.filter((item) => item.id !== agent.id),
                        );
                      })
                    }
                  >
                    {t("Remove")}
                  </Button>
                </div>
              </div>

              <p className="imb-remote-url">{agent.url}</p>
              {agent.description.length > 0 && (
                <p className="imb-remote-desc">{agent.description}</p>
              )}
              {agent.skills.length > 0 && (
                <p className="imb-remote-skills">
                  {agent.skills.map((skill) => (
                    <span key={skill} className="imb-remote-skill">
                      {skill}
                    </span>
                  ))}
                </p>
              )}
              {agent.statusDetail && (
                <p className="imb-remote-error">{agent.statusDetail}</p>
              )}
            </section>
          ))
        )}

        <SettingsRemoteInbound />
      </DetailBody>

      <AddRemoteAgentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(agent) => {
          setAgents((current) => [...current, agent]);
        }}
      />
    </>
  );
}

interface AddRemoteAgentModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: (agent: RemoteAgent) => void;
}

function AddRemoteAgentModal({
  open,
  onClose,
  onAdded,
}: AddRemoteAgentModalProps): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setUrl("");
    setToken("");
    setError(null);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const agent = await imb.remote.add({
        url,
        ...(token.trim().length > 0 ? { token: token.trim() } : {}),
      });
      onAdded(agent);
      reset();
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
          reset();
          onClose();
        }
      }}
      title={t("Add remote agent")}
      sub={t("The agent card is fetched before the peer is stored.")}
      error={error ?? undefined}
      actions={
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              reset();
              onClose();
            }}
          >
            {t("Cancel")}
          </Button>
          <Button
            loading={busy}
            disabled={url.trim().length === 0}
            onClick={() => void submit()}
          >
            {t("Add")}
          </Button>
        </>
      }
    >
      <Field
        label={t("Agent card URL")}
        hint={t(
          "The base URL of the peer; its card is read from /.well-known/agent-card.json.",
        )}
      >
        <Input
          value={url}
          placeholder="https://example.com"
          mono
          spellCheck={false}
          data-autofocus
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field
        label={t("Bearer token")}
        hint={t("Optional. Sent as Authorization: Bearer on every request.")}
      >
        <Input
          value={token}
          type="password"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
