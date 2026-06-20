import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@dockermender/shared";
import { searchScope, type SearchResult } from "../../lib/globalSearch.js";
import { hostName } from "../../lib/hostScope.js";

export function GlobalSearch({
  hosts,
  resources,
  scopedHostIds,
  onPick
}: {
  hosts: DockerHost[];
  resources: ResourceSnapshot[];
  scopedHostIds: string[];
  onPick: (result: SearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => searchScope(hosts, resources, scopedHostIds, query),
    [hosts, resources, scopedHostIds, query]
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function pick(result: SearchResult) {
    onPick(result);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="globalSearch" ref={rootRef}>
      <Search size={16} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        placeholder="Search hosts and resources (⌘K)"
        value={query}
        aria-expanded={open && results.length > 0}
        aria-controls="global-search-results"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && results.length > 0 && (
        <ul className="globalSearchResults" id="global-search-results" role="listbox">
          {results.map((result) => (
            <li key={`${result.kind}-${result.hostId}-${result.kind === "resource" ? result.resourceId : "host"}`}>
              <button type="button" role="option" onClick={() => pick(result)}>
                <strong>{result.label}</strong>
                <span>{result.kind === "host" ? result.detail : `${result.detail} · ${hostName(hosts, result.hostId)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
