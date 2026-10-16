import { isThinkingLevel } from "@shared/constants/thinking";
import { t } from "@shared/l10n";
import type { Employee, EmployeeInput, ModelOption } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { cls } from "reactutils";
import {
  modelRef,
  thinkingLevelsFor,
  thinkingSelectOptions,
} from "../../../../thinking-options";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { employeeAvatarSrc } from "../../../employee-avatar/avatar-src";
import { Field } from "../../../field";
import { IconCamera } from "../../../icons";
import { Input } from "../../../input";
import { GroupSelect } from "../../../group-select";
import { Modal } from "../../../modal";
import { MultiSelect, type MultiSelectOption } from "../../../multi-select";
import { Select } from "../../../select";
import { Textarea } from "../../../textarea";
import { AvatarCropModal } from "../avatar-crop-modal";
import "./index.css";

export interface EmployeeDetailProps {
  employee: Employee;
  mcpOptions: MultiSelectOption[];
  skillOptions: MultiSelectOption[];
  groupOptions: string[];
  models: ModelOption[];
  /** App default model (`provider/id`), used when this employee follows it. */
  defaultModel: string;
  onPatch: (input: EmployeeInput) => Promise<boolean>;
  onRemove: () => void;
  /** Called when the avatar file is replaced (keeps appStore in sync). */
  onAvatarUpdated?: (employee: Employee) => void;
}

const SAVE_DEBOUNCE_MS = 400;

export function EmployeeDetail({
  employee,
  mcpOptions,
  skillOptions,
  groupOptions,
  models,
  defaultModel,
  onPatch,
  onRemove,
  onAvatarUpdated,
}: EmployeeDetailProps): React.JSX.Element {
  const isAssistant = employee.id === 0;
  // role/mcp never enter the assistant's form so they are never sent on patch;
  // skills are user-selectable for the assistant (built-in skills are always
  // included by the session on top of the selection).
  const [form, setForm] = useState<EmployeeInput>(
    isAssistant
      ? {
          name: employee.name,
          systemPrompt: employee.systemPrompt,
          skills: employee.skills,
          groups: employee.groups,
          modelId: employee.modelId ?? "",
          thinkingLevel: employee.thinkingLevel,
        }
      : {
          name: employee.name,
          role: employee.role,
          systemPrompt: employee.systemPrompt,
          mcp: employee.mcp,
          skills: employee.skills,
          groups: employee.groups,
          modelId: employee.modelId ?? "",
          thinkingLevel: employee.thinkingLevel,
        },
  );
  const [avatar, setAvatar] = useState<string | null>(employee.avatar);
  const [avatarVersion, setAvatarVersion] = useState<number | null>(
    employee.avatarVersion,
  );
  const [avatarAv, setAvatarAv] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback(
    (next: EmployeeInput): void => {
      setForm(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void onPatch(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [onPatch],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onAvatarPicked = (file: File | undefined): void => {
    if (!file) return;
    setCropFile(file);
    setCropOpen(true);
    if (fileRef.current) fileRef.current.value = "";
  };

  const onCropConfirm = async (
    croppedData: Uint8Array,
    ext: string,
  ): Promise<void> => {
    setAvatarAv(true);
    setAvatarError(null);
    try {
      const updated = await imb.employees.updateAvatar(
        employee.id,
        ext,
        croppedData,
      );
      if (updated) {
        setAvatar(updated.avatar);
        setAvatarVersion(updated.avatarVersion);
        onAvatarUpdated?.(updated);
      }
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setAvatarAv(false);
    }
  };

  const triggerPicker = (): void => fileRef.current?.click();

  const displayName = (form.name ?? "").trim() || employee.name || t("Unnamed");
  // The assistant's role is immutable; show the persisted value rather than a
  // (hidden) editable field.
  const displayRole = isAssistant ? employee.role || "" : (form.role ?? "");
  const displayAvatarUrl = employeeAvatarSrc({
    id: employee.id,
    avatar,
    avatarVersion,
  });

  return (
    <>
      <DetailHead
        eyebrow={`Employee #${employee.id}`}
        title={displayName}
        sub={displayRole || "—"}
        actions={
          isAssistant ? undefined : (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setRemoveOpen(true)}
            >
              {t("Remove")}
            </Button>
          )
        }
      />
      <DetailBody>
        <div className="imb-detail-avatar-row">
          <div
            className="imb-detail-avatar-wrap"
            role="button"
            tabIndex={0}
            aria-label={t("Change avatar")}
            onClick={triggerPicker}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                triggerPicker();
              }
            }}
          >
            {displayAvatarUrl ? (
              <img
                className="imb-detail-avatar-img"
                src={displayAvatarUrl}
                alt={displayName}
              />
            ) : (
              <div className="imb-detail-avatar-placeholder">
                {displayName.slice(0, 1).toUpperCase() || "?"}
              </div>
            )}
            <div className="imb-detail-avatar-overlay">
              <IconCamera />
            </div>
          </div>
          <div className="imb-detail-avatar-info">
            <h2>{displayName}</h2>
            <div className="imb-sub">{displayRole || "—"}</div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            disabled={avatarAv}
            onChange={(e) => void onAvatarPicked(e.target.files?.[0])}
          />
        </div>
        {avatarError !== null && (
          <p className="imb-error-text imb-employee-avatar-error">
            {avatarError}
          </p>
        )}

        <div
          className={cls(
            "imb-field-row",
            isAssistant && "imb-field-row--single",
          )}
        >
          <Field label={t("Name")} htmlFor={`emp-name-${employee.id}`}>
            <Input
              id={`emp-name-${employee.id}`}
              value={form.name ?? ""}
              placeholder={t("Unnamed")}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              onValueCommit={(name) => scheduleSave({ ...form, name })}
            />
          </Field>
          {!isAssistant && (
            <Field label={t("Role")} htmlFor={`emp-role-${employee.id}`}>
              <Input
                id={`emp-role-${employee.id}`}
                value={form.role ?? ""}
                placeholder={t("e.g. Researcher")}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                onValueCommit={(role) => scheduleSave({ ...form, role })}
              />
            </Field>
          )}
        </div>

        <Field
          label={t("System prompt")}
          htmlFor={`emp-prompt-${employee.id}`}
          hint={
            isAssistant
              ? t(
                  "This prompt is appended to the assistant's built-in system prompt.",
                )
              : undefined
          }
        >
          <Textarea
            id={`emp-prompt-${employee.id}`}
            value={form.systemPrompt ?? ""}
            placeholder={t(
              "Define this employee's responsibilities and output standards…",
            )}
            minHeight={250}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            onValueCommit={(systemPrompt) =>
              scheduleSave({ ...form, systemPrompt })
            }
          />
        </Field>

        <Field label={t("Groups")}>
          <GroupSelect
            value={form.groups ?? []}
            options={groupOptions}
            allowCreate
            placeholder={t("Select or enter groups")}
            onChange={(groups) => scheduleSave({ ...form, groups })}
          />
        </Field>

        {!isAssistant && (
          <Field label={t("Linked MCP")}>
            <MultiSelect
              value={form.mcp ?? []}
              options={mcpOptions}
              placeholder={t("Select MCP")}
              emptyHint={t("No MCP configured")}
              onChange={(mcp) => scheduleSave({ ...form, mcp })}
            />
          </Field>
        )}

        <Field label={t("Skill set")}>
          <MultiSelect
            value={form.skills ?? []}
            options={skillOptions}
            placeholder={t("Select skills")}
            emptyHint={t("No skills installed")}
            onChange={(skills) => scheduleSave({ ...form, skills })}
          />
        </Field>

        <Field label={t("Model")} htmlFor={`emp-model-${employee.id}`}>
          <Select
            id={`emp-model-${employee.id}`}
            value={form.modelId ?? ""}
            options={[
              { value: "", label: t("Default") },
              ...models.map((model) => ({
                value: modelRef(model),
                label: modelRef(model),
              })),
            ]}
            placeholder={t("Default")}
            onChange={(modelId) =>
              scheduleSave({ ...form, modelId: modelId || null })
            }
          />
        </Field>

        <Field
          label={t("Thinking level")}
          htmlFor={`emp-thinking-${employee.id}`}
          hint={t(
            "Unset follows the default thinking level. Only levels this model accepts are listed.",
          )}
        >
          <Select
            id={`emp-thinking-${employee.id}`}
            value={form.thinkingLevel ?? ""}
            options={[
              { value: "", label: t("Default") },
              ...thinkingSelectOptions(
                thinkingLevelsFor(models, form.modelId ?? "", defaultModel),
                form.thinkingLevel ?? "",
              ),
            ]}
            onChange={(level) =>
              scheduleSave({
                ...form,
                thinkingLevel: isThinkingLevel(level) ? level : null,
              })
            }
          />
        </Field>
      </DetailBody>

      {!isAssistant && (
        <Modal
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title={t("Delete employee")}
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
                {t("Delete")}
              </Button>
            </>
          }
        >
          <p className="imb-employee-delete-note">
            {t(
              "The employee's conversation records will also be cleared. This cannot be undone.",
            )}
          </p>
        </Modal>
      )}

      <AvatarCropModal
        open={cropOpen}
        imageFile={cropFile}
        onClose={() => {
          setCropOpen(false);
          setCropFile(null);
        }}
        onConfirm={onCropConfirm}
      />
    </>
  );
}
