# CoAgent8 - MCP bridge to coding CLIs

**Second opinions and Git reviews from local coding agents, inside your chat.**

By [Oktawian Wybieralski](https://oki.dev)

[![Website: oki.dev](https://img.shields.io/badge/%F0%9F%8C%90%20website-oki.dev-0078D4?style=flat)](https://oki.dev)
[![Source: GitHub](https://img.shields.io/badge/source-GitHub-0078D4?style=flat&logo=github)](https://github.com/oktawianwybieralski/coagent8)
[![Issues: report a problem](https://img.shields.io/badge/issues-report_a_problem-0078D4?style=flat&logo=github)](https://github.com/oktawianwybieralski/coagent8/issues)\
[![Status: preview](https://img.shields.io/badge/status-preview-F59E0B?style=flat)](#known-limitations)
![MCP: stdio](https://img.shields.io/badge/MCP-stdio-6E40C9?style=flat&logo=modelcontextprotocol)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5FA04E?style=flat&logo=nodedotjs&logoColor=white)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-3DA639?style=flat)](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/LICENSE)

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
5. Run **CoAgent8: Set Up Coding CLIs** to check, install or sign in to a CLI.
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

| Setting | Default | Purpose |
| --- | --- | --- |
| `coagent8.nodePath` | `node` | Node.js 24+ executable used to start the bundled MCP server; machine-scoped |

If Node.js is unavailable on PATH, set an absolute executable path in VS Code's
settings. For example, on Windows:

```json
{
  "coagent8.nodePath": "C:\\Program Files\\nodejs\\node.exe"
}
```

Backend defaults, routing and model consent belong to the server configuration,
normally `~/.coagent8/config.json`. The extension does not provide a model picker
or a separate backend settings UI. See the
[runtime configuration reference](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/RUNTIME_CONTRACT.md#configuration-and-routing).

Press `F1` (or `Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), type `CoAgent8` and
select a command:

| Command | What it does | Changes |
| --- | --- | --- |
| **CoAgent8: Set Up Coding CLIs** | Checks Codex CLI, Claude Code CLI and Antigravity CLI; offers installation and sign-in for the CLIs you select | Installs only what you choose; registers no MCP server |
| **CoAgent8: Refresh CLI Status** | Checks versions, required controls and local sign-in again; **Show Details** opens the `CoAgent8 Setup` output | None |
| **CoAgent8: Register or Repair Native Chat Hosts** | Optionally adds CoAgent8 to the selected CLIs' own MCP configuration after a confirmation | Writes the selected hosts' configuration, with private backups |
| **CoAgent8: Preview and Remove Owned Registrations** | Previews the CoAgent8 registrations it owns and removes them after a confirmation | Removes only unchanged CoAgent8-owned entries |

**CoAgent8: Set Up Coding CLIs** opens its list at once and fills it when the
checks finish. Existing CLIs are reused: Codex and Claude Code from their vendor
extensions (including custom extension roots), and Antigravity CLI from the copy
the Google Antigravity extension downloads to `~/.gemini/bin`. For a missing CLI
you choose **Install Vendor Extension** or **Install Standalone CLI** (the
vendor's official installer). Every CLI stays in its vendor's own location;
CoAgent8 does not download or store CLI binaries. After an extension install the
command waits until the CLI is found; standalone installer commands are inserted
in a terminal without execution, so press Enter, then choose **Check Now**, or
**Reload Window** if the installer changed PATH. Sign-in commands are offered the
same way. At least one compatible signed-in CLI is needed for useful execution.
Sign-in is read from each CLI's own silent check (for Antigravity CLI, the check
the Google Antigravity extension uses); it never starts a login or a model turn.

Installation/check selections do not register external MCP servers. Optional
**CoAgent8: Register or Repair Native Chat Hosts** has a separate selection and
confirmation. The VS Code MCP provider works independently. Existing manual
registrations and unrelated settings are preserved.

Before uninstalling the VSIX, use **CoAgent8: Preview and Remove Owned
Registrations**, or run `coagent8 cleanup` for a preview and
`coagent8 cleanup --apply=<preview-token>` to apply it. Only unchanged entries
with recorded ownership are removed. Private backups and runtime files are
retained; edited/manual entries, histories, credentials, other servers and vendor
extensions survive. Restart native hosts to refresh their cached catalogs.
Uninstalling the VSIX or restarting alone does not remove external registrations.
No production command deletes VS Code profile databases or cache tables.

External-client setup is unavailable on remote extension hosts. In a multi-root
window, use `coagent8 setup` from the intended project directory instead.
Details are in the
[integration guide](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/VSCODE_INTEGRATION.md).

## Privacy and model approval

The selected backend CLI processes the supplied prompt and workspace context
using its configured provider. This is not an offline inference extension.
Public answers redact recognized credential formats; diagnostics also redact
home paths and sensitive configuration patterns. Redaction cannot guarantee
that arbitrary private source content is removed.

Public conversation history is stored locally under `~/.coagent8` by default.
Archival is best-effort. `coagent8_HISTORY=off` disables archive files, while
session records and execution leases remain required. Retention and storage
bounds are specified in the
[runtime contract](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/RUNTIME_CONTRACT.md#4-sessions-events-and-archival-history).

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
| A standalone client cannot see CoAgent8 | Run the setup command for that client; the VS Code provider alone does not register it there |

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
- The welcome notification appears on activation until a CLI is ready or you
  choose **Don't Show Again**. Dismissal and remembered CLI choices survive
  uninstall/reinstall in VS Code's stored state.

Use **CoAgent8: Open Configuration (config.json)** to edit backend defaults and
model consent. The file remains the single source of truth. The machine-scoped
VS Code setting `coagent8.configPath` selects an absolute path or `~/...`; empty
uses `coagent8_CONFIG` or `~/.coagent8/config.json`. This path is used for editing,
the VS Code MCP provider and new native-host registrations. Models and consent
are not duplicated as VS Code settings. Schema completion/validation covers
the ordinary path; newly created files include a `$schema` association.
This command creates defaults only when the file is missing and preserves
existing contents, including invalid JSON that needs repair. Existing custom
files need a `$schema` association if they do not already have one.

Installation/update/uninstall uses the native Extensions view **Restart Extensions**
action when VS Code requests it. **Developer: Restart Extension Host** is a different
operation and does not apply added/removed extensions. CoAgent8 does not force a
window reload. Node/config-path and MCP-definition changes refresh the provider;
use **MCP: List Servers** to restart the CoAgent8 server. Bundled-server identity
also changes when a replacement VSIX keeps the same version number. Restart
separate native chat hosts when their registrations changed.

Track current behavior in the
[runtime contract](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/RUNTIME_CONTRACT.md)
and remaining acceptance in the
[roadmap](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/ROADMAP.md).

## Updates, support and license

Development VSIX files use a numeric VS Code version and its pre-release marker;
the bundled server retains its full npm prerelease version. Restart the MCP
server after replacing a development VSIX. The **Changelog** tab contains the
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
