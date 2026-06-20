import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Terminal, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { DockerHost } from "@dockermender/shared";
import { hostTerminalUrl } from "../../lib/hostTerminal.js";

type DrawerPhase = "warning" | "connecting" | "ready" | "error";

export function HostTerminalDrawer({ host, onClose }: { host: DockerHost; onClose: () => void }) {
  const [phase, setPhase] = useState<DrawerPhase>("warning");
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
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
    <div className={`drawer hostTerminalDrawer ${confirmed ? "terminalOpen" : ""}`} role="dialog" aria-modal="true" aria-label={`Host SSH terminal for ${host.name}`}>
      <div className="panelHeader">
        <div>
          <h3><Terminal size={18} /> Host SSH terminal</h3>
          <p>{host.name} · {host.username}@{host.hostname}:{host.port}</p>
        </div>
        <button type="button" onClick={handleClose} title="Close terminal"><X size={18} /></button>
      </div>

      {!confirmed && (
        <div className="hostTerminalWarning">
          <AlertTriangle size={20} />
          <div>
            <strong>Privileged shell access</strong>
            <p>
              You are about to open an interactive SSH shell on this host. All commands are attributed to your account
              and recorded in the audit log.
            </p>
          </div>
          <div className="buttonRow">
            <button type="button" className="primary" onClick={() => setConfirmed(true)}>Open shell</button>
            <button type="button" onClick={handleClose}>Cancel</button>
          </div>
        </div>
      )}

      {confirmed && (
        <>
          {phase === "connecting" && <div className="notice">Connecting to {host.name}…</div>}
          {error && <div className="notice error">{error}</div>}
          <div ref={frameRef} className="hostTerminalFrame" aria-label="Host SSH terminal" />
        </>
      )}
    </div>
  );
}
