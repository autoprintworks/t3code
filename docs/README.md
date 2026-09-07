# T3 Code docs

## Using T3 Code

- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Skills](./user/skills.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [Any ACP agent](./user/external-acp-agents.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on T3 Code

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Worker threads](./internals/acp-worker-threads.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [CI gates](./internals/ci.md)

### Runbooks

- [Release](./operations/release.md)
- [Fork Windows build](./operations/fork-windows-build.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
