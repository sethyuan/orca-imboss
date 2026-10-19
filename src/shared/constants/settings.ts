// Setting keys
export const SettingKeys = {
  Locale: "app.locale",
  DefaultModel: "agent.defaultModel",
  /**
   * `"<provider>/<modelId>"` of the model that generates chat images (empty =
   * not configured, and `imb_generate_image` then reports that clearly).
   */
  ImageModel: "agent.imageModel",
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
  /** Whether this company's own A2A endpoint listens for other companies. */
  RemoteInboundEnabled: "remote.inbound.enabled",
  /** Interface the A2A endpoint binds (loopback by default). */
  RemoteInboundHost: "remote.inbound.host",
  /** Port the A2A endpoint binds. */
  RemoteInboundPort: "remote.inbound.port",
  /** Company name advertised in this agent's A2A card. */
  RemoteInboundName: "remote.inbound.name",
};
