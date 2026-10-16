import { t } from "@shared/l10n";
import { useEffect, useState } from "react";
import { cls } from "reactutils";
import { appStore, IS_MAC, useApp } from "../../app-store";
import { IconBack, IconForward } from "../icons";
import "./index.css";

const stroke = { stroke: "currentColor", strokeWidth: 1.4 } as const;

/**
 * Full-width title bar / drag region (row 1 of `.imb-app`).
 * macOS: empty draggable strip; the native traffic lights sit on its left.
 * Windows/Linux: custom small min/max/close buttons on the right (native
 * controls are hidden via the absence of `titleBarOverlay`).
 */
export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);
  const { navHistory, navHistoryIndex } = useApp();
  const canGoBack = navHistoryIndex > 0;
  const canGoForward = navHistoryIndex < navHistory.length - 1;

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
      <div className="imb-titlebar-nav">
        <button
          type="button"
          className="imb-titlebar-navbtn"
          aria-label={t("Back")}
          title={t("Back")}
          disabled={!canGoBack}
          onClick={() => appStore.goBack()}
        >
          <IconBack className="imb-icon imb-sm" />
        </button>
        <button
          type="button"
          className="imb-titlebar-navbtn"
          aria-label={t("Forward")}
          title={t("Forward")}
          disabled={!canGoForward}
          onClick={() => appStore.goForward()}
        >
          <IconForward className="imb-icon imb-sm" />
        </button>
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
