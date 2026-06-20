import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
  /** When this value changes, the boundary clears a previously caught error (e.g. on tab change). */
  resetKey?: unknown;
  /** Heading shown in the fallback. */
  title?: string;
};

type ErrorBoundaryState = { error: Error | null };

/**
 * Catches render-time exceptions so a single failing view shows an inline message
 * instead of unmounting the whole React tree (which renders as a blank/white screen).
 * Styling is intentionally inline so the fallback survives even if app CSS is at fault.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the full error + component stack in the console for diagnosis.
    console.error("[ErrorBoundary] UI crash:", error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const prefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const palette = prefersDark
      ? {
          panel: "#1c160d",
          border: "#6e2c18",
          text: "#f3ede0",
          title: "#f47a58",
          codeBg: "#0c0904",
          codeBorder: "#463a29",
          buttonBg: "#f47a58",
          buttonText: "#281c08"
        }
      : {
          panel: "#faf6ec",
          border: "#e2a78f",
          text: "#271f13",
          title: "#9a2a14",
          codeBg: "#f3ecdc",
          codeBorder: "#c3b599",
          buttonBg: "#9a2a14",
          buttonText: "#faf6ec"
        };
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "32px 16px" }}>
        <div
          style={{
            maxWidth: 560,
            width: "100%",
            background: palette.panel,
            border: `1px solid ${palette.border}`,
            borderRadius: 12,
            padding: 24,
            color: palette.text,
            fontFamily: "\"IBM Plex Sans\", Inter, system-ui, sans-serif"
          }}
        >
          <h3 style={{ margin: "0 0 8px", color: palette.title }}>{this.props.title ?? "Something went wrong"}</h3>
          <p style={{ margin: "0 0 12px" }}>This view failed to render. The other tabs may still work.</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: palette.codeBg,
              border: `1px solid ${palette.codeBorder}`,
              borderRadius: 8,
              color: palette.text,
              padding: 12,
              margin: "0 0 16px",
              fontSize: 12,
              fontFamily: "\"IBM Plex Mono\", \"SFMono-Regular\", Consolas, monospace"
            }}
          >
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: palette.buttonBg,
              color: palette.buttonText,
              border: "none",
              borderRadius: 8,
              padding: "8px 16px",
              cursor: "pointer"
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
