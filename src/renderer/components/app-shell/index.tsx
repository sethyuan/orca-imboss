import { SettingKeys } from "@shared/constants/settings";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import {
  appStore,
  contentPaneRef,
  detailPaneRef,
  listPaneRef,
  useApp,
  type AppModule,
} from "../../app-store";
import { Nav } from "../nav";
import { TitleBar } from "../title-bar";
import "./index.css";

/**
 * App shell layouts.
 * - `list-detail` — three-column grid (nav | 300px list | 1fr detail) used by
 *   modules that have both a list pane and a detail pane.
 * - `single` — two-column grid (nav | full-width content) for pages with neither.
 */
export type ShellLayout = "list-detail" | "single";

/**
 * Modules that render the list + detail split. Modules NOT listed here default to
 * `single` (two-column). New list-less pages need no registry entry.
 */
const LIST_DETAIL_MODULES: ReadonlySet<AppModule> = new Set([
  "chat",
  "employees",
  "cron",
  "settings",
  "spend",
]);

/**
 * App shell — nav rail plus a content region. The content region is either a
 * list/detail split (`list-detail` modules) or a single full-width content pane
 * (two-column `single` modules). Active modules portal their trees into the
 * matching pane(s) (see ModuleView below).
 */
export function AppShell(): React.JSX.Element {
  const { module, navCollapsed } = useApp();
  const layout = shellLayoutFor(module);

  // Fade the content region on a module change. A whole-region fade (rather
  // than per-module wrappers) is the least invasive transition and needs no
  // structural changes inside the modules.
  const [contentAnim, setContentAnim] = useState(false);
  useEffect(() => {
    setContentAnim(true);
    const timer = window.setTimeout(() => setContentAnim(false), 240);
    return () => window.clearTimeout(timer);
  }, [module]);

  async function setNavCollapsed(collapsed: boolean): Promise<void> {
    appStore.navCollapsed = collapsed;
    void imb.settings.set(SettingKeys.NavCollapse, collapsed ? "1" : "0");
  }

  return (
    <div className={cls("imb-app", navCollapsed && "imb-is-collapsed")}>
      <TitleBar />
      <Nav
        collapsed={navCollapsed}
        onToggle={() => setNavCollapsed(!navCollapsed)}
      />
      <div
        className={cls(
          "imb-shell-content",
          layout === "single" && "imb-layout-single",
          contentAnim && "imb-content-enter",
        )}
      >
        {/* Always mounted: it hosts the persistent mini-app iframes, which
            must survive a switch to a list/detail layout without reloading. */}
        <section
          className={cls(
            "imb-pane imb-contentpane",
            layout !== "single" && "imb-pane-hidden",
          )}
          ref={contentPaneRef}
          aria-label="Content"
        />
        {layout !== "single" && (
          <>
            <section
              className="imb-pane imb-listpane"
              ref={listPaneRef}
              aria-label="List"
            />
            <section
              className="imb-pane imb-detailpane"
              ref={detailPaneRef}
              aria-label="Detail"
            />
          </>
        )}
      </div>
    </div>
  );
}

export interface PaneContent {
  list: ReactNode;
  detail: ReactNode;
}

export interface ContentPane {
  content: ReactNode;
}

export type ModuleViewProps = PaneContent | ContentPane;

/**
 * Renders module content into the shell's panes (portals, shared state).
 * - `list-detail` modules pass `{ list, detail }` (portals into both panes).
 * - `single` (two-column) modules pass `{ content }` (portals into the content pane).
 *
 * Returns `null` until the target(s) for the active module's layout are mounted.
 */
export function ModuleView(props: ModuleViewProps): React.JSX.Element | null {
  const { module } = useApp();
  const layout = shellLayoutFor(module);

  const [targets, setTargets] = useState<{
    list?: HTMLElement | null;
    detail?: HTMLElement | null;
    content?: HTMLElement | null;
  }>({});

  useLayoutEffect(() => {
    if (layout === "single") {
      setTargets({ content: contentPaneRef.current });
    } else {
      setTargets({ list: listPaneRef.current, detail: detailPaneRef.current });
    }
  }, [layout, module, contentPaneRef, listPaneRef, detailPaneRef]);

  if (layout === "single") {
    if (!("content" in props) || !targets.content) return null;
    return createPortal(props.content, targets.content);
  }

  if (!("list" in props) || !("detail" in props)) return null;
  if (!targets.list || !targets.detail) return null;
  return (
    <>
      {createPortal(props.list, targets.list)}
      {createPortal(props.detail, targets.detail)}
    </>
  );
}

function shellLayoutFor(module: AppModule): ShellLayout {
  return LIST_DETAIL_MODULES.has(module) ? "list-detail" : "single";
}
