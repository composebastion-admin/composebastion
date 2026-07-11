import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Terminal, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { DockerHost } from "@composebastion/shared";
import { hostTerminalUrl } from "../../lib/hostTerminal.js";
import { terminalPhaseLabel, type HostTerminalPhase } from "../../lib/hostTerminalStatus.js";

export function HostTerminalDrawer({ host, onClose }: { host: DockerHost; onClose: () => void }) {
  const [phase, setPhase] = useState<HostTerminalPhase>("warning");
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const cleanup = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      const previous = previousFocusRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (confirmed) return;
    function handleWarningKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleWarningKeys);
    return () => window.removeEventListener("keydown", handleWarningKeys);
  }, [confirmed]);

  useLayoutEffect(() => {
    if (!confirmed) return;

    setPhase("connecting");
    setError(null);

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0c0904",
        foreground: "#e8b860",
        cursor: "#e0a23f",
        selectionBackground: "#2c2110"
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitRef.current = fitAddon;

    let frameHandle = 0;

    const fitTerminal = () => {
      if (!frameRef.current) return;
      try {
        fitAddon.fit();
      } catch {
        // xterm can reject a fit before fonts/layout have settled; the next scheduled fit will retry.
      }
    };

    const sendTerminalSize = () => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    const scheduleFit = () => {
      window.cancelAnimationFrame(frameHandle);
      frameHandle = window.requestAnimationFrame(() => {
        fitTerminal();
        sendTerminalSize();
        frameHandle = window.requestAnimationFrame(() => {
          fitTerminal();
          sendTerminalSize();
        });
      });
    };

    if (frameRef.current) {
      term.open(frameRef.current);
      scheduleFit();
    }

    const socket = new WebSocket(hostTerminalUrl(host.id));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    const sendResize = () => {
      fitTerminal();
      sendTerminalSize();
      scheduleFit();
    };

    socket.addEventListener("open", sendResize);

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as { type?: string; message?: string };
          if (message.type === "ready") {
            setPhase("ready");
            term.focus();
            sendResize();
            return;
          }
          if (message.type === "error") {
            setPhase("error");
            const text = message.message ?? "Failed to open host terminal";
            setError(text);
            term.writeln(`\r\n\x1b[31m${text}\x1b[0m`);
            return;
          }
        } catch {
          term.write(event.data);
        }
        return;
      }
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data);
      term.write(bytes);
    });

    socket.addEventListener("close", () => {
      setPhase((current) => current === "error" ? current : "closed");
      term.writeln("\r\n\r\n[session closed]");
    });

    socket.addEventListener("error", () => {
      setPhase("error");
      setError("WebSocket connection failed");
    });

    term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });

    const onResize = () => sendResize();
    window.addEventListener("resize", onResize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => sendResize());
    if (frameRef.current) observer?.observe(frameRef.current);

    return () => {
      window.cancelAnimationFrame(frameHandle);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      cleanup();
    };
  }, [cleanup, confirmed, host.id]);

  function handleClose() {
    cleanup();
    onClose();
  }

  return (
    <div
      ref={drawerRef}
      className={`drawer hostTerminalDrawer ${confirmed ? "terminalOpen" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Host SSH terminal for ${host.name}`}
      aria-describedby={!confirmed ? "host-terminal-warning" : undefined}
    >
      <div className="panelHeader">
        <div>
          <h3 id="host-terminal-title"><Terminal size={18} /> Host SSH terminal</h3>
          <p>{host.name} · {host.username}@{host.hostname}:{host.port}</p>
          {confirmed && (
            <span
              className={`pill ${phase === "ready" ? "online" : phase === "connecting" ? "unknown" : phase === "closed" ? "offline" : "error"}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {terminalPhaseLabel(phase, host.name)}
            </span>
          )}
        </div>
        <button type="button" onClick={handleClose} title="Close terminal" aria-label="Close host terminal"><X size={18} /></button>
      </div>

      {!confirmed && (
        <div className="hostTerminalWarning">
          <AlertTriangle size={20} />
          <div>
            <strong>Privileged shell access</strong>
            <p id="host-terminal-warning">
              You are about to open an interactive SSH shell on this host. The audit log records your identity, host,
              session timestamps, duration, and byte counts. Command text and terminal output are not captured.
            </p>
          </div>
          <div className="buttonRow">
            <button type="button" className="primary" onClick={() => { setPhase("connecting"); setConfirmed(true); }}>Open shell</button>
            <button ref={cancelRef} type="button" onClick={handleClose}>Cancel</button>
          </div>
        </div>
      )}

      {confirmed && (
        <>
          {error && <div className="notice error" role="alert" aria-live="assertive">{error}</div>}
          <div ref={frameRef} className="hostTerminalFrame" aria-label="Host SSH terminal" />
        </>
      )}
    </div>
  );
}
