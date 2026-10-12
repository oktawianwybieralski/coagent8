# CoAgent8 - MCP bridge to coding CLIs

**Second opinions and Git reviews from another coding agent, inside your chat.**

By [Oktawian Wybieralski](https://oki.dev)

[![Website: oki.dev](https://img.shields.io/badge/%F0%9F%8C%90%20website-oki.dev-0078D4?style=flat)](https://oki.dev)
[![Source: GitHub](https://img.shields.io/badge/source-GitHub-0078D4?style=flat&logo=github)](https://github.com/oktawianwybieralski/coagent8)
[![Issues: report a problem](https://img.shields.io/badge/issues-report_a_problem-0078D4?style=flat&logo=github)](https://github.com/oktawianwybieralski/coagent8/issues)\
[![Status: preview](https://img.shields.io/badge/status-preview-F59E0B?style=flat)](#known-limitations)
![MCP: stdio](https://img.shields.io/badge/MCP-stdio-6E40C9?style=flat&logo=modelcontextprotocol)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5FA04E?style=flat&logo=nodedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-3DA639?style=flat)](https://github.com/oktawianwybieralski/coagent8/blob/develop/LICENSE)

CoAgent8 connects VS Code chat to **OpenAI Codex**, **Claude Code** and
**Google Antigravity** (`agy`). Ask another agent to examine a design,
investigate a bug or review your Git changes, then continue the discussion in
the same session. Your chat stays in VS Code; the other agent runs on your own
installed and signed-in CLI, in a read-only profile.

The extension bundles the CoAgent8 MCP server, so nothing else needs to be
installed except the CLIs themselves. It can also add CoAgent8 to the CLIs' own
chats.

> **Preview.** Versions below 1.0.0 are previews for testers. CoAgent8 reads
> and advises; it does not yet let the other agent write changes. See
> [known limitations](#known-limitations).

## Requirements

| Requirement | Details |
| --- | --- |
| VS Code | 1.101 or newer, with a chat agent that can call MCP tools |
| Node.js | 24 or newer, available to the extension host |
| Workspace | A trusted folder on disk; virtual workspaces are not supported |
| Coding CLI | At least one installed and signed-in CLI: Codex, Claude Code (2.1.289 or newer) or Antigravity |

Model access and billing follow your CLI account. For SSH or WSL, install the
extension on the remote host, where Node.js and the CLIs must be available too.
There the server works in chat, but the CoAgent8 commands are not available:
run `npx -y coagent8@next status` (or `setup`, `repair`, `skills`, `cleanup`) in
that machine's terminal and edit `~/.coagent8/config.json` there.

## Quick start

1. Install the extension. The first start shows one notice with the CLIs it
   found, or an offer to set one up.
2. Run **CoAgent8: Manage Coding CLIs** to install a CLI or sign in, if needed.
3. In **MCP: List Servers**, start **CoAgent8** and accept VS Code's trust
   prompt; enable its tools in the chat's tool picker.
4. Ask: **"Use CoAgent8 doctor with scope health to check the coding agents
   available for this workspace."** Fix anything it reports as missing or signed
   out.
5. Ask for a consultation or a review, as below.

The extension registers CoAgent8 in your user MCP servers (`mcp.json`) so it
appears in **MCP: List Servers**, and VS Code starts and stops the bundled
server itself. A manual CoAgent8 entry in your MCP configuration takes
precedence over the extension's.

## Example requests

Ask in ordinary language; your chat agent fills in the tool arguments. Name a
backend when you want a specific agent.

> Use CoAgent8 consult with Codex to assess this retry strategy. Focus on
> concurrent writers and explain the failure cases.

> Use CoAgent8 review with Claude to review my uncommitted changes. Check error
> handling and compatibility, and cite the affected files.

> Ask Antigravity through CoAgent8 (backend agy) for a second opinion on this
> module design.

> Continue the previous CoAgent8 session and ask how the proposed fix handles
> cancellation.

> Ask CoAgent8, with a model below 1 USD per million output tokens, whether this
> regular expression is safe.

A review's verdict is derived by CoAgent8 from the other agent's findings: an
incomplete review, a serious finding or a failed check makes it `BLOCKED`. It
is still one agent's judgement, not a test run. Repeating a review of the same
unchanged snapshot with the same scope, backend and model starts no new turn
and returns the earlier verdict, retaining a valid `session_handle` for the
workspace; a workspace change during a review is reported only when the
snapshot or its completeness changed.

## Tools

| Tool | Purpose |
| --- | --- |
| `consult` | A second opinion on a question, design, plan or bug; optional architecture, debugging or implementation analysis |
| `review` | An independent review of Git changes with a verdict CoAgent8 derives |
| `doctor` | Models, efforts, prices and approval per backend; installation, sign-in and quota with `scope: "health"` |
| `session` | List the workspace's sessions, page a session's history (`cursor` and `limit`) or close a session; a closed session reports that it is closed on a follow-up or `cancel`, while its history stays readable |
| `cancel` | Cancel the running turn of a session |
| `issue` | Prepare a sanitized bug report (attaching detected CLI versions when `include_doctor` is `true`, the default) and a prefilled GitHub issue link; it never submits anything |

Answers come back as Markdown with the backend, model, duration and session
handle; passing the handle continues the same conversation. Your chat host
controls tool visibility, progress and approvals.

## Commands

Press `F1` (or `Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), type `CoAgent8` and
choose a command:

| Command | What it does |
| --- | --- |
| **CoAgent8: Manage Coding CLIs** | Each CLI's state and chat entry; installs, signs in, chooses an installation, adds CoAgent8 to the CLI's chat, manages skills and removes what CoAgent8 installed |
| **CoAgent8: Manage Model Approvals** | The price rules and every model with its price and approval tag; allow a model, ask every time, deny it or leave it to the price rules |
| **CoAgent8: Manage Skills** | Install, update, uninstall, enable or disable CoAgent8's skills per CLI |
| **CoAgent8: Open Settings** | CoAgent8's backend, model, configuration path and Node.js settings |
| **CoAgent8: Open Configuration (config.json)** | The configuration file (`~/.coagent8/config.json` unless `coagent8.configPath` or `coagent8_CONFIG` names another), created with defaults if missing, with completion and validation (a file in another location needs a `$schema` entry, which new files get) |
| **CoAgent8: Reset Configuration (config.json)** | Restores the defaults after a confirmation, keeping the previous file as `config.json.backup` |
| **CoAgent8: Show MCP Servers** | Opens **MCP: List Servers**, where CoAgent8 is started, stopped or restarted and its output shown |

### Manage Coding CLIs

The list shows Codex CLI, Claude Code CLI and Antigravity CLI, installed or not,
with their state (ready and version, sign-in needed, not installed), whether
CoAgent8 is in the CLI's own chat, and the installation in use. "Its own chat"
means the chats of Codex, Claude Code and Antigravity themselves, in their VS
Code extensions and terminals; VS Code chat uses CoAgent8 either way. When
there is something to do, the list ends with **Add CoAgent8 to All CLI Chats**
or **Update CoAgent8 in All CLI Chats**.

A CLI's menu shows only what applies, and reopens with fresh checks after each
action:

- **Installations**: every installation found, the one in use marked; choose
  another to use it.
- **Install**: **Install VS Code Extension** (recommended) or **Install
  Standalone CLI** (the vendor's official installer), each while that kind is
  missing; **Choose Executable** selects a CLI from any folder after checking it.
- **Chat**: **Sign In**, **Add CoAgent8 to Its Chat** or **Update CoAgent8 in
  Its Chat**. A chat entry you wrote yourself is never changed.
- **Skills**: **Manage Skills** for this CLI.
- **Remove**: **Remove CoAgent8 from Its Chat**, and **Uninstall VS Code
  Extension** or **Uninstall Standalone CLI** for what CoAgent8 installed.

Installations are found without starting them: the vendor extension's copy,
every folder on PATH, the official installers' folders and the configured file.
A selection is stored as `backends.<id>.executable` in `config.json`, so VS Code
chat, the CLI chats and the `coagent8` command all use it. CoAgent8 never
downloads or stores CLI binaries; every CLI stays in its vendor's location.

Installer, sign-in and removal commands are typed into a terminal without
running them: press Enter there, then choose **Check Now** (or **Reload
Window** if an installer changed PATH). Sign-in is read from each CLI's own
silent check; it never starts a login or a model turn.

**Uninstall VS Code Extension** opens the extension's page, where VS Code's own
**Uninstall** and **Restart Extensions** remove it from every running extension
without reloading the window. CoAgent8 finishes once the extension is gone,
including the `agy` binary the Google Antigravity extension downloads to
`~/.gemini/bin`. **Uninstall Standalone CLI** types the vendor's removal
commands into a terminal; sign-ins and histories (`~/.codex`, `~/.claude`,
`~/.gemini`) stay.

After a change to a CLI's chat, one notice offers **Restart Extensions**: the
vendor chat extensions load MCP servers only when they start. The window and
chat histories stay, but replies in progress stop. New terminal sessions see
the change without a restart.

### Manage Model Approvals

The first step shows the price rules (ask above a price, ask above a multiple
of the backend's default) and each backend with its model counts; the second
lists the backend's models, most expensive first, with their price and what
decides them; the third sets one model's rule: **Allow**, **Ask Every Time**,
**Deny** or **Price Rules**. A rule for a model covers its effort variants.
Rules are saved in `config.json`, so they apply in every client, including the
ones that cannot show CoAgent8's approval form.

### Manage Skills

Choose a CLI, an action that has packages to change, then the packages (all
selected); **Back** returns one step. Disabled skills move to
`~/.coagent8/disabled-skills/<client>/` and come back when enabled. Your choices
are kept in `config.json`, so a repair or update does not undo them, and a
skill you edited is never overwritten. Start a new chat to see changes.

## Settings

Run **CoAgent8: Open Settings** or search for `CoAgent8` in Settings. Every
setting is machine-scoped: a workspace cannot change backends or models.

| Setting | Default | Purpose |
| --- | --- | --- |
| `coagent8.defaultBackend` | `auto` | Backend used when a request names none; `auto` chooses among the allowed backends |
| `coagent8.routing.allowedBackends` | all three | Backends CoAgent8 may run (`agy` is the Antigravity CLI) |
| `coagent8.routing.strategy` | `fixed` | `fixed` uses the default backend; `smart_quota` prefers one with quota left |
| `coagent8.codex.defaultModel`, `coagent8.claude.defaultModel`, `coagent8.agy.defaultModel` | empty | Model when a request names none; empty uses `config.json`, then the CLI's default |
| `coagent8.configPath` | empty | Configuration file; empty uses `coagent8_CONFIG`, then `~/.coagent8/config.json` |
| `coagent8.nodePath` | `node` | Node.js 24+ executable that starts the bundled server |

A setting you save, even with its default value, takes precedence over the same
option in `config.json`; a setting you never set keeps the file's value, and an
empty model setting keeps the file's model. The CLIs and other MCP
hosts read only the file. Changing a setting restarts the server on its next
use. If Node.js is not on PATH, set its absolute path, for example
`"coagent8.nodePath": "C:\\Program Files\\nodejs\\node.exe"`.

## Data and privacy

- The other agent's CLI sends your prompt and workspace context to its provider;
  CoAgent8 is not offline inference.
- Answers are redacted for recognized credential formats, and diagnostics also
  for home paths and sensitive settings. Redaction cannot guarantee that private
  source content is removed.
- Sessions and their history stay in the extension's storage
  (`globalStorage/okidev.coagent8-mcp`). A session handle expires after two
  hours without use. The history archive is best effort, up to 10 MiB per
  session and 100 MiB in total, and old archives are removed after seven days;
  `coagent8_HISTORY=off` turns it off.
- A model with an unknown or approximate price, or priced at or above your
  thresholds (by default 20 USD per million output tokens or twice the
  backend's default), runs only after you approve it in a form. Prices come from
  OpenRouter's public list and guide the approval; they are not your bill.

## Uninstalling

Use the Extensions view. On VS Code's next full start, CoAgent8 removes what it
added and you did not change: its entries in the CLIs' chats, its skills, its
runtime copies and private backups. Another VS Code installation, such as
Insiders, keeps its own entry. VS Code deletes the extension's storage with its
sessions and history.

Kept: `~/.coagent8/config.json`, your `coagent8.*` settings, CLI sign-ins and
histories, entries you wrote or edited, and the CLIs or vendor extensions
CoAgent8 installed: **Manage Coding CLIs** offers their removal again after a
reinstall. To remove CoAgent8 from a CLI's chat without uninstalling, use
**Remove CoAgent8 from Its Chat**.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| CoAgent8 is missing from the server list | VS Code 1.101+, a trusted folder on disk, and the extension enabled on the right local or remote host |
| The server cannot find Node.js | Run `node --version` on the extension host; set `coagent8.nodePath` to its absolute path |
| `CLI_NOT_FOUND` or `AUTH_REQUIRED` | Run **CoAgent8: Manage Coding CLIs** to install or sign in the reported CLI on the same machine as the server (on a remote host, use the CLI's own installer or `npx -y coagent8@next status`), then run `doctor` again |
| `POLICY_DENIED` for a model | Read the reason in the error: the model is denied by a rule, you declined it, or it needs approval your chat cannot show; allow it in **Manage Model Approvals** or choose another model |
| `INPUT_LIMIT` from a review in a repository | Git refuses the folder, for example because another account owns it; the message names Git's reason |
| Tools look outdated after an update | Restart CoAgent8 in **MCP: List Servers** and start a new chat |
| A CLI's own chat does not see CoAgent8 | **Manage Coding CLIs** > the CLI > **Add CoAgent8 to Its Chat**, then **Restart Extensions** |
| Two CoAgent8 extensions | Remove the old development extensions `oktawianwybieralski.coagent8-mcp` and `oki-dev.coagent8-mcp`; this one is `okidev.coagent8-mcp` |

For a reproducible problem, ask your chat agent to use `doctor` and `issue`, then
check the generated report for private data before submitting it.

## Known limitations

- **Antigravity's own tools.** agy gives the other agent your agy MCP servers
  and plugins, which CoAgent8 cannot turn off; `doctor` lists them and calls
  back into CoAgent8 are refused.
- **Antigravity readiness.** `agy` may report not ready in a cached check and
  still run a turn; `doctor` with `scope: "health"` rechecks readiness.
- **Leftover agy processes on Windows.** Cancelling an agy turn stops agy, but a
  process it started outside itself, such as one of its MCP servers, can keep
  running until it exits or the server stops.
- **Default model price.** A plain `consult` with no model and no price limit
  runs the backend's default model (still subject to your approval thresholds);
  pass `output_price_below` or a model to bound the price.
- **Approval forms.** Not every chat shows MCP forms; Codex and the Antigravity
  chat did not when measured. Allow such models in **Manage Model Approvals**.
- **Host deadlines.** A chat host can stop a tool call before CoAgent8's own
  deadline.
- **Restart Extensions** restarts every extension: VS Code has no way to restart
  only the vendor chat extensions.
- On a remote extension host (SSH, WSL) the CoAgent8 commands are not
  available; run `npx -y coagent8@next status` (or `setup`, `repair`, `skills`,
  `cleanup`, or `coagent8 ...` when installed globally) in that machine's
  terminal. Virtual and untrusted workspaces are not supported.
- Icons, tool grouping and refreshing existing chats depend on the chat host.

## Updates, support and license

The extension and its bundled server carry the same version as the npm package
`coagent8`. Versions below 1.0.0 are VS Code pre-releases; every release has a
new number, so VS Code offers **Restart Extensions** after an update. The
**Changelog** tab shows the release history of user-facing changes.

[Website](https://oki.dev) |
[Issues and questions](https://github.com/oktawianwybieralski/coagent8/issues) |
[Source](https://github.com/oktawianwybieralski/coagent8) |
[Documentation](https://github.com/oktawianwybieralski/coagent8#readme)

This checkout is licensed under **MIT**, including the project artwork. The
extension includes `LICENSE` and the notices of its bundled dependencies in
`dist/THIRD_PARTY_NOTICES.txt`; those dependencies retain their own licenses.
The planned MIT release is 0.6.1. Copies of published 0.6.0 and the withdrawn
npm version 1.0.0-beta.1 retain their GPL-3.0-only permissions. Previously
granted licenses are not revoked.
