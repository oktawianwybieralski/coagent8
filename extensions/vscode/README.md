# CoAgent8 MCP for VS Code (development)

Expose the bundled CoAgent8 MCP server to the native VS Code chat. Requires VS Code
1.101+ and Node.js 24+ on PATH. Set `coagent8.nodePath` to an absolute Node executable
if necessary. Local coding CLIs must be installed and authenticated separately.

Install the development VSIX using **Extensions: Install from VSIX...**, then open
a trusted workspace and use **MCP: List Servers** to start CoAgent8. VS Code owns
the server process and tool approval UI. In SSH/WSL workspaces, Node and the agent
CLIs must be available on the remote extension host.

The extension icon identifies this extension. MCP metadata also provides an offline
PNG icon for the server; individual tools do not carry icon metadata. Each chat client decides whether and where to
display those icons. Codex has its own MCP/plugin configuration; registering this
provider has its own registry. Use **CoAgent8: Set Up or Repair Chat Clients** to
connect selected local standalone Codex, Claude Code, and agy clients. First local
activation offers this setup; selections are remembered for repair. Existing
manual registrations are retained, including VS Code's active profile entry.
External-client setup is disabled on remote extension hosts. Native plugin loading,
composer icons, and existing-chat refresh still require host acceptance.

The provider exposes the same six tools as ordinary stdio use. It does not
configure backend defaults, persist model catalogs or implement price-based
consent. A running server/chat may retain older tools; restart it after an update.
Current execution/safety limits are documented in the repository's runtime
contract, and protocol registration does not prove native backend readiness.

This is a development package. VSIX uses the numeric package version with the VS
Code pre-release marker; the bundled MCP server retains its full development version.
