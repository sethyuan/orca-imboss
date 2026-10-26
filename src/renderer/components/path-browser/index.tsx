import { t } from "@shared/l10n";
import { useEffect, useState } from "react";
import { isPathBrowserOpen, settlePathBrowser } from "../../remote-files";
import { useApp } from "../../app-store";
import { Button } from "../button";
import { Input } from "../input";
import { Modal } from "../modal";
import "./index.css";

/**
 * Folder picker for a **remote** backend.
 *
 * The remote counterpart of the native "choose a folder" dialog, and nothing
 * more: breadcrumb, sub-folders, "new folder", "use this folder". It never lists
 * files — every flow that needs a path from here needs a directory (working
 * directory, skill folder, an attached folder for the agent).
 *
 * Driven by `remote-files.ts` so any flow can `await chooseRemoteDirectory()`
 * without owning a modal.
 */
interface Listing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  roots: { name: string; path: string }[];
}

export function PathBrowserModal(): React.JSX.Element | null {
  const { pathBrowser } = useApp();
  const open = isPathBrowserOpen();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [creating, setCreating] = useState(false);

  // Load the initial listing every time the browser is opened (the backend's
  // filesystem may have changed, and the home folder is the sane default).
  useEffect(() => {
    if (!open) {
      setListing(null);
      setError(null);
      setNewFolder("");
      return;
    }
    void load(undefined);
    // `load` is stable enough: it only reads its argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function load(path?: string): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setListing(await imb.files.listDir(path));
      setNewFolder("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function createFolder(): Promise<void> {
    if (listing === null || creating) return;
    const name = newFolder.trim();
    if (name.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const path = await imb.files.createDirectory(listing.path, name);
      await load(listing.path);
      // Jump into the folder the user just made: that is almost always the point.
      await load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  if (!open) return null;

  const current = listing?.path ?? "";
  return (
    <Modal
      open
      onClose={() => settlePathBrowser(null)}
      title={pathBrowser.title || t("Choose a folder on the server")}
      sub={t("Browsing folders on the imboss backend.")}
      error={error}
      size="lg"
      actions={
        <>
          <Button variant="secondary" onClick={() => settlePathBrowser(null)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={current.length === 0 || loading}
            onClick={() => settlePathBrowser(current)}
          >
            {t("Use this folder")}
          </Button>
        </>
      }
    >
      <div className="imb-path-browser">
        {listing !== null && listing.roots.length > 0 ? (
          <div className="imb-path-browser-roots">
            {listing.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="imb-path-browser-chip"
                onClick={() => void load(root.path)}
              >
                {root.name}
              </button>
            ))}
          </div>
        ) : null}

        <Breadcrumb path={current} onNavigate={(path) => void load(path)} />

        <div className="imb-path-browser-list">
          {listing?.parent ? (
            <button
              type="button"
              className="imb-path-browser-row is-parent"
              onClick={() => void load(listing.parent ?? undefined)}
            >
              <span className="imb-path-browser-arrow">↑</span>
              <span className="imb-path-browser-name">
                {t("Parent folder")}
              </span>
            </button>
          ) : null}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="imb-path-browser-row"
              onClick={() => void load(entry.path)}
            >
              <span className="imb-path-browser-folder" aria-hidden="true">
                📁
              </span>
              <span className="imb-path-browser-name">{entry.name}</span>
            </button>
          ))}
          {listing !== null &&
          listing.entries.length === 0 &&
          listing.parent === null ? (
            <div className="imb-path-browser-empty">{t("No sub-folders.")}</div>
          ) : null}
        </div>

        <div className="imb-path-browser-new">
          <Input
            value={newFolder}
            placeholder={t("New folder name")}
            onChange={(event) => setNewFolder(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createFolder();
            }}
          />
          <Button
            variant="secondary"
            disabled={newFolder.trim().length === 0 || creating || loading}
            onClick={() => void createFolder()}
          >
            {t("New folder")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * `…/a/b/c` as clickable segments. The backend path is POSIX-shaped except on a
 * Windows backend, so the separator is detected from the path itself instead of
 * assuming `/`.
 */
function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}): React.JSX.Element | null {
  if (path.length === 0) return null;
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(separator).filter((part) => part.length > 0);

  const segments: { label: string; path: string }[] = [];
  let accumulated = path.startsWith(separator) ? separator : "";
  for (const part of parts) {
    accumulated =
      accumulated === "" || accumulated === separator
        ? `${accumulated}${part}`
        : `${accumulated}${separator}${part}`;
    segments.push({ label: part, path: accumulated });
  }

  return (
    <div className="imb-path-browser-crumbs">
      {segments.map((segment, index) => (
        <span key={segment.path} className="imb-path-browser-crumb">
          {index > 0 ? (
            <span className="imb-path-browser-sep">{separator}</span>
          ) : null}
          <button
            type="button"
            onClick={() => onNavigate(segment.path)}
            title={segment.path}
          >
            {segment.label}
          </button>
        </span>
      ))}
    </div>
  );
}
