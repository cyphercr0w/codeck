# Codeck Documentation

Technical documentation for the Codeck Sandbox project.

For a project overview and quick start guide, see the root [README](../README.md).

## Contents

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system architecture: process lifecycle, backend/frontend stack, auth flows, WebSocket protocol, PTY management, tunnel system, preset system, Docker infrastructure, container filesystem layout, security model |
| [API.md](API.md) | Every REST endpoint and WebSocket message type with request/response formats and examples |
| [SERVICES.md](SERVICES.md) | Backend service layer: exports, state management, and internal flows for each `services/*.ts` module |
| [FRONTEND.md](FRONTEND.md) | Preact SPA: component tree, signals-based state, view lifecycle, terminal system, CSS architecture |
| [PROACTIVE-AGENTS.md](PROACTIVE-AGENTS.md) | Proactive agents: autonomous scheduled tasks, API, WebSocket events, filesystem layout, configuration |
| [CONFIGURATION.md](CONFIGURATION.md) | Environment variables, Docker build and compose config, volumes, preset system, keyring setup, file permissions |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production deployment: systemd installation on Linux VPS, service management, configuration, troubleshooting |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Bugs, technical debt, and potential improvements found during codebase audit |
