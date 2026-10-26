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
import { SettingKeys } from "@shared/constants/settings";
import { SPEND_STATS_ENABLED } from "@shared/constants/spend";
import { t } from "@shared/l10n";
import { useState, type CSSProperties } from "react";
import { cls } from "reactutils";
import {
  appStore,
  openedItemKey,
  sessionKey,
  useApp,
  type AppModule,
  type OpenedItemRef,
} from "../../app-store";
import { BrandLogo } from "../brand-logo";
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuState,
} from "../context-menu";
import { EmployeeAvatar } from "../employee-avatar";
import { GroupAvatar } from "../group-avatar";
import {
  IconApp,
  IconChat,
  IconClock,
  IconEmployees,
  IconGear,
  IconStats,
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
  {
    module: "cron",
    labelKey: "Scheduled tasks",
    icon: IconClock,
    section: "main",
  },
  {
    module: "settings",
    labelKey: "Settings",
    icon: IconGear,
    section: "bottom",
  },
  // Pluggable feature: its own master switch (see `SPEND_STATS_ENABLED`).
  ...(SPEND_STATS_ENABLED
    ? [
        {
          module: "spend" as const,
          labelKey: "Statistics",
          icon: IconStats,
          section: "main" as const,
        },
      ]
    : []),
];

/**
 * Menu of an opened Nav entry: close this entry, close every *other* opened
 * entry, or every opened group chat and agent session at once (both Nav menus
 * offer the same actions, so they never depend on which kind was right-clicked).
 *
 * `ref` is the right-clicked entry — "close others" keeps exactly that one, and
 * `openedItems.length` is read when the menu opens (a menu is short-lived, so no
 * state would change under it).
 */
function closeMenuItems(
  ref: OpenedItemRef,
  onCloseOne: () => void,
): ContextMenuItem[] {
  return [
    { key: "close", label: t("Close"), onSelect: onCloseOne },
    {
      key: "close-others",
      label: t("Close others"),
      // Nothing else to close with a single entry open. Disabled rather than
      // hidden, so the menu keeps the same shape as "Close all".
      disabled: appStore.openedItems.length <= 1,
      onSelect: () => appStore.closeOtherOpenedItems(ref),
    },
    {
      key: "close-all",
      label: t("Close all"),
      onSelect: () => appStore.closeAllOpenedItems(),
    },
  ];
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

export function Nav(): React.JSX.Element {
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
  // Mini Apps are local web servers on the *backend*: their iframe entry is
  // `127.0.0.1:<port>`, which a remote desktop can never reach. The whole section
  // is hidden in remote mode rather than showing dead tiles (see
  // `.pi/facts/grpc-remote-backend-research.md` §6.4 for the alternatives we
  // deliberately did not build).
  const miniApps = appStore.remote.enabled ? [] : data.miniapps.items;
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
      <nav className="imb-nav imb-chrome" aria-label="Modules">
        {/* Rail: the brand is the app mark alone; names live in tooltips. */}
        <div className="imb-nav-brand">
          <BrandLogo />
        </div>
        <div className="imb-nav-items">
          {main.map((item) => (
            <NavButton key={item.module} item={item} />
          ))}
        </div>
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
                                items: closeMenuItems(item, () =>
                                  appStore.closeChat(item.id),
                                ),
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
                              items: closeMenuItems(item, () =>
                                appStore.closeSession(key),
                              ),
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
          {bottom.map((item) => (
            <NavButton key={item.module} item={item} />
          ))}
        </div>
      </nav>
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
    </>
  );
}

type NavButtonProps = {
  item: NavItem;
};

function NavButton({ item }: NavButtonProps): React.JSX.Element {
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
    <Tooltip content={t(item.labelKey)} placement="right">
      <button
        type="button"
        className={cls("imb-nav-item", active && "imb-is-active")}
        data-module={item.module}
        aria-current={active ? "page" : undefined}
        aria-label={t(item.labelKey)}
        onClick={() => setModule(item.module)}
      >
        <Icon className="imb-icon" />
      </button>
    </Tooltip>
  );
}

type NavChatButtonProps = {
  chat: NavChat;
  active: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
};

/** Nav entry for a group chat opened from a `chat`-kind card. Sortable. */
function NavChatButton({
  chat,
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
          aria-label={chat.title}
          onClick={onClick}
          onContextMenu={onContextMenu}
          {...(listeners ?? {})}
        >
          <span className="imb-nav-avatar">
            <GroupAvatar participants={chat.participants} size={24} />
            {/*
             * Group-chat marker. A 24px avatar next to a 24px employee avatar is
             * hard to tell apart at rail size, and a bare dot would say nothing;
             * two overlapping speech tiles read as "a conversation with several
             * people". Decorative — the accessible name stays the chat title.
             */}
            <span className="imb-nav-badge" aria-hidden="true">
              <svg viewBox="0 0 8 8" focusable="false">
                <rect x="0.6" y="1.4" width="4.6" height="3.9" rx="1.1" />
                <rect x="3.1" y="3.4" width="4.3" height="3.4" rx="1.05" />
              </svg>
            </span>
          </span>
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
  active: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
};

/** Nav entry for an opened employee agent session. Sortable. */
function NavSessionButton({
  itemKey,
  employeeId,
  label,
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
          aria-label={label}
          onClick={onClick}
          onContextMenu={onContextMenu}
          {...(listeners ?? {})}
        >
          <EmployeeAvatar employeeId={employeeId} size={24} />
        </button>
      </Tooltip>
    </div>
  );
}

type NavMiniAppButtonProps = {
  app: NavMiniApp;
  active: boolean;
  onClick: () => void;
};

/** Nav entry for a registered mini app. Sortable (persisted via main). */
function NavMiniAppButton({
  app,
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
          aria-label={app.name}
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
        </button>
      </Tooltip>
    </div>
  );
}
