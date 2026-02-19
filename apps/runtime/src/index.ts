#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Claude Sandbox — Docker environment for working with Claude CLI.

USAGE:
  docker compose up                    # Start (webapp at localhost)
  docker compose run --rm sandbox      # Interactive mode

OPTIONS:
  --web         Webapp mode at localhost (default)
  --clone URL   Clone repository on startup
  --help        Show this help
`);
  process.exit(0);
}

const cloneUrl = args.includes('--clone')
  ? args[args.indexOf('--clone') + 1]
  : null;

async function main(): Promise<void> {
  if (cloneUrl) {
    const { cloneRepository } = await import('./services/git.js');
    await cloneRepository(cloneUrl);
  }
  const { startWebServer } = await import('./web/server.js');
  await startWebServer();
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
