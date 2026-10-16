import { isThinkingLevel } from "@shared/constants/thinking";
import { t } from "@shared/l10n";
import type { Employee, EmployeeInput, ModelOption } from "@shared/types";
import { useState } from "react";
import { Button } from "../../../button";
import { Field } from "../../../field";
import { Input } from "../../../input";
import { Modal } from "../../../modal";
import { MultiSelect, type MultiSelectOption } from "../../../multi-select";
import { Select } from "../../../select";
import { GroupSelect } from "../../../group-select";
import { Textarea } from "../../../textarea";
import {
  modelRef,
  thinkingLevelsFor,
  thinkingSelectOptions,
} from "../../../../thinking-options";

export interface EmployeeRecruitModalProps {
  open: boolean;
  onClose: () => void;
  mcpOptions: MultiSelectOption[];
  skillOptions: MultiSelectOption[];
  groupOptions: string[];
  models: ModelOption[];
  /** App default model (`provider/id`), used when the recruit follows it. */
  defaultModel: string;
  onCreate: (input: EmployeeInput) => Promise<Employee | null>;
}

export function EmployeeRecruitModal({
  open,
  onClose,
  mcpOptions,
  skillOptions,
  groupOptions,
  models,
  defaultModel,
  onCreate,
}: EmployeeRecruitModalProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mcp, setMcp] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setName("");
    setRole("");
    setPrompt("");
    setMcp([]);
    setSkills([]);
    setGroups([]);
    setModelId("");
    setThinkingLevel("");
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate({
        name: name.trim() || undefined,
        role: role.trim() || undefined,
        systemPrompt: prompt,
        mcp,
        skills,
        groups,
        modelId: modelId || null,
        thinkingLevel: isThinkingLevel(thinkingLevel) ? thinkingLevel : null,
      });
      if (created) {
        reset();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) {
          reset();
          onClose();
        }
      }}
      title={t("Recruit")}
      sub={t("Create an employee to handle specific tasks.")}
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
          <Button loading={busy} onClick={() => void submit()}>
            {t("Create")}
          </Button>
        </>
      }
    >
      <Field label={t("Name")}>
        <Input
          value={name}
          placeholder={t("Unnamed")}
          data-autofocus
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t("Role")}>
        <Input
          value={role}
          placeholder={t("e.g. Researcher")}
          onChange={(e) => setRole(e.target.value)}
        />
      </Field>
      <Field label={t("System prompt")}>
        <Textarea
          value={prompt}
          placeholder={t(
            "Define this employee's responsibilities and output standards…",
          )}
          minHeight={120}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      <Field label={t("Groups")}>
        <GroupSelect
          value={groups}
          options={groupOptions}
          allowCreate
          placeholder={t("Select or enter groups")}
          onChange={setGroups}
        />
      </Field>
      <Field label={t("Linked MCP")}>
        <MultiSelect
          value={mcp}
          options={mcpOptions}
          placeholder={t("Select MCP")}
          emptyHint={t("No MCP configured")}
          onChange={setMcp}
        />
      </Field>
      <Field label={t("Skill set")}>
        <MultiSelect
          value={skills}
          options={skillOptions}
          placeholder={t("Select skills")}
          emptyHint={t("No skills installed")}
          onChange={setSkills}
        />
      </Field>
      <Field label={t("Model")}>
        <Select
          value={modelId}
          options={[
            { value: "", label: t("Default") },
            ...models.map((model) => ({
              value: modelRef(model),
              label: modelRef(model),
            })),
          ]}
          onChange={setModelId}
        />
      </Field>
      <Field
        label={t("Thinking level")}
        hint={t(
          "Unset follows the default thinking level. Only levels this model accepts are listed.",
        )}
      >
        <Select
          value={thinkingLevel}
          options={[
            { value: "", label: t("Default") },
            ...thinkingSelectOptions(
              thinkingLevelsFor(models, modelId, defaultModel),
              thinkingLevel,
            ),
          ]}
          onChange={setThinkingLevel}
        />
      </Field>
    </Modal>
  );
}
