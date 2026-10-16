// Setting keys
export const SettingKeys = {
  Locale: "app.locale",
  DefaultModel: "agent.defaultModel",
  /**
   * `"<provider>/<modelId>"` of the model that describes pictures for agents
   * that cannot see them (empty = not configured, and `imb_look_at_image` then
   * reports that clearly).
   */
  VisionModel: "agent.visionModel",
  DefaultThinkingLevel: "agent.defaultThinkingLevel",
  UserEnv: "agent.userEnv",
  WorkDir: "agent.workdir",
  /** Shortlisted projects (folder + tags) applied from the attach menu. */
  CommonProjects: "app.commonProjects",
  /** Outbound HTTP(S) proxy URL for model/provider traffic (empty = direct). */
  HttpProxy: "network.httpProxy",
  ThemeMode: "ui.theme.mode",
  ThemeColor: "ui.theme.color",
  NavCollapse: "ui.navCollapsed",
  Module: "ui.module",
  WindowState: "ui.window",
  /** Folder id of the last opened mini app (restored on next launch). */
  MiniAppActive: "ui.miniAppActive",
  UpdateNotifiedVersion: "app.updateNotifiedVersion",
};
