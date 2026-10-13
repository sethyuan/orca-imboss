import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import { useState } from "react";
import { cls } from "reactutils";
import { appStore, sessionKey, useApp, type AppModule } from "../../app-store";
import { BrandLogo } from "../brand-logo";
import { ContextMenu, type ContextMenuState } from "../context-menu";
import { EmployeeAvatar } from "../employee-avatar";
import { GroupAvatar } from "../group-avatar";
import {
  IconApp,
  IconAssets,
  IconChat,
  IconCollapse,
  IconEmployees,
  IconGear,
  IconMcp,
  IconModels,
  IconSkills,
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
    module: "providers",
    labelKey: "Providers",
    icon: IconModels,
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
    module: "assets",
    labelKey: "Assets",
    icon: IconAssets,
    section: "main",
  },
  {
    module: "settings",
    labelKey: "Settings",
    icon: IconGear,
    section: "bottom",
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

export function Nav({ collapsed, onToggle }: NavProps): React.JSX.Element {
  const {
    openedChats,
    openedSessions,
    module,
    activeChatId,
    activeSessionKey,
    activeMiniAppId,
    data,
  } = useApp();
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const main = NAV_ITEMS.filter((i) => i.section === "main");
  const bottom = NAV_ITEMS.filter((i) => i.section === "bottom");
  const miniApps = data.miniapps.items;

  /** Move `fromId` to `toId`'s position and persist the new order. */
  function reorderMiniApps(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const ids = miniApps.map((app) => app.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void appStore.reorderMiniApps(ids);
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
            <div className="imb-nav-items">
              {miniApps.map((app) => (
                <NavMiniAppButton
                  key={app.id}
                  app={app}
                  collapsed={collapsed}
                  active={module === "miniapp" && activeMiniAppId === app.id}
                  dragging={dragId === app.id}
                  onClick={() => appStore.openMiniApp(app.id)}
                  onDragStart={() => setDragId(app.id)}
                  onDragEnd={() => setDragId(null)}
                  onDrop={() => {
                    if (dragId) reorderMiniApps(dragId, app.id);
                    setDragId(null);
                  }}
                />
              ))}
            </div>
          )}
          {openedChats.length > 0 && (
            <>
              {miniApps.length > 0 && <div className="imb-nav-divider" />}
              <div className="imb-nav-items">
                {openedChats.map((chat) => (
                  <NavChatButton
                    key={chat.id}
                    chat={chat}
                    collapsed={collapsed}
                    active={module === "group-chat" && activeChatId === chat.id}
                    onClick={() => appStore.activateChat(chat.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          {
                            key: "close",
                            label: t("Close"),
                            onSelect: () => appStore.closeChat(chat.id),
                          },
                        ],
                      });
                    }}
                  />
                ))}
              </div>
            </>
          )}
          {openedSessions.length > 0 && (
            <>
              {(miniApps.length > 0 || openedChats.length > 0) && (
                <div className="imb-nav-divider" />
              )}
              <div className="imb-nav-items">
                {openedSessions.map((session) => {
                  const key = sessionKey(session.employeeId, session.chatId);
                  const employee = data.employees.items.find(
                    (e) => e.id === session.employeeId,
                  );
                  const name = employee?.name ?? t("Unnamed");
                  const label = `${name} · ${session.chatTitle}`;
                  return (
                    <NavSessionButton
                      key={key}
                      employeeId={session.employeeId}
                      label={label}
                      collapsed={collapsed}
                      active={
                        module === "agent-session" && activeSessionKey === key
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

/** Nav entry for a group chat opened from a `chat`-kind card. */
function NavChatButton({
  chat,
  collapsed,
  active,
  onClick,
  onContextMenu,
}: NavChatButtonProps): React.JSX.Element {
  return (
    <Tooltip content={chat.title} placement="right">
      <button
        type="button"
        className={cls("imb-nav-item", active && "imb-is-active")}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? chat.title : undefined}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <GroupAvatar participants={chat.participants} size={24} />
        <span className="imb-nav-label">{chat.title}</span>
      </button>
    </Tooltip>
  );
}

/** Nav entry for an opened employee agent session. */
function NavSessionButton({
  employeeId,
  label,
  collapsed,
  active,
  onClick,
  onContextMenu,
}: NavSessionButtonProps): React.JSX.Element {
  return (
    <Tooltip content={label} placement="right">
      <button
        type="button"
        className={cls("imb-nav-item", active && "imb-is-active")}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <EmployeeAvatar employeeId={employeeId} size={24} />
        <span className="imb-nav-label">{label}</span>
      </button>
    </Tooltip>
  );
}

type NavSessionButtonProps = {
  employeeId: number;
  label: string;
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
};

/** Read-only shape of a registered mini app (valtio snapshots are readonly). */
interface NavMiniApp {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
}

type NavMiniAppButtonProps = {
  app: NavMiniApp;
  collapsed: boolean;
  active: boolean;
  dragging: boolean;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
};

/** Nav entry for a registered mini app; draggable to reorder the sidebar. */
function NavMiniAppButton({
  app,
  collapsed,
  active,
  dragging,
  onClick,
  onDragStart,
  onDragEnd,
  onDrop,
}: NavMiniAppButtonProps): React.JSX.Element {
  return (
    <Tooltip content={app.name} placement="right">
      <button
        type="button"
        className={cls(
          "imb-nav-item",
          active && "imb-is-active",
          dragging && "imb-is-dragging",
        )}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? app.name : undefined}
        draggable
        onClick={onClick}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
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
  );
}
