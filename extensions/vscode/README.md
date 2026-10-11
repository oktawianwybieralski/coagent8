# CoAgent8 - MCP bridge to coding CLIs

**Second opinions and Git reviews from local coding agents, inside your chat.**

By [Oktawian Wybieralski](https://oki.dev)

[![Website: oki.dev](https://img.shields.io/badge/%F0%9F%8C%90%20website-oki.dev-0078D4?style=flat)](https://oki.dev)
[![Source: GitHub](https://img.shields.io/badge/source-GitHub-0078D4?style=flat&logo=github)](https://github.com/oktawianwybieralski/coagent8)
[![Issues: report a problem](https://img.shields.io/badge/issues-report_a_problem-0078D4?style=flat&logo=github)](https://github.com/oktawianwybieralski/coagent8/issues)\
[![Status: preview](https://img.shields.io/badge/status-preview-F59E0B?style=flat)](#known-limitations)
![MCP: stdio](https://img.shields.io/badge/MCP-stdio-6E40C9?style=flat&logo=modelcontextprotocol)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5FA04E?style=flat&logo=nodedotjs&logoColor=white)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-3DA639?style=flat)](https://github.com/oktawianwybieralski/coagent8/blob/develop/LICENSE)

CoAgent8 connects VS Code's native MCP chat to **OpenAI Codex**, **Claude Code**
and **Google Antigravity** (`agy`). Ask another agent to examine a design,
investigate a bug or review a Git diff, then continue the discussion using the
returned session. Your chat remains in VS Code; the selected local CLI performs
the consultation or review.

This extension bundles the CoAgent8 MCP server. You do not need a separate global
CoAgent8 installation. Backend coding CLIs and their authentication are installed
separately. CoAgent8 also works with other stdio MCP hosts; VS Code is an optional
integration.

> **Development preview:** this VSIX is for testing. It is not an accepted
> production release. See [Known limitations](#known-limitations) before use.

## What you can do

- Get a second opinion on architecture, debugging or a proposed implementation.
- Review current workspace changes; staged/revision scopes require matching files.
- Inspect backend availability, authentication evidence, models and quota.
- Continue an agent conversation and read its archived public messages.
- Cancel a known active session or prepare a sanitized bug report.
- Optionally connect selected local standalone chat clients using the setup command.

## Requirements

| Requirement | Details |
| --- | --- |
| VS Code | Version 1.101 or newer, with a chat agent that can call MCP tools |
| Node.js | Version 24 or newer, available to the extension host |
| Workspace | A trusted folder on a filesystem; virtual workspaces are unsupported |
| Backend CLI | At least one installed and authenticated CLI: `codex`, `claude` or `agy` |
| Claude Code | Version 2.1.289 or newer for the restricted execution profile |

Backend access and billing follow your CLI account or API configuration. The
extension does not include model access or sign you in to a backend.

For SSH or WSL, install the extension in the workspace's remote extension host.
Node.js and the backend CLIs must be available and authenticated there.

## Quick start

1. Open the Command Palette and run **Extensions: Install from VSIX...**.
   Select the development VSIX supplied for testing.
2. Open a trusted project folder. If prompted, reload VS Code.
3. Run **MCP: List Servers**, select **CoAgent8**, and start the server.
   Follow VS Code's server trust and tool approval prompts.
4. Open a chat agent that supports MCP tools and enable CoAgent8's tools in its
   tool picker if necessary.
5. Run **CoAgent8: Manage Coding CLIs** to check, install or sign in to a CLI.
   Ask: **"Use CoAgent8 doctor to check the coding agents available for this
   workspace."** Resolve any missing CLI or authentication reported there.
6. Ask for a consultation or review using one of the examples below.

VS Code starts and stops the bundled MCP server. The extension registers its
provider during activation; it does not start an additional background server.
An existing manual CoAgent8 registration in the active profile or workspace
takes precedence over the provider.

## Example chat requests

You can ask in ordinary language; your chat agent supplies the tool arguments.
Name a backend when you want a specific agent.

> Use CoAgent8 consult with Codex to assess this retry strategy. Focus on
> concurrent writers and explain the failure cases.

> Use CoAgent8 review with Claude to review my uncommitted changes. Check error
> handling and compatibility, and cite the affected files.

> Ask Antigravity through CoAgent8 for a second opinion on this module design.
> Use the gemini backend.

> Continue the previous CoAgent8 session and ask how the proposed fix handles
> cancellation.

Consultation and implementation analysis propose changes within the backend's
read-only execution profile. A review's `READY` verdict is an agent conclusion;
it does not independently certify test results or release readiness.

## Available tools

Every MCP host receives the same six advertised tools.

| Tool | Purpose |
| --- | --- |
| `consult` | Ask a question or request architecture, debugging or implementation analysis |
| `review` | Review a Git snapshot with optional review instructions |
| `doctor` | Check installation, versions, auth evidence, models, efforts and quota; request full detail when needed |
| `session` | List sessions, page archived history or close a session |
| `cancel` | Cancel the active turn of a known session handle |
| `issue` | Prepare a sanitized report and prefilled issue link; it does not submit an issue |

Consultation and review return Markdown with the answer, backend, model,
duration and session handle where available. Pass that handle to continue the
conversation. The chat host controls tool visibility, progress and approvals.

## Settings and commands

Run **CoAgent8: Open Settings** or search for `CoAgent8` in VS Code's Settings.
Every setting is user-only (machine-scoped): a workspace cannot change backends,
models or approval rules.

| Setting | Default | Purpose |
| --- | --- | --- |
| `coagent8.defaultBackend` | `auto` | Backend used when a request names none; `auto` chooses among the allowed backends |
| `coagent8.routing.allowedBackends` | all three | Backends CoAgent8 may run (`agy` is Antigravity CLI) |
| `coagent8.routing.strategy` | `fixed` | `fixed` uses the default backend; `smart_quota` prefers a backend with quota left |
| `coagent8.codex.defaultModel`, `coagent8.claude.defaultModel`, `coagent8.agy.defaultModel` | empty | Model when a request names none; empty uses config.json, then the CLI default |
| `coagent8.approval.askAbovePrice` | `20` | Ask for approval before a model costing at least this many USD per million output tokens (`null` in config.json disables it) |
| `coagent8.approval.priceMultiplier` | `2` | Ask for approval before a model costing at least this many times the backend's default model |
| `coagent8.approval.alwaysAskModels` | `[]` | Models that always need approval |
| `coagent8.approval.neverAskModels` | `[]` | Models that run without asking, unless also in Always Ask Models |
| `coagent8.configPath` | empty | Configuration file; empty uses `~/.coagent8/config.json`, shared with the CLI |
| `coagent8.nodePath` | `node` | Node.js 24+ executable used to start the bundled MCP server |

A setting you change in VS Code takes precedence over the same option in the
configuration file; a setting left at its default keeps the file value. The two
model lists are added to the file's lists, and an approval with "remember" is
saved in the file. A changed setting changes the server definition: VS Code stops
a running CoAgent8 server and starts it again on the next use, so no manual
restart is needed.

### Where the extension keeps data

The configuration file is `~/.coagent8/config.json`, the same file the standalone
`coagent8` CLI and other MCP hosts read, so one configuration applies everywhere.
Uninstalling keeps it, like VS Code settings. Everything else the extension
creates (onboarding choices, sessions, history and caches) stays in its VS Code
global storage (`globalStorage/okidev.coagent8-mcp`). VS Code deletes this folder
when the extension is uninstalled. Unchanged native-host registrations the
extension wrote are removed on uninstall, as described under the commands below.
CLI sign-ins, registrations made outside the extension and the CLI's own data in
`~/.coagent8` are kept.

If Node.js is unavailable on PATH, set an absolute executable path in VS Code's
settings. For example, on Windows:

```json
{
  "coagent8.nodePath": "C:\\Program Files\\nodejs\\node.exe"
}
```

See the
[runtime configuration reference](https://github.com/oktawianwybieralski/coagent8/blob/develop/docs/ARCHITECTURE.md#configuration-and-routing)
for the configuration file.

Press `F1` (or `Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), type `CoAgent8` and
select a command:

| Command | What it does | Changes |
| --- | --- | --- |
| **CoAgent8: Open Settings** | Opens CoAgent8's settings in VS Code's Settings editor | None |
| **CoAgent8: Open Configuration (config.json)** | Opens the configuration file, creating defaults only when absent | Creates a missing file; preserves existing contents |
| **CoAgent8: Reset Configuration (config.json)** | Replaces the configuration file with the defaults after a confirmation | Saves the previous file as `config.json.backup`, replacing an earlier backup; keeps VS Code settings |
| **CoAgent8: Show MCP Servers** | Opens VS Code's **MCP: List Servers**, where CoAgent8 is started, stopped or restarted | None |
| **CoAgent8: Manage Coding CLIs** | Lists the three CLIs with their state and chat entry; choose one for its actions: sign in, add CoAgent8 to its chat, install, switch installation, choose an executable, manage skills, remove | Changes only what you choose; writes the CLIs' configuration with private backups; removes only unchanged CoAgent8-owned entries and what CoAgent8 installed |
| **CoAgent8: Manage Skills** | Three steps with Back: a CLI (with its package counts), an action that has packages to change, then the packages |  Keeps the CLI and MCP connection; persists choices through repair/update; preserves edited or foreign packages |

The first activation checks the CLIs once and shows one notice: the ready CLIs,
with **Manage CLIs** when another CLI is missing or signed out, or a ready one does
not have CoAgent8 in its own chat yet, or only an offer to set up a CLI. Later
starts of VS Code run no check. After an update, CLI chats that still start the
previous CoAgent8 are offered once: **Update CLI Chats** updates them directly.

**CoAgent8: Manage Coding CLIs** lists Codex CLI, Claude Code CLI and Antigravity
CLI, installed or not. It opens at once and fills when the checks finish, in about
a second. Each line shows the CLI's state (ready with its version, sign-in needed,
not installed, with an icon) and whether CoAgent8 is in its own chat, and under it
the installation in use. VS Code chat uses CoAgent8
through its own provider either way; "its own chat" means the chats of Codex, Claude Code and Antigravity (their
VS Code extensions and terminal sessions). When there is something to do, the list
ends with **Add CoAgent8 to All CLI Chats** and **Update CoAgent8 in All CLI
Chats**. The title bar checks again and shows the details in the `CoAgent8 Setup`
output.

Choosing a CLI opens its menu, with its state in the title. Its sections list
only what applies, each line with an icon and a short description. **Back**
returns to the list; the menu reopens with fresh checks after each action, so the
next step is shown at once:

- **Installations**: every installation found, the one in use marked. Choosing
  another one selects it; a selected file that is missing is shown. **Use
  Automatic Discovery** removes the selection when its file is missing or
  another installation exists.
- **Install**: **Install VS Code Extension**, the recommended way, and **Install
  Standalone CLI** (the vendor's official installer, which adds its folder to
  your PATH), each while that kind is missing, so a second installation can be
  added beside the first. **Choose Executable** selects a CLI from any folder
  after checking that it is a compatible CLI of that client; a file that fails
  the check leaves the configuration unchanged.
- **Chat**: **Sign In**, **Add CoAgent8 to Its Chat** and **Update CoAgent8 in
  Its Chat**, as the state allows. A manual chat entry is never changed.
- **Skills**: **Manage Skills** for this CLI.
- **Remove**: **Remove CoAgent8 from Its Chat**, and **Uninstall VS Code
  Extension** and **Uninstall Standalone CLI** only for what CoAgent8 installed.

Installations are found without starting them: the vendor extension's copy
(Codex and Claude Code from their VS Code extensions, including custom extension
roots, and Antigravity CLI from the copy the Google Antigravity extension downloads
to `~/.gemini/bin`), every folder on PATH, the official installers' folders
(`~/.local/bin`, `~/.codex/bin`, the npm global folder, on Windows also
`%LOCALAPPDATA%\agy\bin` and Scoop's shims) and the configured file. The disk is
not searched further; use **Choose Executable** for a CLI elsewhere. The official
Antigravity CLI installer uses the Google extension's folder, so without that
extension the copy there is shown as a standalone CLI, and the two are one
installation, not two. A link to the same file, such as the installer's
`%LOCALAPPDATA%\agy\bin` junction, is not a second installation.

A selection is stored as `backends.<id>.executable` in the configuration file
(**CoAgent8: Open Configuration (config.json)**), never in VS Code settings,
because the CLI chats start CoAgent8 without them: an absolute path, a path
starting with `~/`, or `vscode-extension` for the vendor extension's newest copy,
which keeps working after the extension updates. Without a selection the CLI on
PATH is used, then the vendor extension's copy. The first time CoAgent8 is added to
a CLI's chat, setup records the CLI it found there. When an installation is added
while another one is in use, the menu asks whether to use it; one that this window
can start only through its path is selected at once. VS Code chat, the CLI chats
and the `coagent8` CLI with the same file all follow the selection on their next
turn.

Every CLI stays in its vendor's own location; CoAgent8 does not download or store
CLI binaries. A vendor extension is installed for this machine only, so VS Code
does not ask whether Settings Sync should copy it to your other devices; choose
**Sync This Extension** in its gear menu to include it. A
vendor extension or a standalone CLI installed this way is recorded in
`~/.coagent8/installs.json`, so that its removal is offered, also after CoAgent8
was uninstalled and installed again; what you installed yourself is never offered.
A standalone CLI counts once a check finds it, also after a window reload. After an
extension install the menu waits until the CLI is found; installer, removal and
sign-in commands are inserted in a terminal without execution, so press Enter, then
choose **Check Now**, or **Reload Window** if the installer changed PATH. At least
one compatible signed-in CLI is needed for useful execution. Sign-in is read from
each CLI's own silent check (for Antigravity CLI, the check the Google Antigravity
extension uses); it never starts a login or a model turn.

Registrations made here keep CoAgent8's data from those chats in the extension's
storage, which VS Code deletes on uninstall. A change to a CLI chat ends with one
notice. It offers **Restart Extensions** when a vendor chat extension is
installed: it runs **Developer: Restart Extension Host**, because those extensions
load MCP servers only when they start. The VS Code window and chat histories stay;
replies in progress in any chat stop. New terminal sessions see the change without
a restart. An entry CoAgent8 wrote stays its own when its record in
`~/.coagent8/setup.json` is lost: it starts a runtime copy in `~/.coagent8/runtime`
and holds only the fields CoAgent8 writes.

**Uninstall VS Code Extension** shows the extension in the Extensions view, where
you choose VS Code's own **Uninstall** and then **Restart Extensions**, which
applies the removal to every running extension, the chat included, without
reloading the window. No command lets an extension do that restart. Once VS Code
has removed the extension (after the restart, or at the next start), CoAgent8
finishes its part: the record in `installs.json`, a selection of the removed copy,
which moves to the remaining installation or is cleared, and for the Google
Antigravity extension the `~/.gemini/bin/agy.exe` (`agy` outside Windows) it
downloaded and leaves behind. If the extension is still installed at the next
start, the removal is forgotten. CoAgent8's entry in the CLI's chat stays and works
again with another installation. **Uninstall Standalone CLI** inserts the
removal commands in a **Remove** terminal, where you press Enter, then choose
**Check Now**: `npm uninstall -g @openai/codex` for Codex CLI; for Claude Code CLI
the commands of its
[uninstall documentation](https://code.claude.com/docs/en/setup#uninstall-claude-code)
(`~/.local/bin/claude[.exe]` and `~/.local/share/claude`); for Antigravity CLI,
which publishes no uninstall, deletion of its binary: on Windows the
`%LOCALAPPDATA%\agy\bin` link itself, never the other contents of its target, and
`~/.gemini/bin/agy.exe` unless the Google Antigravity extension is installed;
`~/.local/bin/agy` elsewhere. On Windows the installer folders left empty are
deleted with their user PATH entries; the PATH keeps its other entries, their order,
type and unexpanded variables. Elsewhere the installers' shell profile lines stay.
Vendor sign-ins and histories (`~/.codex`, `~/.claude`, `~/.gemini`) stay. A
selection of the removed files moves to the remaining installation or is cleared.

To uninstall CoAgent8, use the Extensions view. On VS Code's next full start the
`vscode:uninstall` hook removes the registrations and skill packages CoAgent8 wrote,
when they are unchanged (recognized by their shape when their record is lost), the
runtime copies nothing references, the private backups written for the extension
and an emptied `~/.coagent8`. It cannot ask, so it removes no CLI or vendor
extension: `installs.json` stays, and **Manage Coding CLIs** offers them after
CoAgent8 is installed again. To remove them first, use the Remove actions above.
Registrations and backups made by the `coagent8` CLI and manual or edited entries
are preserved. To remove registrations without uninstalling, use **Remove CoAgent8
from Its Chat**, or run `coagent8 cleanup` for a preview and
`coagent8 cleanup --apply=<preview-token>` to apply it; both keep private backups
and runtime files. Histories, credentials and other servers survive. VS Code itself
keeps your `coagent8.*` settings after an uninstall. No production command deletes
VS Code profile databases or cache tables.

External-client setup is unavailable on remote extension hosts. In a multi-root
window, use `coagent8 setup` from the intended project directory instead.
Details are in the
[integration contract](https://github.com/oktawianwybieralski/coagent8/blob/develop/docs/ARCHITECTURE.md#optional-integrations).

## Privacy and model approval

The selected backend CLI processes the supplied prompt and workspace context
using its configured provider. This is not an offline inference extension.
Public answers redact recognized credential formats; diagnostics also redact
home paths and sensitive configuration patterns. Redaction cannot guarantee
that arbitrary private source content is removed.

Public conversation history is stored locally in the extension's global storage (the CLI uses `~/.coagent8`).
Archival is best-effort. `coagent8_HISTORY=off` disables archive files, while
session records and execution leases remain required. Retention and storage
bounds are specified in the
[architecture](https://github.com/oktawianwybieralski/coagent8/blob/develop/docs/ARCHITECTURE.md#sessions-and-history).

The server requests user approval through MCP elicitation for models with unknown
or approximate prices, or prices at or above configured thresholds (by default,
20 USD per million output tokens or twice the backend default). Prices come from
OpenRouter's public model list and guide consent, not your actual billing.
Without accepted approval, a model turn that requires consent fails closed.
Host support for the approval form varies; see the limitations below.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| CoAgent8 is absent from the server list | Confirm VS Code 1.101+, a trusted filesystem workspace and the extension's enabled state on the correct local or remote host |
| Server cannot find Node.js | Check `node --version` on the extension host and set `coagent8.nodePath` to its absolute executable path |
| `CLI_NOT_FOUND` or `AUTH_REQUIRED` | Install or authenticate the reported backend on the same machine as the server, then run `doctor` again |
| `POLICY_DENIED` | The model needs approval and the host did not supply it; use a host that supports the form or choose a model allowed by your governance configuration |
| Tools look outdated after an update | Restart CoAgent8 through **MCP: List Servers** and refresh the tool list or start a new chat |
| Duplicate CoAgent8 extensions | Remove old development extensions `oktawianwybieralski.coagent8-mcp` and `oki-dev.coagent8-mcp`; this package uses `okidev.coagent8-mcp` |
| A standalone client cannot see CoAgent8 | Choose it in **CoAgent8: Manage Coding CLIs**, then **Add CoAgent8 to Its Chat**, and restart extensions; the VS Code provider alone does not register it there |

For startup errors, inspect the server output available from VS Code's MCP
controls. For a reproducible problem, ask the chat agent to use `doctor` and
`issue`, then review the generated report before submitting it.

## Known limitations

- Codex disables and verifies inherited MCP tools per thread (measured on 0.162).
  agy still inherits external MCP tools and plugins, an owner-accepted limitation
  of its native sandbox. Doctor names them and CoAgent8 refuses nested turns.
- Review input completeness and release hashes need independent verification.
- Model-approval forms have not been accepted across every chat host. Recorded
  headless and VS Code chat tests include clients that do not show the form.
- Execution timeout bounds the backend phase, not the complete MCP call.
- Remote external-client setup, virtual workspaces and untrusted workspaces
  are unsupported.
- Icons, tool grouping, native plugin loading and existing-chat refresh depend
  on the host. This extension cannot force their presentation.
- Installation and uninstallation were accepted on Windows; update and chat UI
  acceptance remain partial. Package checks do not prove native backend
  readiness or a successful model turn.
- The first-activation notice appears once per installation; uninstalling
  removes that record with the extension's storage.
- **Restart Extensions** restarts every extension: VS Code has no API to restart
  only the vendor chat extensions.

Use **CoAgent8: Open Settings** for backends, models and approval in VS Code, or
**CoAgent8: Open Configuration (config.json)** for the configuration file. The
machine-scoped VS Code setting `coagent8.configPath` selects an absolute path or
`~/...`; empty uses `coagent8_CONFIG`, then `~/.coagent8/config.json`. This path
is used for editing, the VS Code MCP provider and new native-host registrations.
Schema completion/validation covers the default location; newly created files
include a `$schema` association.
This command creates defaults only when the file is missing and preserves
existing contents, including invalid JSON that needs repair. Existing custom
files need a `$schema` association if they do not already have one.

Installation/update uses the native Extensions view **Restart Extensions**
action when VS Code requests it. **Developer: Restart Extension Host** is a different
operation and does not apply added/removed extensions. **Uninstall VS Code
Extension** therefore leaves the removal and that restart to the Extensions view. Changes to CoAgent8 settings and MCP definitions refresh the
provider; VS Code stops a running server whose definition changed and starts it
again on the next use. **MCP: List Servers** (or **CoAgent8: Show MCP Servers**)
also starts, stops and restarts it. Bundled-server identity
also changes when a replacement VSIX keeps the same version number. After CLI
chat registrations change, the notice's **Restart Extensions** reloads the vendor
chat extensions.

Manage Skills shows actual package state and available updates: per CLI in the
first step and in the placeholder of the second. Only actions with packages to
change are offered, and only those packages are listed, all selected. **Back**
returns one step; from a CLI's menu the CLI is already chosen and Back returns to
that menu. Disable retains
an unchanged package outside client discovery in
`~/.coagent8/disabled-skills/<client>/`; enable restores it. Install/update
preserves disabled state. Desired installed/disabled lists are stored in
`backends.<client>.skills` in shared `config.json`; setup and repair honor them.
Cancellation or an empty selection changes nothing. Start a new chat after
changes. Native visibility overrides and other discovered copies remain
effective; shared directory changes can affect VS Code chat too. Interrupted
file changes recover on the next setup/repair/cleanup/apply; edited files are
preserved. Client discovery/refresh acceptance remains pending.

Track current behavior in the
[architecture and runtime contract](https://github.com/oktawianwybieralski/coagent8/blob/develop/docs/ARCHITECTURE.md)
and remaining acceptance in the
[roadmap](https://github.com/oktawianwybieralski/coagent8/blob/develop/docs/ROADMAP.md).

## Updates, support and license

The extension and its bundled server carry the same version as the npm package.
Every version below 1.0.0 is a preview and is marked as a VS Code pre-release;
each preview raises the version, so VS Code offers **Restart Extensions** after
an update. A development VSIX built from an untagged commit repeats the last
version: after replacing it, run **Developer: Restart Extension Host** and restart
the MCP server. The **Changelog** tab contains the
generated CoAgent8 project history, including changes shared with the server.

The extension's identifier is `okidev.coagent8-mcp`. **Oktawian Wybieralski** is
the author; **oki.dev** is the brand and website. The GitHub repository remains
under `oktawianwybieralski`.
Changing the publisher identifier creates a separate extension identity, so an
old development installation is not automatically replaced by this VSIX.
For an unpublished VSIX, VS Code can show the publisher ID `okidev` in the
header. The author's name above is separate from the publisher display name,
which is configured in the Marketplace account.

[Website](https://oki.dev) | [Issues and questions](https://github.com/oktawianwybieralski/coagent8/issues)
| [Source](https://github.com/oktawianwybieralski/coagent8)

Licensed under **GPL-3.0-only**. The VSIX includes `LICENSE` and bundled
dependency notices in `dist/THIRD_PARTY_NOTICES.txt`.
