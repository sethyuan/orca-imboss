// Setting keys
export const SettingKeys = {
  Locale: "app.locale",
  DefaultModel: "agent.defaultModel",
  /**
   * JSON array of `provider/id`, oldest favorite first. Entries that are not
   * in the current model list stay stored and reappear when that provider
   * is available again.
   */
  FavoriteModels: "agent.favoriteModels",
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
  Module: "ui.module",
  WindowState: "ui.window",
  /** Folder id of the last opened mini app (restored on next launch). */
  MiniAppActive: "ui.miniAppActive",
  /**
   * Global accelerator that shows / hides the main window. A missing row means
   * "never configured" (the platform default applies); an empty string means
   * the user turned the shortcut off. See `src/shared/shortcut.ts`.
   */
  WindowShortcut: "app.windowShortcut",
  UpdateNotifiedVersion: "app.updateNotifiedVersion",
};
