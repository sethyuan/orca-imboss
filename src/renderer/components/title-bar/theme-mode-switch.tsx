import { t } from "@shared/l10n";
import type { ThemeMode } from "@shared/types";
import { useApp } from "../../app-store";
import { setTheme } from "../../theme";
import { IconAuto, IconMoon, IconSun } from "../icons";
import { SegmentedControl } from "../segmented-control";

/**
 * Theme-mode switch for the chrome band: an icon-only mini segmented control
 * (light / dark / follow the system).
 *
 * Deliberately text-free — the band is 30px tall and the boss asked for icons
 * only — which is why every segment carries `aria-label` (see
 * `SegmentedControl`) and the group is named after `Theme mode`.
 *
 * State comes from `useApp().theme` and writes go through the renderer's
 * `setTheme()` only: that is the one path that persists through IPC *and*
 * repaints `html[data-theme-mode]` / `appStore.theme`, so the settings page and
 * this switch can never disagree. No tooltip on purpose (boss's decision):
 * hovering must not add text.
 */
export function ThemeModeSwitch(): React.JSX.Element {
  const { theme } = useApp();

  return (
    <div className="imb-titlebar-theme">
      <SegmentedControl<ThemeMode>
        size="mini"
        label={t("Theme mode")}
        value={theme.mode}
        onChange={(mode) => void setTheme({ mode })}
        options={[
          { value: "light", label: t("Light"), icon: <IconSun /> },
          { value: "dark", label: t("Dark"), icon: <IconMoon /> },
          { value: "system", label: t("System"), icon: <IconAuto /> },
        ]}
      />
    </div>
  );
}
