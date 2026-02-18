import type { Section } from '../state/store';

/** Single source of truth for navigation items — used by Sidebar and MobileMenu. */
export const NAV_ITEMS: { section: Section; label: string }[] = [
  { section: 'home', label: 'Home' },
  { section: 'filesystem', label: 'Filesystem' },
  { section: 'claude', label: 'Terminal' },
  { section: 'agents', label: 'Auto Agents' },
  { section: 'integrations', label: 'Integrations' },
  { section: 'config', label: 'Config' },
];
