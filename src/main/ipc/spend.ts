import { isSpendRange } from "@shared/constants/spend";
import type { SpendReport } from "@shared/types";
import { buildSpendReport } from "../spend";
import type { Binder } from "../rpc/types";
import { parseTagFilter } from "./helpers";

export function registerSpendHandlers(bind: Binder): void {
  bind(
    "spend:report",
    (_ctx, range: unknown, chatTags: unknown): Promise<SpendReport> =>
      buildSpendReport(
        isSpendRange(range) ? range : "all",
        // The conversation grouping's tag filter; narrows only the
        // "All conversations" total (`chatFilterTotal`), never the grand total.
        parseTagFilter(chatTags),
      ),
  );
}
