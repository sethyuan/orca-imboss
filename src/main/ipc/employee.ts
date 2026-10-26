import { ASSISTANT_ID } from "@shared/constants/employees";
import { EMPLOYEE_EXPORT_EXTENSION } from "@shared/constants/employee_transfer";
import { t } from "@shared/l10n";
import type { Employee, EmployeeInput } from "@shared/types";
import { isAbsolute, join } from "path";
import { disposeForEmployee } from "../agent/session-queue";
import { deleteAvatarFiles, saveAvatar } from "../avatars";
import * as cron from "../cron";
import * as dbEmployees from "../db/employees";
import { listByEmployee, unlinkSessionFile } from "../db/sessions";
import {
  defaultEmployeeExportFileName,
  exportEmployeeToFile,
} from "../employee-transfer/export";
import {
  applyEmployeeImport,
  cancelEmployeeImport,
  inspectEmployeeExport,
} from "../employee-transfer/import";
import {
  notifyEmployeesChanged,
  reconcileEmployeeRefsOnRead,
} from "../employee-events";
import { getAppInfo } from "../platform";
import { showOpenDialog, showSaveDialog } from "./dialog";
import { assertInteger, assertString, parsePageQuery } from "./helpers";
import type { Binder } from "../rpc/types";

export function registerEmployeeHandlers(bind: Binder): void {
  // Both list handlers first run one throttled capability-reference self-heal
  // pass: MCP servers / skills / providers can be removed without going through
  // the app (the assistant edits `mcp.json` and `rm -rf`s skill folders by
  // design), so the moment the UI reads the collection is the moment the stored
  // references can be checked against the truth on disk. It only writes when
  // something is actually dangling, is idempotent, and never throws.
  bind("employees:list", () => {
    reconcileEmployeeRefsOnRead();
    return dbEmployees.listEmployees();
  });

  bind("employees:listPage", (_ctx, page: unknown) => {
    reconcileEmployeeRefsOnRead();
    return dbEmployees.listEmployeesPage(parsePageQuery(page));
  });

  bind("employees:create", (_ctx, input: EmployeeInput): Employee => {
    const employee = dbEmployees.createEmployee(input);
    notifyEmployeesChanged([employee.id]);
    return employee;
  });

  bind("employees:update", (_ctx, id: unknown, input: EmployeeInput) => {
    const safeId = assertInteger(id, "employee id");
    const employee = dbEmployees.updateEmployee(safeId, input);
    if (employee) notifyEmployeesChanged([safeId]);
    return employee;
  });

  bind("employees:delete", async (_ctx, id: unknown) => {
    const safeId = assertInteger(id, "employee id");
    // Capture disk session file paths BEFORE the FK cascade wipes the rows.
    const records = listByEmployee(safeId);
    // Tear down any warm agent sessions for this employee first.
    await disposeForEmployee(safeId);
    const result = dbEmployees.deleteEmployee(safeId);
    // Only a hard delete removes disk artifacts; a soft delete (employee still
    // a chat participant) keeps the session/avatar state intact.
    if (result === "deleted") {
      // The `cron_jobs.employee_id` FK cascade removed the rows, but the live
      // in-process Cron handles must be stopped explicitly.
      cron.stopJobsForEmployee(safeId);
      await Promise.all(records.map((r) => unlinkSessionFile(r.session)));
      deleteAvatarFiles(safeId);
    }
    notifyEmployeesChanged([safeId]);
    return result;
  });

  bind(
    "employees:updateAvatar",
    (_ctx, id: unknown, ext: unknown, data: unknown) => {
      const safeId = assertInteger(id, "employee id");
      const safeExt = assertString(ext, "ext");
      if (!(data instanceof Uint8Array)) {
        throw new Error("Avatar data must be bytes.");
      }
      const path = saveAvatar(safeId, safeExt, Buffer.from(data));
      const employee = dbEmployees.updateEmployeeAvatar(safeId, path);
      if (employee) notifyEmployeesChanged([safeId]);
      return employee;
    },
  );

  // --- export / import (one employee per zip) ----------------------------

  // `destination` is passed by the remote shell (local save dialog + download);
  // local mode omits it and gets the native dialog here.
  bind(
    "employees:export",
    async (_ctx, id: unknown, destinationPath?: unknown) => {
      const safeId = assertInteger(id, "employee id");
      // Defence in depth: the renderer never offers this for the assistant, and
      // main refuses it too (id 0 can only ever come back as a copy).
      if (safeId === ASSISTANT_ID) {
        throw new Error(t("The built-in assistant cannot be exported."));
      }
      const employee = dbEmployees.getEmployee(safeId);
      if (!employee) throw new Error(t("Employee not found."));
      if (destinationPath !== undefined) {
        const path = assertString(destinationPath, "export path");
        if (!isAbsolute(path)) {
          throw new Error("The export path must be absolute.");
        }
        return exportEmployeeToFile(employee, path);
      }
      const destination = await showSaveDialog({
        title: t("Export employee"),
        defaultPath: join(
          getAppInfo().getDownloadsPath(),
          defaultEmployeeExportFileName(employee),
        ),
        filters: [
          {
            name: t("imboss employee export"),
            extensions: [EMPLOYEE_EXPORT_EXTENSION],
          },
          { name: t("All files"), extensions: ["*"] },
        ],
      });
      if (destination === null) return null;
      return exportEmployeeToFile(employee, destination);
    },
  );

  // Same split as `employees:export`: the remote shell uploads the archive first
  // and passes its backend path; local mode opens the dialog.
  bind("employees:importInspect", async (_ctx, archivePath?: unknown) => {
    if (archivePath !== undefined) {
      const path = assertString(archivePath, "import path");
      if (!isAbsolute(path)) {
        throw new Error("The import path must be absolute.");
      }
      return inspectEmployeeExport(path);
    }
    const paths = await showOpenDialog({
      title: t("Import employee"),
      properties: ["openFile"],
      filters: [
        {
          name: t("imboss employee export"),
          extensions: [EMPLOYEE_EXPORT_EXTENSION],
        },
        { name: t("All files"), extensions: ["*"] },
      ],
    });
    if (paths === null) return null;
    return inspectEmployeeExport(paths[0]);
  });

  bind("employees:importApply", (_ctx, token: unknown, options: unknown) => {
    const safeToken = assertString(token, "import token");
    const overwrite =
      typeof options === "object" &&
      options !== null &&
      (options as Record<string, unknown>)["overwrite"] === true;
    return applyEmployeeImport(safeToken, { overwrite });
  });

  bind("employees:importCancel", (_ctx, token: unknown) => {
    cancelEmployeeImport(assertString(token, "import token"));
  });
}
