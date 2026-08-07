import { Link } from "react-router-dom";
import { hostlessTabs, navigationGroups, tabs, type Tab } from "../../lib/navigation.js";
import { tabPath } from "../../lib/tabRoute.js";
import { useAuthorization } from "../AuthorizationContext.js";

export function SideNavigation({ currentTab, hasHost, onTabChange }: { currentTab: Tab; hasHost: boolean; onTabChange: (tab: Tab) => void }) {
  const { allowedTabs } = useAuthorization();
  return (
    <nav className="sideNav" aria-label="Main navigation">
      <div className="sidebarSectionTitle">Main</div>
      {navigationGroups.map((group) => (
        <div className="sideNavGroup" key={group.title}>
          <span className="sideNavLabel">{group.title}</span>
          {group.items.map((itemId) => {
            if (!allowedTabs.has(itemId)) return null;
            const item = tabs.find((candidate) => candidate.id === itemId);
            if (!item) return null;
            const Icon = item.icon;
            const needsHost = !hasHost && !hostlessTabs.has(item.id);
            return (
              <Link
                key={item.id}
                to={tabPath(item.id)}
                className={`sideNavItem ${currentTab === item.id ? "active" : ""}`}
                aria-disabled={needsHost}
                onClick={(event) => { if (needsHost) event.preventDefault(); else onTabChange(item.id); }}
                title={needsHost ? "Add or restore a host before using this area." : item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {needsHost && <small>Host</small>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
