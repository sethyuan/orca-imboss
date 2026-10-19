import { useEffect, useRef, useState } from "react";
import { t } from "@shared/l10n";
import { cls } from "reactutils";
import { IS_MAC, useApp } from "../../app-store";
import { setTheme, THEME_COLORS } from "../../theme";
import "./index.css";

const stroke = { stroke: "currentColor", strokeWidth: 1.4 } as const;

/** Mode labels for the quick-switch popover. */
const MODE_LABELS = {
  light: "Light",
  dark: "Dark",
  system: "System",
} as const;

/**
 * Full-width title bar / drag region (row 1 of `.imb-app`).
 * macOS: empty draggable strip; the native traffic lights sit on its left.
 * Windows/Linux: custom small min/max/close buttons on the right (native
 * controls are hidden via the absence of `titleBarOverlay`).
 */
export function TitleBar(): React.JSX.Element {
  const { theme } = useApp();
  const [maximized, setMaximized] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Close the theme popover on an outside click. Escape closes it too.
  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setThemeOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setThemeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [themeOpen]);

  useEffect(() => {
    let alive = true;
    void imb.windowControls.isMaximized().then((m) => {
      if (alive) setMaximized(m);
    });
    const unsubscribe = imb.windowControls.onMaximized((m) => {
      if (alive) setMaximized(m);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return (
    <header className="imb-titlebar">
      <div className="imb-titlebar-actions" ref={actionsRef}>
        <button
          type="button"
          className="imb-theme-btn"
          aria-label={t("Theme")}
          title={t("Theme")}
          aria-expanded={themeOpen}
          onClick={() => setThemeOpen((open) => !open)}
        >
          <svg className="imb-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="5.2" fill="none" {...stroke} />
            <circle cx="8" cy="3.4" r="1.3" fill="currentColor" />
            <circle cx="12.4" cy="6.6" r="1.3" fill="currentColor" />
            <circle cx="10.7" cy="11.6" r="1.3" fill="currentColor" />
            <circle cx="5.3" cy="11.6" r="1.3" fill="currentColor" />
            <circle cx="3.6" cy="6.6" r="1.3" fill="currentColor" />
          </svg>
        </button>
        {themeOpen && (
          <div className="imb-theme-pop" role="dialog" aria-label={t("Theme")}>
            <div className="imb-theme-modes">
              {(["light", "dark", "system"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cls(
                    "imb-theme-mode",
                    theme.mode === mode && "imb-is-active",
                  )}
                  onClick={() => void setTheme({ mode })}
                >
                  {t(MODE_LABELS[mode])}
                </button>
              ))}
            </div>
            <div className="imb-theme-swatches">
              {THEME_COLORS.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  className={cls(
                    "imb-theme-swatch",
                    theme.color === color.hex && "imb-is-active",
                  )}
                  style={{ background: color.hex }}
                  aria-label={color.id}
                  title={color.id}
                  onClick={() => void setTheme({ color: color.hex })}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {!IS_MAC && (
        <div className="imb-winbtns">
          <WindowButton
            label="Minimize"
            onClick={() => void imb.windowControls.minimize()}
          >
            <svg className="imb-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h10" {...stroke} />
            </svg>
          </WindowButton>
          <WindowButton
            label={maximized ? "Restore" : "Maximize"}
            onClick={() => void imb.windowControls.toggleMaximize()}
          >
            {maximized ? (
              <svg className="imb-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="6"
                  y="3"
                  width="7"
                  height="7"
                  fill="none"
                  {...stroke}
                />
                <rect
                  x="4"
                  y="5"
                  width="7"
                  height="7"
                  fill="var(--imb-bg)"
                  {...stroke}
                />
              </svg>
            ) : (
              <svg className="imb-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="4"
                  y="4"
                  width="8"
                  height="8"
                  fill="none"
                  {...stroke}
                />
              </svg>
            )}
          </WindowButton>
          <WindowButton
            label="Close"
            onClose
            onClick={() => void imb.windowControls.close()}
          >
            <svg className="imb-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" {...stroke} />
            </svg>
          </WindowButton>
        </div>
      )}
    </header>
  );
}

interface WindowButtonProps {
  label: string;
  /** Marks the close button for the danger hover state. */
  onClose?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}

function WindowButton({
  label,
  onClose,
  className,
  onClick,
  children,
}: WindowButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cls("imb-winbtn", className, onClose && "imb-close")}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
