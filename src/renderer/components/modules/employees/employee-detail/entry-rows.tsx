import { t } from "@shared/l10n";
import { useEffect, useState } from "react";
import { IconChevronDown, IconMemory } from "../../../icons";
import { EmployeeMemoryModal } from "./memory-modal";

/**
 * The quick entry that sits under an employee's card: what it remembers. Shows
 * a live one-line summary and opens the memory editor.
 */
export function EmployeeEntryRows({
  employeeId,
  employeeName,
}: {
  employeeId: number;
  employeeName: string;
}): React.JSX.Element {
  const [memory, setMemory] = useState<string>("");
  const [memoryOpen, setMemoryOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const memoryText = await imb.employees
        .getMemory(employeeId)
        .catch(() => "");
      if (!alive) return;
      setMemory(memoryText);
    })();
    return () => {
      alive = false;
    };
  }, [employeeId]);

  const memorySummary =
    memory.trim().length === 0
      ? t("Empty")
      : t("${count} characters", { count: String(memory.trim().length) });

  return (
    <>
      <div className="imb-entry-rows">
        <EntryRow
          icon={<IconMemory />}
          label={t("Memory")}
          value={memorySummary}
          onClick={() => setMemoryOpen(true)}
        />
      </div>

      <EmployeeMemoryModal
        open={memoryOpen}
        employeeId={employeeId}
        employeeName={employeeName}
        onClose={() => setMemoryOpen(false)}
        onSaved={(text) => setMemory(text)}
      />
    </>
  );
}

function EntryRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="imb-entry-row" onClick={onClick}>
      <span className="imb-entry-icon">{icon}</span>
      <span className="imb-entry-label">{label}</span>
      <span className="imb-entry-value">{value}</span>
      <IconChevronDown className="imb-icon imb-xs imb-entry-chevron" />
    </button>
  );
}
