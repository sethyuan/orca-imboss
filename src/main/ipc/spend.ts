import { isSpendRange } from "@shared/constants/spend";
import type { SpendReport } from "@shared/types";
import { buildSpendReport } from "../spend";
import type { Binder } from "../rpc/types";

export function registerSpendHandlers(bind: Binder): void {
  bind("spend:report", (_ctx, range: unknown): Promise<SpendReport> =>
    buildSpendReport(isSpendRange(range) ? range : "all"),
  );
}
