import { isThinkingLevel } from "@shared/constants/thinking";
import { t } from "@shared/l10n";
import type { Employee, EmployeeInput, ModelOption } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { cls } from "reactutils";
import {
  defaultModelSelectNote,
  defaultThinkingSelectNote,
  groupedModelSelectOptions,
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
  models: ModelOption[];
  /** App default model (`provider/id`), used when this employee follows it. */
  defaultModel: string;
  /** App default thinking level, inherited when this employee leaves it unset. */
  defaultThinking: string;
  /** Favorite `provider/id`s, oldest first. */
  favoriteModels: readonly string[];
  onToggleFavorite: (ref: string) => void;
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
  models,
  defaultModel,
  defaultThinking,
  favoriteModels,
  onToggleFavorite,
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
          modelId: employee.modelId ?? "",
          thinkingLevel: employee.thinkingLevel,
        }
      : {
          name: employee.name,
          role: employee.role,
          systemPrompt: employee.systemPrompt,
          mcp: employee.mcp,
          skills: employee.skills,
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
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
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

  /** Write this employee (+ its MCP settings and skill folders) to a zip. */
  const runExport = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const result = await imb.employees.exportToFile(employee.id);
      // `null` = the native save dialog was cancelled.
      if (result !== null) {
        setExportNotice(
          t(
            "Exported ${files} files (${size}) to ${path}. Credential values were cleared — fill them in again after importing.",
            {
              files: String(result.files),
              size: formatBytes(result.sizeBytes),
              path: result.path,
            },
          ),
        );
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

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
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={exporting}
                title={t(
                  "Export this employee with its MCP settings and skill folders as a zip. Credential values are cleared.",
                )}
                onClick={() => void runExport()}
              >
                {t("Export")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setRemoveOpen(true)}
              >
                {t("Remove")}
              </Button>
            </>
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
        {exportError !== null && (
          <p className="imb-error-text imb-employee-export-note">
            {exportError}
          </p>
        )}
        {exportNotice !== null && (
          <p className="imb-employee-export-note imb-mono">{exportNotice}</p>
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

        {!isAssistant && (
          <Field label={t("Linked MCP")}>
            <MultiSelect
              value={form.mcp ?? []}
              options={mcpOptions}
              placeholder={t("Select MCP")}
              emptyHint={t("No MCP configured")}
              searchable
              searchPlaceholder={t("Search MCP")}
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
            searchable
            searchPlaceholder={t("Search skills")}
            onChange={(skills) => scheduleSave({ ...form, skills })}
          />
        </Field>

        <Field label={t("Model")}>
          <Select
            value={form.modelId ?? ""}
            options={groupedModelSelectOptions(
              models,
              {
                value: "",
                label: t("Default"),
                note: defaultModelSelectNote(defaultModel, models),
              },
              favoriteModels,
            )}
            onToggleStar={onToggleFavorite}
            placeholder={t("Default")}
            onChange={(modelId) =>
              scheduleSave({ ...form, modelId: modelId || null })
            }
          />
        </Field>

        <Field
          label={t("Thinking level")}
          hint={t(
            "Unset follows the default thinking level. Only levels this model accepts are listed.",
          )}
        >
          <Select
            value={form.thinkingLevel ?? ""}
            options={[
              {
                value: "",
                label: t("Default"),
                note: defaultThinkingSelectNote(
                  defaultThinking,
                  models,
                  form.modelId ?? "",
                  defaultModel,
                ),
              },
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
