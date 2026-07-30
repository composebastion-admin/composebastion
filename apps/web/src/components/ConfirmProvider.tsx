import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  verificationText?: string;
  verificationLabel?: string;
};

type ConfirmState = ConfirmOptions & {
  resolve: (confirmed: boolean) => void;
  returnFocus: HTMLElement | null;
};

type ConfirmContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [verificationValue, setVerificationValue] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const verificationInputRef = useRef<HTMLInputElement | null>(null);
  const lastPointerTriggerRef = useRef<{ element: HTMLElement; timestamp: number } | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    const recentPointerTrigger = lastPointerTriggerRef.current;
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const returnFocus = recentPointerTrigger
      && Date.now() - recentPointerTrigger.timestamp < 2_000
      && document.contains(recentPointerTrigger.element)
      ? recentPointerTrigger.element
      : activeElement;
    setVerificationValue("");
    setState({ ...options, resolve, returnFocus });
  }), []);

  const close = useCallback((confirmed: boolean) => {
    state?.resolve(confirmed);
    setState(null);
  }, [state]);

  useEffect(() => {
    function rememberPointerTrigger(event: PointerEvent) {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])")
        : null;
      if (target) lastPointerTriggerRef.current = { element: target, timestamp: Date.now() };
    }
    function rememberKeyboardInteraction() {
      lastPointerTriggerRef.current = null;
    }
    document.addEventListener("pointerdown", rememberPointerTrigger, true);
    document.addEventListener("keydown", rememberKeyboardInteraction, true);
    return () => {
      document.removeEventListener("pointerdown", rememberPointerTrigger, true);
      document.removeEventListener("keydown", rememberKeyboardInteraction, true);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const activeIndex = document.activeElement instanceof HTMLElement
        ? focusable.indexOf(document.activeElement)
        : -1;
      const nextIndex = activeIndex < 0
        ? event.shiftKey ? focusable.length - 1 : 0
        : event.shiftKey
          ? (activeIndex - 1 + focusable.length) % focusable.length
          : (activeIndex + 1) % focusable.length;
      event.preventDefault();
      focusable[nextIndex]!.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state, close]);

  useEffect(() => {
    if (!state) return;
    window.requestAnimationFrame(() => {
      if (state.verificationText) verificationInputRef.current?.focus();
      else if (state.tone === "danger") cancelButtonRef.current?.focus();
      else confirmButtonRef.current?.focus();
    });
    return () => {
      const returnFocus = state.returnFocus;
      window.setTimeout(() => {
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
      }, 0);
    };
  }, [state]);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state && (
        <div className="modalBackdrop" role="presentation" onClick={() => close(false)}>
          <div
            ref={dialogRef}
            className="confirmDialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-title">{state.title}</h3>
            <p id="confirm-message">{state.message}</p>
            {state.verificationText && (
              <label className="confirmVerification">
                <span>{state.verificationLabel ?? `Type ${state.verificationText} to continue`}</span>
                <input
                  ref={verificationInputRef}
                  value={verificationValue}
                  onChange={(event) => setVerificationValue(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
            <div className="confirmActions">
              <button ref={cancelButtonRef} type="button" onClick={() => close(false)}>{state.cancelLabel ?? "Cancel"}</button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={state.tone === "danger" ? "danger" : "primary"}
                disabled={Boolean(state.verificationText && verificationValue !== state.verificationText)}
                onClick={() => close(true)}
              >
                {state.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error("useConfirm must be used within ConfirmProvider");
  return context;
}
