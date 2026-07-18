import { useState } from 'preact/hooks';
import { SkillsTab } from './agent-config/SkillsTab';
import { McpServersTab } from './agent-config/McpServersTab';
import { RulesTab } from './agent-config/RulesTab';
import { HooksTab } from './agent-config/HooksTab';
import { MemoryTab } from './agent-config/MemoryTab';
import { PermissionsTab } from './agent-config/PermissionsTab';
import { EnvironmentTab } from './agent-config/EnvironmentTab';
import { SubAgentsSection } from './SubAgentsSection';

type Tab = 'memory' | 'skills' | 'subagents' | 'mcp' | 'rules' | 'hooks' | 'permissions' | 'env';

const TABS: { id: Tab; label: string }[] = [
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
  { id: 'subagents', label: 'Sub-Agents' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'rules', label: 'Rules' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'env', label: 'Environment' },
];

export function AgentConfigSection() {
  const [activeTab, setActiveTab] = useState<Tab>('memory');

  return (
    <div class="content-section">
      <div class="ac-container">
        <div class="ac-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              class={`ac-tab${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div class="ac-body">
          {activeTab === 'memory' && <MemoryTab onNavigate={setActiveTab} />}
          {activeTab === 'skills' && <SkillsTab />}
          {activeTab === 'subagents' && <SubAgentsSection embedded />}
          {activeTab === 'mcp' && <McpServersTab />}
          {activeTab === 'rules' && <RulesTab />}
          {activeTab === 'hooks' && <HooksTab />}
          {activeTab === 'permissions' && <PermissionsTab />}
          {activeTab === 'env' && <EnvironmentTab />}
        </div>
      </div>
    </div>
  );
}
