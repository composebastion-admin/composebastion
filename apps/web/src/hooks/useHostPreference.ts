import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "composebastion.selectedHostId";

export function useHostPreference(hostIds: string[]) {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(() => window.localStorage.getItem(STORAGE_KEY));

  useEffect(() => {
    if (!hostIds.length) {
      setSelectedHostId(null);
      return;
    }
    if (selectedHostId && hostIds.includes(selectedHostId)) return;
    const fallback = hostIds[0] ?? null;
    setSelectedHostId(fallback);
  }, [hostIds, selectedHostId]);

  const selectHost = useCallback((hostId: string | null) => {
    setSelectedHostId(hostId);
    if (hostId) window.localStorage.setItem(STORAGE_KEY, hostId);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { selectedHostId, setSelectedHostId: selectHost };
}
