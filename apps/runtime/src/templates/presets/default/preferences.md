# User Preferences

This file is read by the agent at the start of EVERY task. It is the definitive source of truth for how the user wants to work.

Entries are added in two ways:
- **Auto-detected**: The agent observes corrections, patterns, and feedback during conversations and appends entries here automatically.
- **Manual**: The user can edit this file directly via the Codeck Config Viewer.

Rules: Never duplicate entries. If updating an existing preference, replace the old entry in place.

## Language & Communication
<!-- How the user wants to be spoken to -->
<!-- Examples: "Respond in Spanish", "Be concise", "Explain your reasoning" -->

## Code Style
<!-- Formatting, syntax, structural preferences -->
<!-- Examples: "No semicolons in JS/TS", "Use tabs", "Prefer functional components" -->

## Tools & Frameworks
<!-- Which tools to use by default -->
<!-- Examples: "Use pnpm instead of npm", "Prefer Tailwind", "Always use TypeScript" -->

## Workflow
<!-- How the user wants tasks executed -->
<!-- Examples: "Always create a branch before working", "Run tests before committing", "Don't commit without asking" -->

## Project-Specific
<!-- Preferences that apply only to certain projects -->
<!-- Examples: "In api-server, always use port 3001", "In frontend, use Vite" -->
