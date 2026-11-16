import { useEffect, useState } from "react";
import { cls } from "reactutils";
import { IS_MAC } from "../../app-store";
import { ThemeModeSwitch } from "./theme-mode-switch";
import "./index.css";

const stroke = { stroke: "currentColor", strokeWidth: 1.4 } as const;

/**
 * The window's chrome band: grid row 1 of `.imb-app`, spanning the full width.
 *
 * macOS: the native traffic lights sit on its left and the band is otherwise
 * empty. Windows/Linux: custom small min/max/close buttons on the right (native
 * controls are hidden via the absence of `titleBarOverlay`).
 *
 * The theme-mode switch sits at the right end in both cases: last item on macOS,
 * immediately left of the window buttons on Windows/Linux. Both are `no-drag`
 * islands inside a band that drags the window.
 *
 * The band owns its own material (`.imb-chrome` + `.imb-chrome-top`). Because it
 * is a grid row rather than an overlay, the rail below it is a separate box that
 * simply touches it — the two never stack, so the translucent colour is never
 * applied twice.
 */
export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

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
    <header className="imb-titlebar imb-chrome imb-chrome-top">
      <ThemeModeSwitch />
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
