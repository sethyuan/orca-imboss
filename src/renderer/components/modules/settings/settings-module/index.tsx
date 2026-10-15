import { t } from "@shared/l10n";
import { appStore, useApp, type SettingsSection } from "../../../../app-store";
import { ModuleView } from "../../../app-shell";
import { ListPane } from "../../../list-pane";
import { ListRow } from "../../../list-row";
import "../../module-common.css";
import { SettingsAbout } from "../settings-about";
import { SettingsBackup } from "../settings-backup";
import { SettingsGeneral } from "../settings-general";
import { SettingsIntegrations } from "../settings-integrations";
import { SettingsMcp } from "../settings-mcp";
import { SettingsNetwork } from "../settings-network";
import { SettingsProviders } from "../settings-providers";
import { SettingsSkills } from "../settings-skills";
import { SettingsTheme } from "../settings-theme";

const SECTIONS: Array<{
  id: SettingsSection;
  labelKey: string;
  descKey: string;
}> = [
  {
    id: "general",
    labelKey: "General",
    descKey: "App language and basic settings",
  },
  { id: "theme", labelKey: "Theme", descKey: "Accent color and theme mode" },
  {
    id: "providers",
    labelKey: "Model Providers",
    descKey: "API keys and model endpoints",
  },
  { id: "mcp", labelKey: "MCP", descKey: "MCP servers and tools for agents" },
  {
    id: "skills",
    labelKey: "Skills",
    descKey: "Import and manage agent skills",
  },
  {
    id: "integrations",
    labelKey: "Integrations",
    descKey: "Connect WeChat, QQ and Telegram",
  },
  {
    id: "network",
    labelKey: "Network",
    descKey: "Proxy for outbound model requests",
  },
  {
    id: "backup",
    labelKey: "Backup",
    descKey: "Export and restore all local data",
  },
  { id: "about", labelKey: "About", descKey: "Version info" },
];

export function SettingsModule(): React.JSX.Element {
  const { settingsSection } = useApp();

  const list = (
    <ListPane title={t("Settings")}>
      {SECTIONS.map((item) => (
        <ListRow
          key={item.id}
          active={settingsSection === item.id}
          name={t(item.labelKey)}
          sub={t(item.descKey)}
          onClick={() => {
            appStore.settingsSection = item.id;
          }}
        />
      ))}
    </ListPane>
  );

  const detail =
    settingsSection === "theme" ? (
      <SettingsTheme />
    ) : settingsSection === "providers" ? (
      <SettingsProviders />
    ) : settingsSection === "mcp" ? (
      <SettingsMcp />
    ) : settingsSection === "skills" ? (
      <SettingsSkills />
    ) : settingsSection === "integrations" ? (
      <SettingsIntegrations />
    ) : settingsSection === "network" ? (
      <SettingsNetwork />
    ) : settingsSection === "backup" ? (
      <SettingsBackup />
    ) : settingsSection === "about" ? (
      <SettingsAbout />
    ) : (
      <SettingsGeneral />
    );

  return <ModuleView list={list} detail={detail} />;
}
