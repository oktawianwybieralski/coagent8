# Optional client setup, VS Code and plugin integrations

Ordinary use needs only a stdio MCP definition; start with the
[README](../README.md#connect-through-mcp). This guide owns optional installation,
registration lifecycle and presentation details. Recognized setup clients are
not a server allowlist: clients such as Continue can connect without a setup
adapter. A VS Code provider does not automatically register every chat extension.

The [roadmap](ROADMAP.md) prioritizes generic MCP behavior and quiet operation over
expanding setup support. The functionality described below is the current
implementation; pending acceptance is not a claim of verified host compatibility.

CoAgent keeps its stdio MCP runtime independent of editor APIs. Three integration
surfaces share the same logo source:

| Surface | Metadata | Asset |
| --- | --- | --- |
| MCP server and tools | `serverInfo.icons`, `tools/list` icons | Embedded `assets/logo64.png` |
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
master exports are kept outside the repository and are excluded from runtime packages.

## Codex plugin

The root `plugin.json` follows Agent Plugins 1.0.0. Its `extensions.com.openai`
object supplies Codex presentation metadata. Root `mcp.json` configures the bundled
stdio server using `${PLUGIN_ROOT}/dist/index.cjs`; the host expands the placeholder.
Node.js 20+ must be available to the host, and coding CLIs must be installed and
authenticated separately. Build the project before installing it as a local plugin;
install a built package rather than an unbuilt source checkout.

For a repository-local marketplace, add an entry pointing to the built plugin:

```json
{
  "name": "coagent8-local",
  "interface": { "displayName": "CoAgent Local" },
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
configuring a second manual CoAgent MCP entry alongside the installed plugin.

## Native VS Code extension

From the repository root:

VSIX packaging tooling requires Node.js 22.12+. The MCP runtime and extension still
target Node.js 20+.

```bash
npm ci
npm ci --prefix tools/vscode
npm run typecheck
npm run package:vscode
```

The resulting `.rc-artifacts/coagent8-mcp-<version>.vsix` is a local development
package. Install it with **Extensions: Install from VSIX...**, open a trusted
workspace, then use **MCP: List Servers**. The extension requires VS Code 1.101+.
It registers one provider and lets VS Code start, approve, and stop the MCP process.
It does not launch a separate background process during activation.

Set the machine-scoped `coagent8.nodePath` to a Node.js 20+ executable if `node` is
not on PATH. With SSH/WSL, Node and coding CLIs must exist on the remote extension
host. The extension is disabled for untrusted and virtual workspaces.

VSIX requires a numeric version. The staging build removes the npm development
suffix from the VSIX version and the packaging command applies VS Code's pre-release
marker. The source manifest and bundled MCP retain the full npm version. No package
is published by these commands.

## Rendering and acceptance

Each host controls its own chat UI. MCP icon metadata does not force an icon,
grouping, or the text `Used CoAgent integration`. A data URI also needs to be
allowed by the host's image policy.

The native provider registers CoAgent in VS Code. Supported integrated Copilot
CLI and Claude agents can use VS Code's MCP bridge; see the
[VS Code release notes](https://code.visualstudio.com/updates/v1_113). Standalone
Codex, agy and Claude Code clients have independent registries. A provider or
plugin manifest in a checkout does not establish installation in those clients,
and an existing chat may retain its earlier tool catalog until the host refreshes
it or starts a new conversation.

The VSIX offers **CoAgent: Set Up or Repair Chat Clients** on first local
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
conflict-checked replacement. Managed updates require successful native-host calls
before and after replacement; a failed replacement restores the prior bytes when
no concurrent editor changed them. Claude and agy updates currently remain deferred
because their native-host calls are unverified. If concurrent edits prevent rollback,
setup reports the conflict and keeps the private backup for recovery.

The provider yields to a manual CoAgent entry in the active VS Code profile or
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
probes do not prove authentication or execution readiness. Restart the server or
start a new chat when the host caches its prior catalog; setup cannot refresh an
already open conversation or force a host to render icon metadata.

Automated checks cover the source handshake, tool metadata, installed-package logo
references, and a standalone handshake after PNG removal. Before claiming visual
support, install the relevant plugin/VSIX in the target chat and invoke `doctor`.
Check the name and icon in light and dark themes and ensure only one server entry
is present. This manual UI acceptance is separate from the automated package tests.

References: [MCP icons](https://modelcontextprotocol.io/specification/2025-11-25/basic),
[VS Code MCP API](https://code.visualstudio.com/api/extension-guides/ai/mcp),
[OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins).
