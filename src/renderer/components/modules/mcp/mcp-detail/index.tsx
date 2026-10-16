import { t } from "@shared/l10n";
import type { McpServer, McpServerInput } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { Field } from "../../../field";
import { Input } from "../../../input";
import { Modal } from "../../../modal";
import { Textarea } from "../../../textarea";
import {
  configToForm,
  formToConfig,
  McpConfigFields,
  type McpConfigFormValue,
} from "../mcp-config-fields";

export interface McpDetailProps {
  server: McpServer;
  onPatch: (input: McpServerInput) => Promise<void>;
  onRemove: () => void;
}

const SAVE_DEBOUNCE_MS = 400;

export function McpDetail({
  server,
  onPatch,
  onRemove,
}: McpDetailProps): React.JSX.Element {
  const [description, setDescription] = useState(server.description);
  const [configForm, setConfigForm] = useState<McpConfigFormValue>(() =>
    configToForm(server.config),
  );
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    (next: { description: string; form: McpConfigFormValue }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void onPatch({
          // `mcp.json` keys servers by name, so the name is immutable here.
          name: server.name,
          description: next.description,
          config: formToConfig(next.form),
        }).catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
      }, SAVE_DEBOUNCE_MS);
    },
    [onPatch, server.name],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const updateDescription = (value: string): void => {
    setDescription(value);
    save({ description: value, form: configForm });
  };
  const updateConfig = (form: McpConfigFormValue): void => {
    setConfigForm(form);
    save({ description, form });
  };

  return (
    <>
      <DetailHead
        eyebrow="MCP Server"
        title={server.name}
        sub={description.split("\n")[0] || "—"}
        actions={
          <Button
            variant="danger"
            size="sm"
            onClick={() => setRemoveOpen(true)}
          >
            {t("Remove")}
          </Button>
        }
      />
      <DetailBody>
        <Field
          label={t("MCP name")}
          hint={t("Server names are set when created and cannot be changed.")}
          htmlFor="mcp-detail-name"
        >
          <Input id="mcp-detail-name" value={server.name} readOnly />
        </Field>
        <Field label={t("Description")} htmlFor="mcp-detail-description">
          <Textarea
            id="mcp-detail-description"
            value={description}
            minHeight={72}
            onChange={(e) => updateDescription(e.target.value)}
          />
        </Field>
        <McpConfigFields
          idPrefix="mcp-detail"
          value={configForm}
          onChange={updateConfig}
        />
        {error !== null && <p className="imb-error-text">{error}</p>}
      </DetailBody>

      <Modal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={t("Delete MCP")}
        sub={t('Are you sure you want to delete "${name}"?', {
          name: server.name,
        })}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoveOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setRemoveOpen(false);
                onRemove();
              }}
            >
              {t("Remove")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t("Linked employees must choose again after removing.")}
        </p>
      </Modal>
    </>
  );
}
