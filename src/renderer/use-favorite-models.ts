import { SettingKeys } from "@shared/constants/settings";
import { useCallback, useEffect, useState } from "react";
import { parseFavoriteModels, toggleFavoriteModel } from "./thinking-options";

/**
 * The shared favorite-model list (`provider/id`, oldest first). A ref whose
 * provider is signed out stays stored and shows up again when it returns.
 */
export function useFavoriteModels(): {
  refs: string[];
  toggle: (ref: string) => void;
} {
  const [refs, setRefs] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void imb.settings
      .get(SettingKeys.FavoriteModels)
      .then((raw) => {
        if (alive) setRefs(parseFavoriteModels(raw));
      })
      .catch(() => {
        // The menus still work; nothing is pinned.
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback((ref: string): void => {
    setRefs((current) => {
      const next = toggleFavoriteModel(current, ref);
      void imb.settings
        .set(SettingKeys.FavoriteModels, JSON.stringify(next))
        .catch(() => {
          // Keep the click visible even if the write fails this once.
        });
      return next;
    });
  }, []);

  return { refs, toggle };
}
