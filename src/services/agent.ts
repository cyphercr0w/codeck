const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '/root/.claude';

export const ACTIVE_AGENT = {
  id: 'claude',
  name: 'Claude',
  command: 'claude',
  flags: { resume: '--resume', continue: '--continue', version: '--version' },
  instructionFile: 'CLAUDE.md',
  configDir: claudeConfigDir,
  credentialsFile: `${claudeConfigDir}/.credentials.json`,
  configFile: '/root/.claude.json',
  settingsFile: `${claudeConfigDir}/settings.json`,
  projectsDir: `${claudeConfigDir}/projects`,
} as const;
