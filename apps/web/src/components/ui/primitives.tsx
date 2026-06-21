import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { statusClassName } from "../../lib/dockerMetrics.js";

export function BetaBadge() {
  return <span className="pill beta" title="Beta workflow">Beta</span>;
}

export function Panel({ title, count, children }: { title: ReactNode; count?: number; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="panelHeader">
        <h3>{title}</h3>
        {typeof count === "number" && <span>{count}</span>}
      </div>
      {children}
    </div>
  );
}

export function InlineForm({ children, onSubmit }: { children: ReactNode; onSubmit: () => Promise<void> | void }) {
  return (
    <form
      className="inlineForm"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      {children}
    </form>
  );
}

export function ButtonRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`buttonRow${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`toolbar${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function CardSection({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="cardSection">
      {(title || aside) && (
        <div className="cardSectionHeader">
          {title && <h4>{title}</h4>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function InlineStatus({ tone = "muted", children }: { tone?: "success" | "warning" | "danger" | "muted"; children: ReactNode }) {
  return <span className={`inlineStatus ${tone}`}>{children}</span>;
}

export type ProgressStep = {
  label: string;
  status: "pending" | "active" | "done" | "failed";
  detail?: string;
};

export function ProgressSteps({ steps }: { steps: ProgressStep[] }) {
  return (
    <ol className="progressSteps">
      {steps.map((step) => (
        <li key={step.label} className={step.status}>
          <span className="progressDot" />
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function EmptyState({ headline, hint, actionLabel, onAction }: { headline: string; hint: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="emptyState">
      <svg viewBox="0 0 120 72" aria-hidden="true">
        <rect x="18" y="18" width="84" height="38" rx="8" />
        <path d="M32 32h24M32 43h38M76 34l6 6 10-12" />
        <circle cx="92" cy="22" r="5" />
      </svg>
      <strong>{headline}</strong>
      <span>{hint}</span>
      {actionLabel && onAction && <button type="button" className="primary" onClick={onAction}><Plus size={16} />{actionLabel}</button>}
    </div>
  );
}

export function SkeletonPanel({ title = "Loading", rows = 4 }: { title?: string; rows?: number }) {
  return (
    <div className="panel skeletonPanel" aria-busy="true" aria-label={title}>
      <div className="panelHeader">
        <span className="skeletonLine skeletonTitle" />
        <span className="skeletonPill" />
      </div>
      <div className="skeletonStack">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="skeletonLine" />
        ))}
      </div>
    </div>
  );
}

export function tableColumnClass(column: string) {
  const normalized = column.toLowerCase();
  if (["cpu", "memory", "disk", "size", "count"].includes(normalized)) return "numericCell";
  if (["ports", "digest", "image", "repository", "url", "address"].includes(normalized)) return "monoCell";
  return "";
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${statusClassName(status)}`}><span className="statusDot" />{status.replace(/_/g, " ")}</span>;
}

type DataTableProps<T extends { id: string }> = {
  rows: T[];
  columns: string[];
  render: (row: T) => ReactNode[];
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectToggle?: (id: string) => void;
  onSelectAllToggle?: () => void;
  compact?: boolean;
  tableClassName?: string;
};

export function DataTable<T extends { id: string }>({
  rows,
  columns,
  render,
  selectable,
  selectedIds,
  onSelectToggle,
  onSelectAllToggle,
  compact = false,
  tableClassName
}: DataTableProps<T>) {
  if (rows.length === 0) {
    return <EmptyState headline="Nothing here yet" hint="ComposeBastion refreshes inventory automatically when hosts are reachable." />;
  }
  const checkboxWidth = compact ? 28 : 40;
  const tableWrapClassName = ["tableWrap", compact ? "compactTableWrap" : "", tableClassName].filter(Boolean).join(" ");
  const tableClass = [compact ? "compactTable" : "", tableClassName].filter(Boolean).join(" ");
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds?.has(row.id));
  return (
    <div className={tableWrapClassName}>
      <table className={tableClass || undefined}>
        <thead>
          <tr>
            {selectable && (
              <th className="tableSelectHeader" style={{ width: `${checkboxWidth}px`, textAlign: "center" }}>
                <input
                  type="checkbox"
                  className="tableSelectCheckbox"
                  checked={allSelected}
                  onChange={onSelectAllToggle}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map((column) => <th key={column} className={tableColumnClass(column)}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {selectable && (
                <td className="tableSelectCell" style={{ width: `${checkboxWidth}px`, textAlign: "center" }}>
                  <input
                    className="tableSelectCheckbox"
                    type="checkbox"
                    checked={selectedIds?.has(row.id) || false}
                    onChange={() => onSelectToggle?.(row.id)}
                    aria-label="Select row"
                  />
                </td>
              )}
              {render(row).map((cell, index) => {
                const column = columns[index] ?? "";
                const className = [tableColumnClass(column), column.toLowerCase() === "error" ? "errorCell" : ""].filter(Boolean).join(" ") || undefined;
                return <td key={`${row.id}-${index}`} className={className}>{cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VirtualDataTable<T extends { id: string }>({
  rows,
  maxRows = 200,
  ...props
}: DataTableProps<T> & { maxRows?: number }) {
  const visibleRows = rows.slice(0, maxRows);
  return (
    <>
      <DataTable rows={visibleRows} {...props} />
      {rows.length > visibleRows.length && (
        <div className="virtualTableNote">
          Showing newest {visibleRows.length} of {rows.length} rows. Narrow filters or use pagination for older records.
        </div>
      )}
    </>
  );
}
