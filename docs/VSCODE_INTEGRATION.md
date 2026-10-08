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
| MCP server | `serverInfo.icons`; tools carry no icons | Embedded `assets/logo64.png` on light backgrounds, `assets/logo64-light.png` on dark backgrounds |
| Codex plugin | `plugin.json` / `extensions.com.openai.interface` | `logo32.png` / `logo.png`; `composerIconDark` / `logoDark` use `logo32-light.png` / `logo-light.png` |
| Native VS Code extension | `icon`, `mcpServerDefinitionProviders` | `logo.png` |

The README uses an SVG `picture` with `prefers-color-scheme` to select
`assets/logo-light.svg` on dark backgrounds. The VS Code extension manifest's
[`icon` field](https://code.visualstudio.com/api/references/extension-manifest)
accepts a single path; its bundled MCP server advertises both themes separately.
The plugin's dark-theme fields follow the
[OpenAI manifest reference](https://developers.openai.com/plugins/deploy/submission).

## Assets and build

`npm run build` validates both 64x64 PNGs (maximum 16 KiB each), generates
`src/generated/server-icon.ts`, and copies `assets/logo256.png` to `assets/logo.png`
and `assets/logo256-light.png` to `assets/logo-light.png`.
The generated TypeScript is committed so source tests and typechecking work after
checkout. Regenerate it whenever either 64x64 artwork changes. The standalone runtime
contains both data URIs and does not read image files or fetch a logo over the network.
The original artwork declares `theme: 'light'`; the light artwork declares
`theme: 'dark'`, since MCP themes describe the intended background.
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

### Extension presentation and publisher identity

The VSIX identifies its author as **Oktawian Wybieralski** and uses publisher identifier
`okidev`, giving extension ID `okidev.coagent8-mcp`. Publisher identifiers
cannot contain a dot; the Marketplace publisher's display name **oki.dev** is
configured on the publisher account, not by the manifest. Packaging does not
create, verify or reserve that account. The GitHub repository URL is unchanged.
The owner reports creating this publisher on 2026-10-07. Before publishing,
confirm ownership of `okidev` and its display name.
An unpublished local VSIX can show the publisher ID in its header when no
Marketplace display-name metadata is available; `author.name` does not control
that header.

The Details README uses rounded (`style=flat`) shields.io badges in two rows: links to
the author's website, GitHub source and issue reports, then the preview status
(linking to known limitations), MCP stdio, Node.js 24+ and GPL-3.0-only. Every
badge has a label and a value; logos are limited to ones shields.io serves
(GitHub, MCP, Node.js), since an unknown logo is silently dropped. It contains no large logo or embedded data URI:
the owner reported that the embedded PNG did not render after installation.
The separate packaged `assets/logo.png` remains the extension's main icon.
Standard vsce link rewriting and image validation are enabled.

This identity differs from the old development ID
`oktawianwybieralski.coagent8-mcp` and `oki-dev.coagent8-mcp`. An old installation is not upgraded by the
new VSIX; uninstall the old development extension before installing the new one
to avoid duplicate providers. Preserve existing manual MCP registrations.

The extension README supplies the Details page: overview, requirements, quick
start, example requests, tools, settings, privacy, troubleshooting and current
limitations. Manifest fields supply website, source, issues/Q&A, keywords,
Preview status and a dark gallery banner. The package also includes the generated
project `CHANGELOG.md`, license and bundled dependency notices. Documentation
links target the active release branch; no Marketplace ratings, verified badge
or UI acceptance is implied by a local VSIX.

Presentation follows the official
[extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest)
and [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

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
- In headless mode both clients cancel the consent request, so a model that
  needs approval always fails with `POLICY_DENIED`. The interactive prompt is not yet verified.
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

### CLI onboarding and optional native-host registration

Each VSIX command has one purpose. VS Code chat uses the provider without any
registration or restart (**CoAgent8: Show MCP Servers**). **CoAgent8: Set Up
Coding CLIs** is the one list for the CLIs: installation, sign-in and CoAgent8 in
the CLIs' own chats (owner decision, 2026-10-08, merging the former **Manage CLI
Chat Registrations**). **CoAgent8: Uninstall CoAgent8** removes it.

The first activation checks the CLIs once and shows one notice: the ready CLIs
with **Show MCP Servers**, plus **Set Up CLIs** when another CLI needs an
installation or sign-in or a ready CLI has no CoAgent8 entry, or only an offer to
set up a CLI. The state file in the extension's
global storage records it before the notice is answered; later activations start
no process.

**CoAgent8: Set Up Coding CLIs** checks all three full CLI names with bounded
version/help and local sign-in metadata checks, without a prompt, installation or
login, in parallel (0.75 s for three ready CLIs on the owner's Windows profile,
2026-10-08). At least one compatible, locally signed-in backend is needed for
useful execution. This status is distinct from per-turn sandbox verification,
token validity and a successful model response. No CLI is required to initialize
MCP or list its tools. Status reads CoAgent8 registrations from the host files
only; it starts neither the runtime nor a host (`coagent8 repair` verifies them).

The setup picker opens immediately with a busy indicator while the checks run
and stays open when focus moves (`ignoreFocusOut`). Each line combines the CLI's
state with its registration, read from the host files (20 ms on the owner's
profile), and a detail naming the installation source from the resolved
executable: inside the vendor extension's folder, `~/.gemini/bin` for the copy the
Google Antigravity extension downloads, otherwise a standalone binary or an npm
package, marked when setup recorded installing it. Checked lines are the CLIs with
a CoAgent8 entry (owned or manual), so the accepted list authorizes exactly its
difference plus what a checked CLI still needs: a missing CLI is installed, a
signed-out one is offered its sign-in, and an absent or outdated owned entry is
written through shared setup with the extension origin; unchecked owned entries go
to cleanup with the preview token applied at once and tagged backups. Manual and
unreadable entries are never changed; blocked CLIs are not installed around their
override. Setup verifies a written entry with runtime initialize and `tools/list`,
plus Codex native discovery of the tools; no `doctor` call, which took 5-11 s per
client. Its title-bar buttons check again and show details. Each check adds one
line to the **CoAgent8 Setup** output channel, for example
`[22:31:05] Set Up Coding CLIs - codex: ready, added to its chat; claude: ready; agy: ready`.
The full JSON evidence is written only through **Show Details**, which opens the
channel without taking focus (`show(true)`): a focused output panel would close an
open picker. Setup checks again at the end only after an installation, or after a
sign-in when **Check Now** is chosen. One closing notice states readiness and the
registration changes and offers **Restart Extensions**
(`workbench.action.restartExtensionHost`) when a vendor chat extension of a
changed CLI is installed, since those extensions load MCP servers only when they
start; it restarts every extension, as VS Code has no API to restart one. With
nothing to do the list closes without a notice. A CLI that appears only later,
such as agy after the Antigravity view first opens or a standalone CLI after a
window reload, is checked in the next run of the list.

Discovery prefers explicit executable overrides, then `backends.<id>.executable`
in the configuration file the runtime receives, then PATH, then bundled Codex/Claude
binaries and, for agy, the copy that the Google Antigravity extension downloads
to `~/.gemini/bin` when it starts its backend. Only that executable is reused,
with the usual `--sandbox` turn; CoAgent8 does not call the extension's running
backend (`ANTIGRAVITY-HUB-001` in the [roadmap](ROADMAP.md)). A bad override fails closed for that client while other clients remain
visible. The provider passes the currently installed `openai.chatgpt` and
`anthropic.claude-code` paths from VS Code's extension API, including custom
installation roots, using `coagent8_EXTENSION_PATHS` (JSON object with optional
`codex`/`claude` absolute extension directories). The runtime has no editor API
dependency. These paths are computed for each provider definition and check;
setup does not persist vendor version paths as executable settings. Without
that environment contract, standalone discovery scans the standard local
`.vscode` and `.vscode-insiders` extension directories. With it, the editor's
actual installed paths are authoritative for bundled discovery. Extension
changes invalidate resolver caches and refresh provider definitions. Restart a
running MCP server if the host still retains an earlier definition/environment.
Native-host launches outside VS Code need their own discoverable CLI environment;
setup does not persist the editor's version directories into their registrations.

For each selected missing CLI, onboarding asks how to install it:
**Install VS Code Extension** (`openai.chatgpt`, `anthropic.claude-code` or
`google.google-antigravity`; it updates itself and adds its own chat) or
**Install Standalone CLI** (the vendor's official installer; lighter and usable
in terminals). Either way the CLI stays in its vendor's own location; CoAgent8
never downloads or stores CLI binaries. Extension installation uses VS Code's
documented `workbench.extensions.installExtension` action after the user's
choice. Onboarding then waits, with a cancellable progress notification of at
most three minutes, until the CLI is discoverable, and the CLI must still pass
the readiness check. CoAgent8 has no unconditional vendor extension
dependencies or extension pack.

The Google extension ships no `agy` in its VSIX; it downloads one to
`~/.gemini/bin` when it starts its backend. If that extension is installed but
its CLI has not appeared yet, the picker shows Antigravity CLI as
**Downloading** and onboarding waits for it instead of offering a second
installation. If the wait ends first, open the Antigravity view once so the
extension starts its backend, then refresh.

Standalone installers are inserted in a visible terminal without execution:
press Enter to install, then choose **Check Now**. An installer that changes
PATH affects new processes only; when the CLI is not found with the window's
current PATH, onboarding offers **Reload Window**. Cancellation/failure is
reported per client, with a refresh/retry path. A terminal command offer is not
installation evidence.

After a CLI appears, onboarding can offer an explicit sign-in terminal command
(`codex login`, `claude auth login`, or interactive `agy`). It never executes
sign-in. Refresh status after completion. If PATH is stale, reload VS Code first; a terminal's
new PATH does not update the existing extension host. CLI presence alone does
not establish authentication. Claude must meet the adapter's shared minimum
2.1.289 and advertise the required restricted/streaming controls. Codex also
passes an app-server initialize handshake without creating a thread or model
turn. Codex/Claude authentication reflects only their own local status command.
agy has no status subcommand; its sign-in is read from
`AGY_CLI_CDE_AUTH_ACTION=check`, the silent check the Google Antigravity
extension runs (exit 0 with "Already authenticated as ..."). It starts no prompt
or login. A clear "not authenticated" result is reported as signed out; any other
failure, such as a token refresh without network, stays `unknown`. The account
name is not recorded. agy keeps credentials outside the profile directory, so an
isolated home does not simulate a signed-out state. All agy probes set
`AGY_CLI_DISABLE_AUTO_UPDATE=true`. Native quota/authentication acceptance is
separate.

Registration in the CLIs' own chats is optional: the ordinary VS Code provider
works independently. Explicit standalone commands
retain their registration semantics:

```bash
coagent8 setup --clients=codex,claude,agy  # authorize native-host registration
coagent8 repair                          # reuse saved registration selections
coagent8 status                          # inspect all CLIs and registration evidence
coagent8 cleanup                         # preview unchanged owned removals
coagent8 cleanup --apply=<preview-token> # apply that exact current preview
```

Metadata and callability evidence are separate fields: `installed`, `version`,
`compatibility`, `authentication`, `ready`, `registered`, `runtimeCallable`, and
`hostCallable`. In status, `action: missing` means the CLI itself is absent;
`action: not-registered` means the CLI is present and CoAgent8 is simply not
registered in that client's own configuration, which is optional.
`compatibility: supported` establishes required CLI controls
(and Codex initialization), not authenticated streaming execution or complete
capability isolation. Registration errors do not erase CLI presence/sign-in.
Unknown authentication is not ready. A direct-runtime doctor pass is not native
Claude/Antigravity acceptance. Status returns exit 1 if no CLI has compatible
controls and verified local sign-in, while MCP initialization stays available.

No-argument invocation and unknown host startup arguments start the stdio MCP
server. Recognized setup commands load the separate sibling `dist/setup.cjs`;
installer code and JSONC handling are excluded from the core bundle. Setup installs the built
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
entry.

### Owned-registration cleanup and uninstall

Uncheck the CLIs in **CoAgent8: Set Up Coding CLIs** before uninstalling the
VSIX, run **CoAgent8: Uninstall CoAgent8**, or use the standalone `cleanup` command. Preview is
read-only. Applying requires the accepted list in VS Code or the exact CLI preview
token; a changed
configuration/ownership snapshot invalidates it. Cleanup shares setup's lease,
keeps private byte-for-byte backups, checks current entry fingerprints, and
reports removals, absent entries, preserved manual/edited entries and per-client
failures. It does not require an installed backend CLI. Successful removal and
failed state persistence are reported separately; rerun a fresh preview for
recovery. Repeated cleanup is idempotent.

Only unchanged `coagent8` entries with recorded setup ownership are removed.
Other identities, including legacy names without ownership evidence, are retained.
JSON/JSONC removal preserves other settings; TOML removal supports full owned
tables and nested/quoted keys. Unsupported inline/dotted TOML layouts are preserved
with a conflict instead of reserializing the user's configuration. Runtime files
are retained conservatively because manual or edited registrations may still
reference them. Histories, credentials, CLI installations and vendor extensions
are not removed.

After cleanup, restart native hosts to refresh cached catalogs.

Owner decision of 2026-10-08, replacing the earlier "no uninstall hook" rule:
uninstalling removes what the extension created. VS Code deletes the extension's
global storage (configuration default, onboarding choices, sessions, history and
caches). The `vscode:uninstall` hook (`dist/uninstall.cjs`) removes the native-host
registrations the extension wrote, when they are unchanged, then runtime copies no
registration references, an empty setup state and an empty `~/.coagent8`. Setup
records such registrations with the `vscode-extension` origin; registrations made
by the `coagent8` CLI, manual or edited entries and earlier records without an
origin are preserved. Uninstalling is the confirmation, so no preview token or
private backup is used: the removed entry is byte-verified and setup can recreate
it. VS Code runs the hook only after it restarts following the uninstall, with
Node, without the VS Code API and with a five-second limit; the explicit cleanup
command remains the immediate path. Production cleanup neither edits SQLite
profile databases nor deletes cached catalogs or auto-update exclusions.

Since `UNINSTALL-002` (2026-10-08) nothing the extension creates outlives it.
Registrations it writes carry `coagent8_DIR` for its global storage, so CoAgent8
started from a CLI chat keeps sessions, history and caches there. Private backups
it writes, from setup and from removals, are named `vscode-extension-<uuid>` in
`~/.coagent8/setup-backups`; the hook deletes them, keeping untagged `coagent8`
CLI backups. The temporary Codex staging copy is deleted after each native edit.
The extension writes globalState only to remove keys of earlier builds.

**CoAgent8: Uninstall CoAgent8** runs the same removal at once and then
`workbench.extensions.uninstallExtension` for CoAgent8. Setup installs a vendor
extension with `workbench.extensions.installExtension` and `{ donotSync: true }`:
it is machine-scoped, so VS Code skips its "Install (Do not sync)" dialog, shown
whenever extension sync is on and the option is absent (VS Code 1.141
`hasToFlagExtensionsMachineScoped`). Setup records the extension in
`setup-state.json` when it was absent before and the install command completed;
the extension API may list a new extension only later, so it is not consulted.
Removing the Google Antigravity extension also deletes `~/.gemini/bin/agy[.exe]`,
which that extension downloads and does not remove on uninstall. Opening a standalone installer records the CLI
as pending, and the first check that finds it, also after a reload, records it as
installed. Only such extensions and CLIs, while present, are listed, none
preselected. A modal confirms the uninstall; a second modal confirms the removal
of what is selected, and declining either changes nothing. Standalone CLIs are
removed by commands inserted, not run, in a terminal the extension does not own,
so it outlives the uninstall: `npm uninstall -g @openai/codex` (the inverse of
setup's npm install), the two `Remove-Item`/`rm` commands of Claude Code's
uninstall documentation, and deletion of `%LOCALAPPDATA%\agy\bin\agy.exe` or
`~/.local/bin/agy`, where the Antigravity installer script copies its single
binary (it publishes no uninstall). PATH entries the installers added stay.
Vendor sign-ins and histories are never removed. Uninstalled
extensions and global storage disappear on VS Code's next full start, which the
closing notice offers through **Quit VS Code**; **Restart Extensions** does not
complete an uninstall. VS Code keeps user settings such as `coagent8.*`.

Owner acceptance on Windows, 2026-10-07: after cleanup, uninstall and restart no
CoAgent8 registration, `~/.coagent8` data or extension directory remained.
Before the 2026-10-08 change, uninstalling without cleanup left native-host
registrations pointing to `~/.coagent8/runtime`, and VS Code kept the uninstalled
extension's `globalState` (welcome dismissal and remembered CLI choices); the
extension now removes those keys on activation and keeps its state in global
storage. Since `ONBOARDING-002` the first activation shows one notice per
installation (see above). Run **CoAgent8: Set Up Coding CLIs** from the Command
Palette at any time. This is not a reason to mass-delete the owner's profile.

**CoAgent8: Open Configuration (config.json)** opens the runtime configuration
and creates defaults only if missing. Set the machine-scoped user setting
`coagent8.configPath` to an absolute path or `~/...` to choose the file. Empty
uses `coagent8_CONFIG` or `~/.coagent8/config.json`. Editing and the provider use
the same path; new native-host registrations carry it in their environment.
Existing manual connections are preserved, and updates without native-host
acceptance remain deferred. The ordinary path uses the bundled JSON schema;
newly created files include `$schema`, while existing contents stay unchanged.
Backend/model/consent options stay in this file, rather than VS Code settings.

Installation/update/uninstall uses VS Code's native extension lifecycle and its
Extensions view action. The native **Restart Extensions** action applies added
and removed extensions before restarting hosts; **Developer: Restart Extension
Host** only restarts hosts. The extension does not replace either with a blanket
window reload. See the [VS Code implementation for the measured 1.141.0 build](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L1726).

The MCP provider's version includes the bundled server's SHA-256, so replacing
a development VSIX with unchanged SemVer still invalidates its tool metadata.
Path/Node changes and filesystem writes to active-profile/workspace MCP definitions
fire the provider's change event. VS Code controls restart/refresh through
**MCP: List Servers**. Separate native-host registrations retain their own restart
requirement. Provider and watcher disposables belong to the extension context.
The owner's lingering Restart Required report after uninstall remains unverified
until the action used and a new native lifecycle test are recorded.

Owner testing on 2026-10-08 confirmed opening the default configuration and
reported that schema completion/validation appeared to work. Fresh-profile welcome
and desktop behavior after the new provider refresh remain unverified. A one-off
owner-requested reset removes only CoAgent8 profile state after the editor closes,
with backups; it is not production cleanup and does not delete shared databases.

The extension remembers no CLI selection, so it has no reset command; uninstalling
removes the first-activation record with its global storage. Use
[the beta.2 checklist](VSCODE_BETA_2_CHECKLIST.md) for native lifecycle acceptance.

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
