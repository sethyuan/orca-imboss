import { t } from "@shared/l10n";
import { useEffect, useState } from "react";
import { Button } from "../../../button";
import { Modal } from "../../../modal";
import { Textarea } from "../../../textarea";

/**
 * Editor for an employee's long-term memory — the free-form note injected into
 * the employee's session prompt so it recalls facts across sessions.
 */
export function EmployeeMemoryModal({
  open,
  employeeId,
  employeeName,
  onClose,
  onSaved,
}: {
  open: boolean;
  employeeId: number;
  employeeName: string;
  onClose: () => void;
  onSaved: (text: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void imb.employees
      .getMemory(employeeId)
      .then((value) => {
        if (alive) setText(value);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, employeeId]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const stored = await imb.employees.setMemory(employeeId, text);
      onSaved(stored);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t("Memory")}
      sub={t("What ${name} remembers across sessions.", { name: employeeName })}
      error={error}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || loading}
          >
            {saving ? t("Saving…") : t("Confirm")}
          </Button>
        </>
      }
    >
      <div className="imb-memory-editor">
        <Textarea
          value={text}
          minHeight={220}
          maxHeight={460}
          placeholder={t(
            "e.g. The boss prefers concise Chinese reports. The weather task runs every morning.",
          )}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="imb-module-note">
          {t(
            "Written in Markdown and injected into this employee's session prompt. Clear the field to forget everything.",
          )}
        </p>
      </div>
    </Modal>
  );
}
