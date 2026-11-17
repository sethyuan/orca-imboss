import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { contentPaneRef } from "../../../../app-store";
import { WorkStatusModule } from ".";

/**
 * Keeps the work-status module mounted for the whole session.
 *
 * The boss's requirement: leaving the board (to an agent session or a chat) and
 * coming back must show it exactly as it was left — the focused room, the zoom,
 * the lights. The app's module switch normally unmounts the view (every other
 * module is happy with that), so this host mounts the module *once* and portals
 * it into the content pane itself instead of going through `ActiveModule`.
 *
 * Deliberately scoped to this module: no other module's mounting changes, so
 * nothing else starts paying for a tree it does not need. The cost here is one
 * module subtree plus one WebGL context, and the module hides itself and stops
 * its render loop while another module is active.
 */
export function WorkStatusHost(): React.JSX.Element | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setTarget(contentPaneRef.current);
  }, []);

  if (target === null) return null;
  return createPortal(<WorkStatusModule />, target);
}
