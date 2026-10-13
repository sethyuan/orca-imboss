import { t } from "@shared/l10n";
import type { AssetRef, AssetSummary } from "@shared/types";
import { Button } from "../../../../button";
import { refOf } from "../helpers";
import "./index.css";

/**
 * Action callbacks shared by the detail-pane buttons and the row context menu.
 * The module owns the implementations (IPC + refresh); this component only
 * renders the button row.
 */
export interface AssetCommands {
  reveal: (ref: AssetRef) => void;
  open: (ref: AssetRef) => void;
  copyPath: (paths: readonly (string | null)[]) => void;
  saveAs: (ref: AssetRef) => void;
  hide: (refs: readonly AssetRef[]) => void;
  requestTrash: (refs: readonly AssetRef[]) => void;
}

export interface AssetActionsProps {
  /** The current asset, or the current multi-selection (first = primary). */
  assets: readonly AssetSummary[];
  /** Live on-disk state of the primary asset (`true` disables file actions). */
  missing: boolean;
  commands: AssetCommands;
}

/** Button row for the current asset (or the multi-selection). */
export function AssetActions({
  assets,
  missing,
  commands,
}: AssetActionsProps): React.JSX.Element {
  const primary = assets[0];
  const primaryRef = primary === undefined ? null : refOf(primary);
  // File actions need a real on-disk file; hide/trash work from the locator.
  const fileDisabled =
    primary === undefined || missing || primary.path === null;
  // Hiding and trashing are path-keyed, so an attachment with no stored path
  // (legacy/integration rows) cannot take part: keep it out of those refs so a
  // partial selection cannot fail the whole action.
  const pathRefs = assets
    .filter((asset) => asset.path !== null && asset.path.length > 0)
    .map(refOf);
  const hasPath = pathRefs.length > 0;

  return (
    <div className="imb-asset-actions">
      <Button
        size="sm"
        variant="secondary"
        disabled={fileDisabled}
        onClick={() => {
          if (primaryRef) commands.reveal(primaryRef);
        }}
      >
        {t("Show in folder")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={fileDisabled}
        onClick={() => {
          if (primaryRef) commands.open(primaryRef);
        }}
      >
        {t("Open")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasPath}
        onClick={() => commands.copyPath(assets.map((asset) => asset.path))}
      >
        {t("Copy path")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={fileDisabled}
        onClick={() => {
          if (primaryRef) commands.saveAs(primaryRef);
        }}
      >
        {t("Save as…")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!hasPath}
        onClick={() => commands.hide(pathRefs)}
      >
        {t("Hide")}
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={fileDisabled || !hasPath}
        onClick={() => commands.requestTrash(pathRefs)}
      >
        {t("Move to trash")}
      </Button>
    </div>
  );
}
