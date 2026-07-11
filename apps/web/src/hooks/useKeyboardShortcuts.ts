import { useEffect, useRef } from "react";
import type { Tab } from "../lib/navigation.js";

export function useKeyboardShortcuts({
  setTab,
  refresh,
  hasHost,
  allowedTabs
}: {
  setTab: (tab: Tab) => void;
  refresh: () => void | Promise<void>;
  hasHost: boolean;
  allowedTabs?: ReadonlySet<Tab>;
}) {
  const sequenceTimer = useRef<number | null>(null);
  const inSequence = useRef<boolean>(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Ignore if user is inside an input field
      const active = document.activeElement;
      if (active) {
        // Once xterm owns focus every key, including Escape, belongs to the
        // remote shell. The terminal drawer has an explicit labelled close
        // button and intentionally does not use Escape as a global shortcut.
        if (active instanceof HTMLElement && active.closest(".hostTerminalFrame .xterm")) return;
        const tag = active.tagName.toLowerCase();
        if (
          tag === "input" ||
          tag === "textarea" ||
          tag === "select" ||
          active.getAttribute("contenteditable") === "true"
        ) {
          // Allow Escape to blur inputs
          if (event.key === "Escape") {
            (active as HTMLElement).blur();
          }
          return;
        }
      }

      const key = event.key.toLowerCase();

      // `/` focuses global search
      if (event.key === "/") {
        event.preventDefault();
        const searchInput = document.querySelector(".globalSearch input") as HTMLInputElement | null;
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
        return;
      }

      // `r` refreshes dashboard data
      if (key === "r") {
        event.preventDefault();
        void refresh();
        return;
      }

      // Handle sequences starting with `g`
      if (key === "g") {
        inSequence.current = true;
        if (sequenceTimer.current) window.clearTimeout(sequenceTimer.current);
        sequenceTimer.current = window.setTimeout(() => {
          inSequence.current = false;
        }, 1200); // Wait up to 1.2s for sequence
        return;
      }

      if (inSequence.current) {
        let targetTab: Tab | null = null;
        switch (key) {
          case "o": targetTab = "overview"; break;
          case "a": targetTab = "apps"; break;
          case "c": targetTab = "containers"; break;
          case "i": targetTab = "images"; break;
          case "h": targetTab = "hosts"; break;
          case "s": targetTab = "admin"; break;
        }

        if (targetTab) {
          // Some tabs require active hosts. If there is no host, skip.
          const hostRequired = ["apps", "containers", "images", "files"].includes(targetTab);
          if ((!hostRequired || hasHost) && (!allowedTabs || allowedTabs.has(targetTab))) {
            event.preventDefault();
            setTab(targetTab);
          }
        }

        // Reset sequence
        inSequence.current = false;
        if (sequenceTimer.current) {
          window.clearTimeout(sequenceTimer.current);
          sequenceTimer.current = null;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (sequenceTimer.current) window.clearTimeout(sequenceTimer.current);
    };
  }, [setTab, refresh, hasHost, allowedTabs]);
}
