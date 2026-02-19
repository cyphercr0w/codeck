import { activeSection, wsConnected, setActiveSection, type Section } from '../state/store';
import { IconHome, IconFolder, IconTerminal, IconBot, IconPlug, IconSettings, IconShield, IconBrain, IconBridge, IconChevronLeft, IconChevronRight } from './Icons';
import { NAV_ITEMS } from './nav-items';

const SECTION_ICONS: Record<Section, () => preact.JSX.Element> = {
  home: () => <IconHome size={18} />,
  filesystem: () => <IconFolder size={18} />,
  claude: () => <IconTerminal size={18} />,
  agents: () => <IconBot size={18} />,
  integrations: () => <IconPlug size={18} />,
  config: () => <IconBrain size={18} />,
  settings: () => <IconSettings size={18} />,
};

interface SidebarProps {
  onSectionChange: (section: Section) => void;
  mobileOpen: boolean;
  onClose: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ onSectionChange, mobileOpen, onClose, collapsed, onToggleCollapse }: SidebarProps) {
  const connected = wsConnected.value;
  const current = activeSection.value;

  const sidebarClass = `sidebar${mobileOpen ? ' open' : ''}${collapsed ? ' collapsed' : ''}`;

  return (
    <>
      {mobileOpen && <div class="sidebar-backdrop" onClick={onClose} />}
      <aside class={sidebarClass} role="navigation" aria-label="Main navigation">
        <div class={`sidebar-brand${collapsed ? ' collapsed' : ''}`}>
          <div class="sidebar-brand-row">
            <span class="sidebar-brand-logo" aria-hidden="true"><IconBridge size={22} /></span>
            {!collapsed && <span class="sidebar-brand-name">Codeck</span>}
            {!collapsed && (
              <button class="sidebar-collapse-btn" onClick={onToggleCollapse} aria-label="Collapse sidebar">
                <IconChevronLeft size={16} />
              </button>
            )}
          </div>
          {collapsed && (
            <button class="sidebar-collapse-btn" onClick={onToggleCollapse} aria-label="Expand sidebar">
              <IconChevronRight size={16} />
            </button>
          )}
        </div>
        <nav class="sidebar-nav" aria-label="Sections">
          {NAV_ITEMS.map(item => (
            <button
              key={item.section}
              class={`sidebar-item${current === item.section ? ' active' : ''}`}
              onClick={() => {
                setActiveSection(item.section);
                onSectionChange(item.section);
                onClose();
              }}
              aria-label={item.label}
              aria-current={current === item.section ? 'page' : undefined}
            >
              <span class="sidebar-icon" aria-hidden="true">{SECTION_ICONS[item.section]()}</span>
              {!collapsed && item.label}
            </button>
          ))}
        </nav>
        <div class="sidebar-footer">
          <div class="sidebar-status">
            <span class={`status-dot${connected ? ' online' : ''}`} />
            {!collapsed && <span>{connected ? 'Connected' : 'Disconnected'}</span>}
          </div>
          {!collapsed && <div class="sidebar-version">v0.1</div>}
        </div>
      </aside>
    </>
  );
}
