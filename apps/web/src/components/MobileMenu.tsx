import { activeSection, wsConnected, setActiveSection, type Section } from '../state/store';
import { IconHome, IconFolder, IconTerminal, IconBot, IconPlug, IconSettings, IconShield, IconBrain } from './Icons';
import { NAV_ITEMS } from './nav-items';

const SECTION_ICONS: Record<Section, () => preact.JSX.Element> = {
  home: () => <IconHome size={22} />,
  filesystem: () => <IconFolder size={22} />,
  claude: () => <IconTerminal size={22} />,
  agents: () => <IconBot size={22} />,
  integrations: () => <IconPlug size={22} />,
  config: () => <IconBrain size={22} />,
  settings: () => <IconSettings size={22} />,
};

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  onSectionChange: (section: Section) => void;
}

export function MobileMenu({ open, onClose, onSectionChange }: MobileMenuProps) {
  const current = activeSection.value;
  const connected = wsConnected.value;

  return (
    <>
      <div class={`mobile-menu-backdrop${open ? ' visible' : ''}`} onClick={onClose} />
      <div class={`mobile-menu${open ? ' open' : ''}`}>
        <nav class="mobile-menu-nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.section}
              class={`mobile-menu-item${current === item.section ? ' active' : ''}`}
              onClick={() => {
                setActiveSection(item.section);
                onSectionChange(item.section);
                onClose();
              }}
            >
              <span class="mobile-menu-icon">{SECTION_ICONS[item.section]()}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div class="mobile-menu-footer">
          <span class={`status-dot${connected ? ' online' : ''}`} />
          <span>{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>
    </>
  );
}
