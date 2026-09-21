<h1 align="center">dsh-session-trash</h1>

<p align="center">Session deletion and trash management for the DSH Web GUI</p>

<p align="center">Move sessions to trash from the session menu, then restore or permanently delete them in one panel</p>

<p align="center">Retention periods, deletion confirmations, and automatic cleanup — integrated with native settings</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.3-orange" alt="Version 0.1.3" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen" alt="Node.js >= 24" />
  <img src="https://img.shields.io/badge/pnpm-11.19.0-F69220" alt="pnpm 11.19.0" />
</p>

<p align="center"><a href="README.md">简体中文</a> | <strong>English</strong></p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#interface-preview">Interface preview</a> ·
  <a href="#development">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

## Features

- **Session menu**: adds “Move to trash” and “Delete permanently” to the row menu.
- **Trash panel**: inspect deleted sessions, restore them, delete individual entries, or empty the trash.
- **Sidebar access**: a green dot indicates that the trash contains entries, without a numeric badge.
- **Native settings section**: configure retention, confirmation prompts, and automatic expiration cleanup.
- **List synchronization**: hides entries by exact session ID and handles stale rows whose logs no longer exist.

DSH's native “Delete workspace” action removes only the workspace registration and retains the project directory and session logs. This plugin provides session-level trash and physical cleanup. Deleting a workspace never bulk-deletes its sessions; if that workspace no longer exists when a session is restored, the session appears under Ungrouped.

## Interface preview

### Session menu

Move a session to trash or delete it permanently from its “…” menu.

![Move to trash and permanent delete actions in the session menu](docs/images/session-menu.png)

### Trash panel

Review deleted sessions in one place, then restore them, delete them permanently, or empty the trash.

![Session trash with restore, permanent delete, settings, and empty actions](docs/images/trash-panel.png)

### Session deletion settings

Configure trash behavior, retention days, confirmation prompts, and automatic cleanup in DSH's native settings interface.

![DSH session deletion settings](docs/images/settings.png)

## Compatibility

| Component | Current scope |
| --- | --- |
| DSH | The tested DSH version for each plugin release is recorded in its GitHub Release notes |
| Interface | DSH Web GUI; menu detection depends on the Chinese “归档会话” label |
| Node.js | Development baseline: Node.js 24; locally verified with `24.11.0` |
| Package manager | pnpm `11.19.0`, pinned through `packageManager` |
| OS | Isolated tests are verified locally on Windows; GitHub CI covers Windows and Linux |

Menu and toolbar integration uses DOM injection, and identity detection depends partly on React internals. Revalidate after upstream upgrades. This English README does not imply a fully localized English plugin interface.

## Installation

Prerequisite: DSH. Download `dsh-session-trash-<version>.tgz` and `SHA256SUMS.txt` from the project's GitHub Releases page, then verify the archive checksum.

Pass the downloaded archive directly to DSH; manual extraction is not required:

```powershell
dsh plugin --profile trash add "C:\Downloads\dsh-session-trash-0.1.3.tgz"
```

If the profile does not already contain the Web GUI, add it and start DSH:

```powershell
dsh plugin --profile trash add "@deepseek-ai/dsh-web-app@0.1.5-rc.2"
dsh --profile trash --port 3080
```

Open the URL printed by DSH and use its access token as required. Release archives are distributed through GitHub Releases, not npm. See [Development](#development) for source-directory installation.

## Deletion and recovery

| Action | Behavior |
| --- | --- |
| Move to trash | Releases the live runtime and blocks reactivation; logs stay in place and can be restored |
| Move to trash with retention disabled | Requires explicit permanent-delete confirmation before sending that intent |
| Delete permanently from the session menu | Always requires confirmation; releases the live runtime before removing logs and workspace references |
| Empty trash | Processes entries individually; failures remain visible with an explanation |
| Expiration cleanup | Runs at startup and every 30 minutes |
| Restore | Verifies that logs exist, or moves an intact staged directory back before removing the index entry |
| Delete workspace | Keeps DSH's native behavior: removes only the workspace registration and does not bulk-delete sessions |

Requests carry a fixed deletion intent. A policy change in another window cannot turn a soft delete into a permanent one. When deleting the current session, the plugin first tries to open another available session.

Once physical deletion has started, logs may be incomplete. The plugin refuses automatic restoration and retains the entry for a deletion retry instead of reporting a false recovery success. Trashed sessions cannot keep running or reactivate through the AgentFactory, but their logs remain on disk, so clients that do not understand the plugin's trash index may still list them as cold sessions.

### Defaults

| Setting | Default |
| --- | --- |
| Retention enabled | Yes |
| Retention period | 30 days; `0` means forever, maximum 3650 days |
| Confirm move to trash | No |
| Confirm empty trash / individual permanent deletion in trash | Yes |
| Automatic expiration cleanup | Yes |

```text
$DSH_HOME/
├── sessions/                         Original session logs
└── storages/
    ├── dsh_session_trash.json         Policy, trash index, and deletion progress
    └── dsh_session_trash_files/       Staging area for permanent deletion
```

Paths and the cleanup interval are currently defined in code. Runtime deletion policies are changed through the settings section.

## Development

The source directory remains installable for local development:

```powershell
pnpm install --frozen-lockfile
pnpm run check
$pluginPath = (Get-Location).Path
dsh plugin --profile trash add "$pluginPath"
```

Local profiles, test data, build output, and release artifacts are excluded from version control.

```sh
pnpm test                  # Isolated tests only; no live DSH connection
pnpm run test:handlers     # Host endpoint behavior
pnpm run test:store        # File operations, recovery, and concurrency
pnpm run test:client       # Probe scheduling and menu handlers
pnpm run docs:check        # Local documentation links
pnpm run typecheck         # Configured TypeScript check; checkJs=false
pnpm run build             # Build Host and browser artifacts
pnpm run release:prepare   # Create tgz, checksum, and manifest under dist/
pnpm run check             # Default validation and build
```

Full JavaScript type checking is not enabled yet; `typecheck` does not replace behavioral tests. Live-instance tests require separate setup and **are not included in `pnpm test` or CI**.

```text
.github/                   CI, issue forms, and PR template
docs/                      Architecture, testing, and screenshot guides
scripts/                   Build, validation, and test scripts
src/host/                  Index, policies, and HTTP endpoints
src/client/                Menus, trash, settings, and list synchronization
lib/                       Generated artifacts; ignored by version control
```

Further reading: [Architecture](docs/ARCHITECTURE.md) (Chinese) · [Testing](docs/TESTING.md) · [Contributing](CONTRIBUTING.md).

## Uninstall

```sh
dsh plugin --profile trash remove dsh-session-trash
```

Uninstalling does not delete trash data. Soft-deleted sessions whose logs remain in place may reappear without the plugin. Check for recoverable data before removing index or staging files.

## License

[MIT](LICENSE). This is a third-party project, not an official DSH component.
