import { SPEND_STATS_ENABLED } from "@shared/constants/spend";
import { useEffect } from "react";
import { parseSessionKey, useApp, type AppModule } from "./app-store";
import { AppShell } from "./components/app-shell";
import { AgentSessionModule } from "./components/modules/agent-session/agent-session-module";
import { ChatModule } from "./components/modules/chat/chat-module";
import { CronModule } from "./components/modules/cron/cron-module";
import { EmployeesModule } from "./components/modules/employees/employees-module";
import { GroupChatModule } from "./components/modules/group-chat/group-chat-module";
import { MiniAppModule } from "./components/modules/miniapp/miniapp-module";
import { PathBrowserModal } from "./components/path-browser";
import { SettingsModule } from "./components/modules/settings/settings-module";
import { SpendModule } from "./components/modules/spend/spend-module";

const MODULE_VIEWS: Partial<Record<AppModule, () => React.JSX.Element>> = {
  chat: ChatModule,
  employees: EmployeesModule,
  cron: CronModule,
  settings: SettingsModule,
  // Pluggable feature: its own master switch (see `SPEND_STATS_ENABLED`).
  ...(SPEND_STATS_ENABLED ? { spend: SpendModule } : {}),
};

export default function App(): React.JSX.Element {
  // Subscribe to `locale` so that a language switch re-renders the whole tree
  // and every `t()` call re-evaluates against the new locale. Without this,
  // only components that read `locale` directly (e.g. SettingsGeneral) refresh;
  // the rest of the UI (nav, headers, modules) would wait for a restart.
  const { locale } = useApp();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <>
      <AppShell />
      <ActiveModule />
      {/* Always mounted so visited mini-app iframes survive module switches. */}
      <MiniAppModule />
      {/* Remote-only: the backend's folder picker, driven by any flow that
          needs a path on the server (see `remote-files.ts`). */}
      <PathBrowserModal />
    </>
  );
}

function ActiveModule(): React.JSX.Element {
  const { module, activeChatId, activeSessionKey } = useApp();

  // Group chats opened from `chat`-kind cards render in a dedicated
  // single-pane view; the key resets the view when switching chats.
  if (module === "group-chat" && activeChatId !== null) {
    return <GroupChatModule key={activeChatId} chatId={activeChatId} />;
  }

  // Agent sessions opened from a chat avatar render in a dedicated single-pane
  // view; the key resets the view (and its live binding) when switching.
  if (module === "agent-session" && activeSessionKey !== null) {
    const target = parseSessionKey(activeSessionKey);
    if (target) {
      return (
        <AgentSessionModule
          key={activeSessionKey}
          employeeId={target.employeeId}
          chatId={target.chatId}
        />
      );
    }
  }

  // Mini apps are rendered by the persistent `MiniAppModule` host (so their
  // pages are never unmounted); the shell still uses the `single` layout here.
  if (module === "miniapp") return <></>;

  const View = MODULE_VIEWS[module];
  if (View) return <View />;
  return <ChatModule />;
}
