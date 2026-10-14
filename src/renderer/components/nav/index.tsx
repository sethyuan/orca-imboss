import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, type CSSProperties } from "react";
import { cls } from "reactutils";
import {
  appStore,
  openedItemKey,
  sessionKey,
  useApp,
  type AppModule,
} from "../../app-store";
import { BrandLogo } from "../brand-logo";
import { ContextMenu, type ContextMenuState } from "../context-menu";
import { EmployeeAvatar } from "../employee-avatar";
import { GroupAvatar } from "../group-avatar";
import {
  IconApp,
  IconChat,
  IconCollapse,
  IconEmployees,
  IconGear,
  IconMcp,
  IconSkills,
  IconUsage,
} from "../icons";
import { Tooltip } from "../tooltip";
import "./index.css";

interface NavItem {
  module: AppModule;
  labelKey: string;
  icon: (props: { className?: string }) => React.JSX.Element;
  section?: "main" | "miniapp" | "bottom";
}

const NAV_ITEMS: NavItem[] = [
  {
    module: "chat",
    labelKey: "Chats",
    icon: IconChat,
    section: "main",
  },
  {
    module: "employees",
    labelKey: "Employees",
    icon: IconEmployees,
    section: "main",
  },
  { module: "mcp", labelKey: "MCP", icon: IconMcp, section: "main" },
  {
    module: "skills",
    labelKey: "Skills",
    icon: IconSkills,
    section: "main",
  },
  {
    module: "settings",
    labelKey: "Settings",
    icon: IconGear,
    section: "bottom",
  },
  {
    module: "usage",
    labelKey: "Usage",
    icon: IconUsage,
    section: "main",
  },
];

export interface NavProps {
  collapsed: boolean;
  onToggle: () => void;
}

/** Read-only shape of an opened chat (valtio snapshots are deeply readonly). */
interface NavChat {
  readonly id: number;
  readonly title: string;
  readonly participants: readonly number[];
}

/** Read-only shape of a registered mini app (valtio snapshots are readonly). */
interface NavMiniApp {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
}

/**
 * Shared sortable-row wiring. Returns props for a row wrapper (which owns the
 * measured/transformed node) and the pointer listeners for the inner button
 * (whole-row drag). The wrapper intentionally sits outside `Tooltip`, whose
 * `cloneElement` overrides the child's `ref`.
 */
function useSortableNav(id: string): {
  ref: (node: HTMLElement | null) => void;
  style: CSSProperties;
  className: string | undefined;
  listeners: ReturnType<typeof useSortable>["listeners"];
} {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return {
    ref: setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition },
    className: cls("imb-nav-sortable", isDragging && "imb-is-dragging"),
    listeners,
  };
}

export function Nav({ collapsed, onToggle }: NavProps): React.JSX.Element {
  const {
    openedItems,
    module,
    activeChatId,
    activeSessionKey,
    activeMiniAppId,
    data,
  } = useApp();
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const main = NAV_ITEMS.filter((i) => i.section === "main");
  const bottom = NAV_ITEMS.filter((i) => i.section === "bottom");
  const miniApps = data.miniapps.items;
  const miniAppKeys = miniApps.map((app) => `miniapp:${app.id}`);
  const openedKeys = openedItems.map(openedItemKey);

  /** Persist and apply a mini-app drag reorder. */
  function handleMiniAppDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = miniAppKeys.indexOf(String(active.id));
    const to = miniAppKeys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(miniAppKeys, from, to).map((id) =>
      id.slice("miniapp:".length),
    );
    void appStore.reorderMiniApps(next);
  }

  /** Apply a reorder of the combined opened chats/sessions list. */
  function handleOpenedDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = openedKeys.indexOf(String(active.id));
    const to = openedKeys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    appStore.reorderOpenedItems(arrayMove(openedKeys, from, to));
  }

  return (
    <>
      <nav
        className={cls("imb-nav", collapsed && "imb-is-collapsed")}
        aria-label="Modules"
      >
        <div className="imb-nav-brand">
          <BrandLogo style={{ maxWidth: "41px" }} />
          <span className="imb-nav-brandname">imboss</span>
        </div>
        <div className="imb-nav-items">
          {main.map((item) => (
            <NavButton key={item.module} item={item} collapsed={collapsed} />
          ))}
        </div>
        <div className="imb-nav-divider" />
        <div className="imb-scroll">
          {miniApps.length > 0 && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleMiniAppDragEnd}
            >
              <SortableContext
                items={miniAppKeys}
                strategy={verticalListSortingStrategy}
              >
                <div className="imb-nav-items imb-nav-sortable-list">
                  {miniApps.map((app) => (
                    <NavMiniAppButton
                      key={app.id}
                      app={app}
                      collapsed={collapsed}
                      active={
                        module === "miniapp" && activeMiniAppId === app.id
                      }
                      onClick={() => appStore.openMiniApp(app.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          {openedItems.length > 0 && (
            <>
              {miniApps.length > 0 && <div className="imb-nav-divider" />}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleOpenedDragEnd}
              >
                <SortableContext
                  items={openedKeys}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="imb-nav-items imb-nav-sortable-list">
                    {openedItems.map((item) => {
                      const itemKey = openedItemKey(item);
                      if (item.kind === "chat") {
                        return (
                          <NavChatButton
                            key={itemKey}
                            chat={item}
                            collapsed={collapsed}
                            active={
                              module === "group-chat" &&
                              activeChatId === item.id
                            }
                            onClick={() => appStore.activateChat(item.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setCtxMenu({
                                x: e.clientX,
                                y: e.clientY,
                                items: [
                                  {
                                    key: "close",
                                    label: t("Close"),
                                    onSelect: () => appStore.closeChat(item.id),
                                  },
                                ],
                              });
                            }}
                          />
                        );
                      }
                      const key = sessionKey(item.employeeId, item.chatId);
                      const employee = data.employees.items.find(
                        (e) => e.id === item.employeeId,
                      );
                      const name = employee?.name ?? t("Unnamed");
                      const label = `${name} · ${item.chatTitle}`;
                      return (
                        <NavSessionButton
                          key={itemKey}
                          itemKey={itemKey}
                          employeeId={item.employeeId}
                          label={label}
                          collapsed={collapsed}
                          active={
                            module === "agent-session" &&
                            activeSessionKey === key
                          }
                          onClick={() => appStore.activateSession(key)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCtxMenu({
                              x: e.clientX,
                              y: e.clientY,
                              items: [
                                {
                                  key: "close",
                                  label: t("Close"),
                                  onSelect: () => appStore.closeSession(key),
                                },
                              ],
                            });
                          }}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </>
          )}
        </div>
        <div className="imb-nav-spacer" />
        <div className="imb-nav-items imb-nav-bottom">
          <Tooltip
            content={collapsed ? t("Expand") : t("Collapse")}
            placement="right"
            disabled={!collapsed}
          >
            <button
              type="button"
              className="imb-nav-toggle"
              aria-label={collapsed ? t("Expand") : t("Collapse")}
              onClick={onToggle}
            >
              <IconCollapse className="imb-icon" />
              <span>{t("Collapse")}</span>
            </button>
          </Tooltip>
          {bottom.map((item) => (
            <NavButton key={item.module} item={item} collapsed={collapsed} />
          ))}
        </div>
      </nav>
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
    </>
  );
}

type NavButtonProps = {
  item: NavItem;
  collapsed: boolean;
};

function NavButton({ item, collapsed }: NavButtonProps): React.JSX.Element {
  const { module } = useApp();

  async function setModule(value: AppModule): Promise<void> {
    // Entering Settings via the nav opens its default section; the updater's
    // notification click deep-links to About through `appStore.openSettings`.
    if (value === "settings") appStore.settingsSection = "general";
    appStore.module = value;
    await imb.settings.set(SettingKeys.Module, value);
  }

  const Icon = item.icon;
  const active = module === item.module;

  return (
    <Tooltip content={t(item.labelKey)} placement="right" disabled={!collapsed}>
      <button
        type="button"
        className={cls("imb-nav-item", active && "imb-is-active")}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? t(item.labelKey) : undefined}
        onClick={() => setModule(item.module)}
      >
        <Icon className="imb-icon" />
        <span className="imb-nav-label">{t(item.labelKey)}</span>
      </button>
    </Tooltip>
  );
}

type NavChatButtonProps = {
  chat: NavChat;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
};

/** Nav entry for a group chat opened from a `chat`-kind card. Sortable. */
function NavChatButton({
  chat,
  collapsed,
  active,
  onClick,
  onContextMenu,
}: NavChatButtonProps): React.JSX.Element {
  const { ref, style, className, listeners } = useSortableNav(
    `chat:${chat.id}`,
  );

  return (
    <div ref={ref} className={className} style={style}>
      <Tooltip content={chat.title} placement="right">
        <button
          type="button"
          className={cls("imb-nav-item", active && "imb-is-active")}
          aria-current={active ? "page" : undefined}
          aria-label={collapsed ? chat.title : undefined}
          onClick={onClick}
          onContextMenu={onContextMenu}
          {...(listeners ?? {})}
        >
          <GroupAvatar participants={chat.participants} size={24} />
          <span className="imb-nav-label">{chat.title}</span>
        </button>
      </Tooltip>
    </div>
  );
}

type NavSessionButtonProps = {
  /** Stable drag-and-drop id from `openedItemKey`. */
  itemKey: string;
  employeeId: number;
  label: string;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
};

/** Nav entry for an opened employee agent session. Sortable. */
function NavSessionButton({
  itemKey,
  employeeId,
  label,
  collapsed,
  active,
  onClick,
  onContextMenu,
}: NavSessionButtonProps): React.JSX.Element {
  const { ref, style, className, listeners } = useSortableNav(itemKey);

  return (
    <div ref={ref} className={className} style={style}>
      <Tooltip content={label} placement="right">
        <button
          type="button"
          className={cls("imb-nav-item", active && "imb-is-active")}
          aria-current={active ? "page" : undefined}
          aria-label={collapsed ? label : undefined}
          onClick={onClick}
          onContextMenu={onContextMenu}
          {...(listeners ?? {})}
        >
          <EmployeeAvatar employeeId={employeeId} size={24} />
          <span className="imb-nav-label">{label}</span>
        </button>
      </Tooltip>
    </div>
  );
}

type NavMiniAppButtonProps = {
  app: NavMiniApp;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
};

/** Nav entry for a registered mini app. Sortable (persisted via main). */
function NavMiniAppButton({
  app,
  collapsed,
  active,
  onClick,
}: NavMiniAppButtonProps): React.JSX.Element {
  const { ref, style, className, listeners } = useSortableNav(
    `miniapp:${app.id}`,
  );

  return (
    <div ref={ref} className={className} style={style}>
      <Tooltip content={app.name} placement="right">
        <button
          type="button"
          className={cls("imb-nav-item", active && "imb-is-active")}
          aria-current={active ? "page" : undefined}
          aria-label={collapsed ? app.name : undefined}
          onClick={onClick}
          {...(listeners ?? {})}
        >
          {app.iconUrl !== null ? (
            <img
              className="imb-nav-appicon"
              src={app.iconUrl}
              alt=""
              draggable={false}
            />
          ) : (
            <IconApp className="imb-icon" />
          )}
          <span className="imb-nav-label">{app.name}</span>
        </button>
      </Tooltip>
    </div>
  );
}
