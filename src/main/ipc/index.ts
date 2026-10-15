import { registerAgentSessionHandlers } from "./agent_session";
import { registerBackupHandlers } from "./backup";
import { registerChatHandlers } from "./chat";
import { registerCronHandlers } from "./cron";
import { registerEmployeeHandlers } from "./employee";
import { registerFileHandlers } from "./files";
import { registerHandoffHandlers } from "./handoff";
import { registerIntegrationHandlers } from "./integrations";
import { registerMcpHandlers } from "./mcp";
import { registerMessageHandlers } from "./message";
import { registerMiniAppHandlers } from "./miniapps";
import { registerNetworkHandlers } from "./network";
import { registerProjectHandlers } from "./project";
import { registerProviderHandlers } from "./provider";
import { registerSessionHandlers } from "./session";
import { registerSettingsHandlers } from "./settings";
import { registerSkillHandlers } from "./skill";
import { SPEND_STATS_ENABLED } from "@shared/constants/spend";
import { CHAT_HANDOFF_ENABLED } from "@shared/constants/handoff";
import { registerSpendHandlers } from "./spend";
import { registerTagHandlers } from "./tag";
import { registerThemeHandlers } from "./theme";
import { registerUpdaterHandlers } from "./updater";
import { registerWindowHandlers } from "./window";
import { registerWorkdirHandlers } from "./workdir";

/** Register all renderer ↔ main IPC channels. */
export function registerIpcHandlers(): void {
  registerSettingsHandlers();
  registerWorkdirHandlers();
  registerThemeHandlers();
  registerNetworkHandlers();
  registerWindowHandlers();
  registerUpdaterHandlers();
  registerChatHandlers();
  registerTagHandlers();
  registerProjectHandlers();
  registerCronHandlers();
  registerMessageHandlers();
  registerProviderHandlers();
  registerSkillHandlers();
  // Pluggable feature: its own master switch (see `SPEND_STATS_ENABLED`).
  if (SPEND_STATS_ENABLED) registerSpendHandlers();
  // Pluggable feature: its own master switch (see `CHAT_HANDOFF_ENABLED`).
  if (CHAT_HANDOFF_ENABLED) registerHandoffHandlers();
  registerMcpHandlers();
  registerMiniAppHandlers();
  registerAgentSessionHandlers();
  registerEmployeeHandlers();
  registerFileHandlers();
  registerSessionHandlers();
  registerIntegrationHandlers();
  registerBackupHandlers();
}
