# Optional client setup, VS Code and plugin integrations

Ordinary use needs only a stdio MCP definition; start with the
[README](../README.md#connect-through-mcp). This guide owns optional installation,
registration lifecycle and presentation details. Recognized setup clients are
not a server allowlist: clients such as Continue can connect without a setup
adapter. A VS Code provider does not automatically register every chat extension.

The [roadmap](ROADMAP.md) prioritizes generic MCP behavior and quiet operation over
expanding setup support. The functionality described below is the current
implementation; pending acceptance is not a claim of verified host compatibility.

CoAgent8 keeps its stdio MCP runtime independent of editor APIs. Three integration
surfaces share the same logo source:

| Surface | Metadata | Asset |
| --- | --- | --- |
| MCP server | `serverInfo.icons`; tools carry no icons | Embedded `assets/logo64.png` |
| Codex plugin | `plugin.json` / `extensions.com.openai.interface` | `logo32.png` for composer, `logo.png` for logo |
| Native VS Code extension | `icon`, `mcpServerDefinitionProviders` | `logo.png` |

## Assets and build

`npm run build` validates the 64x64 PNG (maximum 16 KiB), generates
`src/generated/server-icon.ts`, and copies `assets/logo256.png` to `assets/logo.png`.
The generated TypeScript is committed so source tests and typechecking work after
checkout. Regenerate it whenever the 64x64 artwork changes. The standalone runtime
contains the data URI and does not read image files or fetch a logo over the network.
No theme is specified: the supplied icon is shared between light and dark themes.
Check its visual contrast in both themes before publishing updated artwork.

PNG exports and SVG are shipped in the npm package. The Affinity design source and
master exports (`assets/design/logo.af`, archived PNG resolutions) remain in the
repository and are excluded from runtime packages.

## Codex plugin

The root `plugin.json` follows Agent Plugins 1.0.0. Its `extensions.com.openai`
object supplies Codex presentation metadata. Root `mcp.json` configures the bundled
stdio server using `${PLUGIN_ROOT}/dist/index.cjs`; the host expands the placeholder.
Node.js 24+ must be available to the host, and coding CLIs must be installed and
authenticated separately. Install the plugin directory built from the npm package,
not a source checkout:

```bash
npm ci
npm run package:artifacts
```

The command packs the npm tarball (`.artifacts/package/`, with its SHA-256 in
`artifacts.json`), extracts it to `.artifacts/plugin/coagent8/` and checks that
`plugin.json`, `mcp.json`, `main` and `bin` point at files the package contains.
The plugin directory holds exactly the files npm publishes.

For a repository-local marketplace, add an entry pointing to the built plugin:

```json
{
  "name": "coagent8-local",
  "interface": { "displayName": "CoAgent8 Local" },
  "plugins": [
    {
      "name": "coagent8",
      "source": { "source": "local", "path": "./" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Save this catalog at `.agents/plugins/marketplace.json` in your local installation
repository and enable `coagent8@coagent8-local` in the client's plugin configuration.
Marketplace discovery and plugin installation depend on the client version. Avoid
configuring a second manual CoAgent8 MCP entry alongside the installed plugin.

## Native VS Code extension

From the repository root:

The MCP runtime and the extension require Node.js 24+. Building the server
bundle requires Node.js 24.11+ because tsdown 0.23.0 supports no older Node 24
release; `devEngines` in `package.json` enforces this for repository commands.

```bash
npm ci
npm ci --prefix tooling/vscode
npm run typecheck
npm run package:vscode
```

The resulting `.artifacts/coagent8-mcp-<version>.vsix` is a local development
package. Its MCP server bundle, notices, logo and license come from the npm
tarball that `npm run package:artifacts` packs, never from the working tree's
`dist/`. Install it with **Extensions: Install from VSIX...**, open a trusted
workspace, then use **MCP: List Servers**. The extension requires VS Code 1.101+.
It registers one provider and lets VS Code start, approve, and stop the MCP process.
It does not launch a separate background process during activation.

Set the machine-scoped `coagent8.nodePath` to a Node.js 24+ executable if `node` is
not on PATH. With SSH/WSL, Node and coding CLIs must exist on the remote extension
host. The extension is disabled for untrusted and virtual workspaces.

VSIX requires a numeric version. The staging build removes the npm development
suffix from the VSIX version and the packaging command applies VS Code's pre-release
marker. The source manifest and bundled MCP retain the full npm version. No package
is published by these commands.

## Rendering and acceptance

Each host controls its own chat UI. MCP icon metadata does not force an icon,
grouping, or the text `Used CoAgent8 integration`. A data URI also needs to be
allowed by the host's image policy.

The native provider registers CoAgent8 in VS Code. Supported integrated Copilot
CLI and Claude agents can use VS Code's MCP bridge; see the
[VS Code release notes](https://code.visualstudio.com/updates/v1_113). Standalone
Codex, agy and Claude Code clients have independent registries. A provider or
plugin manifest in a checkout does not establish installation in those clients,
and an existing chat may retain its earlier tool catalog until the host refreshes
it or starts a new conversation.

### Measured client behavior

These measurements are historical evidence, not acceptance of the current
uncommitted documentation or a newly built release artifact.
Measured on 2026-10-07 (Windows 11, Node 26.10) with headless clients and a stub
MCP server that logs the client's capabilities and answers. Claude Code 2.1.289
ran as `claude -p` with haiku; agy 1.3.1 ran as `agy -p --sandbox` with
`gemini-3.8-flash-low`. Claude Code results were read from its `stream-json`
transcript, agy results from its answers.

| | Claude Code 2.1.289 | agy 1.3.1 (CLI) |
| --- | --- | --- |
| Result channel the model reads | only `structuredContent`, serialized as JSON, when the result has one; `content` is dropped | `content` |
| Result saved to a file | 45,000 B inline; 60,000 B saved ("Output too large (59.7KB)") | 3,900 B inline; 4,300 B saved as `output.txt` |
| Server instructions | visible to the model | visible to the model |
| Roots | declares `roots.listChanged`; `roots/list` returns the launch directory | the same |
| Elicitation | declares `form` and `url`; in `-p` mode every request is answered `cancel` at once | the same |
| Tool-call limit | not measured | 180 s: the call is cancelled with "timed out after 3m0s"; progress notifications every 5 s do not extend it |
| Permission for an MCP tool in `-p` mode | `--allowedTools` | an allow rule `mcp(<server>/<tool>)` in the user settings; a workspace settings file is ignored |

Consequences for CoAgent8:
- In headless mode both clients cancel the consent request, so a top-tier model
  always fails with `POLICY_DENIED`. The interactive prompt is not yet verified.
- In the measured headless agy version, the 3-minute host limit cancels the
  backend turn. Interactive Antigravity IDE timing was not measured.
- Claude Code showed the model the JSON `structuredContent` (answer in
  `output`), not the markdown `content` with its footer, and showed `content` only
  for a result with `isError: true` (a live consult, 2026-10-07). Execution tools
  therefore return markdown only (`CONTEXT-001`).

With the markdown-only result (2026-10-07, one headless consult per client):
Claude Code 2.1.289 passed the markdown answer and footer to the model as its
`tool_result`; Codex 0.160.1 (`codex exec`) received `structured_content: null`
and read the text, including an error line it corrected in one retry; agy 1.3.1
read the text. Codex reports no workspace roots, so its results carry the
`> Workspace: <path> (server directory)` line.

The VSIX offers **CoAgent8: Set Up or Repair Chat Clients** on first local
activation and in the Command Palette. Select installed standalone Codex, Claude
Code, and agy clients once; repair remembers the selection. The CLI uses the same
implementation:

```bash
coagent8 setup --clients=codex,claude,agy
coagent8 repair
coagent8 status
```

No-argument invocation remains the stdio MCP server. Setup installs the built
bundle at `~/.coagent8/runtime/<sha256>/index.cjs`, records selections and owned
entry fingerprints in `~/.coagent8/setup.json`, and keeps private configuration
backups under `~/.coagent8/setup-backups/`. These files can contain credentials;
do not attach them to issues. Old runtime versions are retained for rollback.

Setup preserves existing manual or independently changed definitions. Missing
JSON/JSONC entries retain unrelated servers, inputs, credentials, and comments.
Codex's native registration command edits an isolated configuration copy before a
conflict-checked replacement. Setup then adds `tool_timeout_sec = 1800` to the
`[mcp_servers.coagent8]` table, because Codex stops an MCP tool call after 60 s by
default and `codex mcp add` has no option for it; the parsed result must differ by
that key alone. Managed updates require successful native-host calls
before and after replacement; a failed replacement restores the prior bytes when
no concurrent editor changed them. Claude and agy updates currently remain deferred
because their native-host calls are unverified. If concurrent edits prevent rollback,
setup reports the conflict and keeps the private backup for recovery.

The provider yields to a manual CoAgent8 entry in the active VS Code profile or
workspace, preserving the working connection and avoiding a duplicate provider
entry. No uninstall callback edits external settings. Remove a managed registration
through its host only after verifying a replacement; setup does not delete manual
entries or automatically remove old runtime directories.

Setup currently supports local default standalone profiles. Remote VS Code hosts
continue to use the bundled provider but do not run external-client setup on the
local machine. Custom standalone configuration roots are rejected. Workspace
shadow definitions and configured Codex plugins produce visible conflicts. Native
plugin loading, composer presentation, all duplicate plugin scopes, and real VSIX
lifecycle/UI acceptance remain tracked in [ROADMAP.md](ROADMAP.md).

Status separates registration, direct-runtime `doctor` calls, and native-host
calls. Codex's app-server probe discovers the server and invokes `doctor` without
an LLM turn. Claude and agy native-host calls are reported as unverified. Runtime
probes are diagnostic evidence, not proof of a successful model turn or complete
capability isolation. Doctor can mark agy ready when native quota was measured in
that run; its version-only probe still reports unknown authentication. Restart the server or
start a new chat when the host caches its prior catalog; setup cannot refresh an
already open conversation or force a host to render icon metadata.

Automated checks cover the source handshake, tool metadata, installed-package logo
references, and a standalone handshake after PNG removal. Before claiming visual
support, install the relevant plugin/VSIX in the target chat and invoke `doctor`. A passing
fixture/packaging check is not this UI acceptance.
Check the name and icon in light and dark themes and ensure only one server entry
is present. This manual UI acceptance is separate from the automated package tests.

References: [MCP icons](https://modelcontextprotocol.io/specification/2025-11-25/basic),
[VS Code MCP API](https://code.visualstudio.com/api/extension-guides/ai/mcp),
[OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins).
