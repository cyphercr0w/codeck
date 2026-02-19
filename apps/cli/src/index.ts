#!/usr/bin/env node

process.on('unhandledRejection', (err) => {
  const message = err instanceof Error ? err.message : String(err);
  const sanitized = message
    .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=***')
    .replace(/token[=:]\s*\S+/gi, 'token=***')
    .replace(/password[=:]\s*\S+/gi, 'password=***')
    .replace(/secret[=:]\s*\S+/gi, 'secret=***')
    .replace(/sk-[a-zA-Z0-9-]{20,}/g, 'sk-***');
  console.error('Fatal error:', sanitized);
  process.exit(1);
});

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { restartCommand } from './commands/restart.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { doctorCommand } from './commands/doctor.js';
import { openCommand } from './commands/open.js';
import { lanCommand } from './commands/lan.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name('codeck')
  .description('CLI tool for managing Codeck Docker sandbox')
  .version(version);

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(doctorCommand);
program.addCommand(openCommand);
program.addCommand(lanCommand);

program.parse();
