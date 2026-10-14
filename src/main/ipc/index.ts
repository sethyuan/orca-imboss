import { registerAgentSessionHandlers } from "./agent_session";
import { registerChatHandlers } from "./chat";
import { registerCronHandlers } from "./cron";
import { registerEmployeeHandlers } from "./employee";
import { registerFileHandlers } from "./files";
import { registerIntegrationHandlers } from "./integrations";
import { registerMcpHandlers } from "./mcp";
import { registerMessageHandlers } from "./message";
import { registerMiniAppHandlers } from "./miniapps";
import { registerNetworkHandlers } from "./network";
import { registerProviderHandlers } from "./provider";
import { registerSessionHandlers } from "./session";
import { registerSettingsHandlers } from "./settings";
import { registerSkillHandlers } from "./skill";
import { registerStatHandlers } from "./stats";
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
  registerCronHandlers();
  registerMessageHandlers();
  registerProviderHandlers();
  registerSkillHandlers();
  registerStatHandlers();
  registerMcpHandlers();
  registerMiniAppHandlers();
  registerAgentSessionHandlers();
  registerEmployeeHandlers();
  registerFileHandlers();
  registerSessionHandlers();
  registerIntegrationHandlers();
}
