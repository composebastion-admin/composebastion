import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Tab } from "../lib/navigation.js";
import { tabFromPath, tabPath, tabRequiresHost } from "../lib/tabRoute.js";

export function useDashboardTab(hasHost: boolean, hostsLoaded = true) {
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const tab = tabFromPath(tabParam);

  useEffect(() => {
    if (!tabParam || tabParam !== tab) {
      navigate(tabPath(tab), { replace: true });
    }
  }, [navigate, tab, tabParam]);

  useEffect(() => {
    // Only redirect to settings once hosts have actually loaded — otherwise the
    // brief "no host yet" window during initial load strands the user away from
    // the primary host onboarding surface.
    if (hostsLoaded && !hasHost && tabRequiresHost(tab)) {
      navigate(tabPath("hosts"), { replace: true });
    }
  }, [hostsLoaded, hasHost, navigate, tab]);

  const setTab = useCallback((next: Tab) => {
    navigate(tabPath(next));
  }, [navigate]);

  return { tab, setTab };
}
