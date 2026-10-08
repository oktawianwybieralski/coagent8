# Local beta.2 VS Code acceptance

Install the replacement VSIX and record its SHA-256 from the owner's handoff.
CoAgent8 is provided by the extension, so it is listed in MCP: List Servers, not in
the Extensions view's MCP Servers - Installed section, which lists mcp.json and
gallery servers.
These checks require the actual editor; passing fixtures do not establish them.
Record PASS, FAIL or NOT_RUN for each item, with the exact action and observed
result. No test requires deleting vendor extensions, credentials or histories.

| Check | Action | Expected result |
| --- | --- | --- |
| Installation | Install from VSIX in a trusted workspace. If the Extensions view requests Restart Extensions, use that action. | One CoAgent8 extension, the new commands, and no remaining Restart Required after the native action. Record a persistent banner as FAIL; do not hide it with a window reload. |
| Configuration path | In User Settings, search for CoAgent8 and set Config Path to an absolute path with spaces. Run Open Configuration. Then clear the setting and open again. | The first action opens the chosen file; the second opens the default/environment path. New files have defaults. Existing contents survive. |
| VS Code settings | Run CoAgent8: Open Settings. Check every option. Set Default Backend and add a model to Never Ask Models, then call doctor from chat without restarting anything. Then use Reset Setting on both. | Twelve settings under CoAgent8, each with a description and an inline control; none is marked invalid. VS Code restarts the server by itself; doctor reports the chosen default backend and config.json is unchanged. After the reset, the file values apply again. |
| Configuration reset | Run Reset Configuration (config.json), cancel once, then confirm. Run it a second time. | Cancellation changes nothing. Confirmation opens a default config.json and leaves exactly one config.json.backup with the previous contents. VS Code settings are unchanged. |
| Extension page | Open CoAgent8 in the Extensions view. Check the Features tab, categories and tags. | Features lists Settings, Commands, JSON Validation and the MCP server provider. Categories AI and Chat; tags include llm, mcp, mcp-server, model-context-protocol and vibe-coding. The Manifest and Configuration tabs exist only for MCP gallery servers, not for an extension's provider (VS Code source: mcpServerEditor.ts). |
| JSON schema | In the newly created config, request completion and hover over every field, including governance.alwaysAsk and governance.neverAsk. Temporarily enter the wrong type for a known field. Undo the edit. | Completion, hover descriptions and validation work for every field; the configuration returns to valid JSON. |
| Setup reset | Run Reset Setup State, cancel once, then confirm. Run Set Up Coding CLIs. | Cancellation changes nothing. Confirmation clears remembered choices and welcome dismissal without restarting. CLIs retain their sign-ins; no registrations are written. |
| Welcome | After reset, observe readiness. For a profile with no ready CLI, dismiss welcome normally, reactivate, then choose Don't Show Again and reactivate. | A ready CLI suppresses welcome. Otherwise it repeats on activation until ready or explicitly dismissed. No model turn runs during readiness checks. A profile with ready CLIs cannot verify the missing-CLI branch. |
| MCP refresh | Start CoAgent8 from MCP: List Servers and call doctor. Change Config Path and call doctor again without restarting anything. | Exactly one server definition and six tools; the server uses the selected file. Other MCP servers remain available. Capture server output if startup fails. |
| Manual MCP definition | If testing a manual registration, use the editor's MCP UI to add it and then remove only that test entry. | The manual definition takes precedence over the extension provider; removal restores the provider. No duplicate CoAgent8 definition. |
| Quiet operation | Run consultation and current-workspace review while typing in another application. Approve model consent only if you choose to spend that turn. | No visible console or focus loss. Record backend/version, completion or timeout, and observed review verdict. BLOCKED/PARTIAL is not review approval. |
| Uninstallation and reinstallation | Optionally preview/remove unchanged owned registrations first. Uninstall the extension, use the native Extensions view restart if requested, then quit and start VS Code. Check `%APPDATA%\Code\User\globalStorage\okidev.coagent8-mcp`. Reinstall the VSIX. | Extension and its provider disappear. Other extensions, MCP entries and CLI sign-ins survive. A persistent Restart Required banner is FAIL. After the restart the storage folder no longer exists. The reinstalled extension behaves like a first installation: welcome when no CLI is ready, no remembered CLI choice, default configuration. |

The one-off reset of historical CoAgent8 IDs in the owner's Default profile is
separate from Reset Setup State. Run the prepared offline script only after
closing every VS Code window, from an external PowerShell. It backs up the exact
changed rows and preserves unrelated profile values; it does not delete profile
databases. This session cannot continue inside an editor that has been closed.
