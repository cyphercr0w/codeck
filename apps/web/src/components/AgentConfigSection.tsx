import { useState } from 'preact/hooks';
import { SkillsTab } from './agent-config/SkillsTab';
import { McpServersTab } from './agent-config/McpServersTab';
import { RulesTab } from './agent-config/RulesTab';
import { HooksTab } from './agent-config/HooksTab';
import { MemoryTab } from './agent-config/MemoryTab';

type Tab = 'skills' | 'mcp' | 'rules' | 'hooks' | 'memory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'rules', label: 'Rules' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: 'Memory' },
];

export function AgentConfigSection() {
  const [activeTab, setActiveTab] = useState<Tab>('skills');

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
          {activeTab === 'skills' && <SkillsTab />}
          {activeTab === 'mcp' && <McpServersTab />}
          {activeTab === 'rules' && <RulesTab />}
          {activeTab === 'hooks' && <HooksTab />}
          {activeTab === 'memory' && <MemoryTab />}
        </div>
      </div>
    </div>
  );
}
