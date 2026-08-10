const interactiveSelector = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

const focusScopeSelector = ".cardSection, .panel, [role='region'], section, main, [role='main']";

export type FocusReturnContext = {
  trigger: HTMLElement | null;
  scope: HTMLElement | null;
  fallback: HTMLElement | null;
};

function isAvailable(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) return false;
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return false;
  if (element.closest("[hidden], [inert], [aria-hidden='true'], [aria-disabled='true']")) return false;
  return element.getClientRects().length > 0;
}

function firstAvailable(root: ParentNode, selector: string, excluded: HTMLElement | null) {
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .find((element) => element !== excluded && isAvailable(element)) ?? null;
}

function firstAvailableByPriority(root: ParentNode, selectors: string[], excluded: HTMLElement | null) {
  for (const selector of selectors) {
    const candidate = firstAvailable(root, selector, excluded);
    if (candidate) return candidate;
  }
  return null;
}

function stableFallbackWithin(scope: HTMLElement | null, trigger: HTMLElement | null) {
  if (!scope?.isConnected) return null;
  return firstAvailableByPriority(
    scope,
    [
      ".cardSectionHeader h1, .cardSectionHeader h2, .cardSectionHeader h3, .cardSectionHeader h4, .cardSectionHeader h5, .cardSectionHeader h6",
      ".panelHeader h1, .panelHeader h2, .panelHeader h3, .panelHeader h4, .panelHeader h5, .panelHeader h6",
      "[role='heading']",
      "h1, h2, h3, h4, h5, h6",
      "[role='status']",
      "[role='toolbar'][aria-label]",
      ".toolbar[aria-label]",
      interactiveSelector
    ],
    trigger
  );
}

function focusElement(element: HTMLElement | null, requireInteractive: boolean) {
  if (!isAvailable(element)) return false;
  if (requireInteractive && !element.matches(interactiveSelector)) return false;

  const needsTemporaryTabIndex = !element.matches(interactiveSelector) && !element.hasAttribute("tabindex");
  if (needsTemporaryTabIndex) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
  if (document.activeElement !== element) {
    if (needsTemporaryTabIndex) element.removeAttribute("tabindex");
    return false;
  }
  if (needsTemporaryTabIndex) {
    element.addEventListener("blur", () => {
      if (element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
    }, { once: true });
  }
  return true;
}

export function captureFocusReturn(trigger: HTMLElement | null): FocusReturnContext {
  const scope = trigger?.closest<HTMLElement>(focusScopeSelector)
    ?? document.querySelector<HTMLElement>("main, [role='main']");
  return {
    trigger,
    scope,
    fallback: stableFallbackWithin(scope, trigger)
  };
}

export function restoreAccessibleFocus(context: FocusReturnContext) {
  if (focusElement(context.trigger, true)) return context.trigger;

  const globalFallbacks = [
    context.fallback,
    stableFallbackWithin(context.scope, context.trigger),
    document.querySelector<HTMLElement>("main .topbar h2, [role='main'] .topbar h2"),
    document.querySelector<HTMLElement>("main h1, main h2, main h3, [role='main'] h1, [role='main'] h2, [role='main'] h3"),
    document.querySelector<HTMLElement>(".sideNavItem.active:not([aria-disabled='true'])"),
    firstAvailable(document, interactiveSelector, context.trigger),
    document.querySelector<HTMLElement>("main, [role='main'], #root")
  ];
  for (const candidate of globalFallbacks) {
    if (focusElement(candidate, false)) return candidate;
  }
  return null;
}

export function scheduleFocusRestoration(
  context: FocusReturnContext,
  options: { afterRender?: boolean } = {}
) {
  const restore = () => window.setTimeout(() => {
    restoreAccessibleFocus(context);
  }, 0);
  if (options.afterRender) {
    window.requestAnimationFrame(restore);
  } else {
    restore();
  }
}
