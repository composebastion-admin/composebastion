export type Theme = "light" | "dark";

const STORAGE_KEY = "dockermender.theme";

export function getInitialTheme(): Theme {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function watchSystemTheme(onChange: (theme: Theme) => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => undefined;
  const handler = () => {
    if (window.localStorage.getItem(STORAGE_KEY)) return;
    onChange(media.matches ? "dark" : "light");
  };
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
