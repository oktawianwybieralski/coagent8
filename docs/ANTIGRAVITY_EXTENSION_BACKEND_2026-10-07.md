# Antigravity extension backend investigation (2026-10-07)

**Status:** Investigation record for `ANTIGRAVITY-HUB-001` in the
[roadmap](ROADMAP.md). It is evidence, not a plan; the roadmap stays the single
active plan. Nothing here is independent review, release acceptance or support
for an execution path through the Antigravity extension.

**Inspected:** VS Code extension `google.google-antigravity` 1.7.0
(`extension.js`, `bridge.js`, `package.json`), the `agy` 1.3.1 executable that
the extension installed in `~/.gemini/bin`, and one running hub started by that
extension on Windows 11 Pro 26200. The installed extension, user settings, MCP
registrations, conversations and credentials were not modified.

Evidence classes used below:

- **Static** - read from the installed files, including protobuf descriptors
  decoded from `extension.js` and from the `agy` executable.
- **Live** - observed against the running hub without a CSRF token, without a
  model turn and without changing state.
- **Unverified** - inferred or proposed; not executed.

## Verdict

**Technically reachable, but currently incompatible with the CoAgent8
execution contract.** CoAgent8 must not execute turns through the Antigravity
extension or its running hub.

**Viable with named limitations:** reuse the `agy` executable that the
extension installs and keeps updated, through the existing CLI transport
(`--sandbox`, explicit `--model`/`--effort`, consent before the turn, owned
process cancellation). This is implemented as a resolution fallback; see
[Implemented change](#implemented-change).

Strongest evidence:

1. The exported API is only `{ csrfToken, port }` (static). There is no
   exported execution, session, cancellation or policy API.
2. Execution exists only in the hub's private Connect service
   `exa.language_server_pb.LanguageServerService` (327 methods), whose schema is
   not shipped in the extension; it was recovered from descriptors embedded in
   `agy` (static). It is the internal protocol of the Antigravity web UI and of
   Google's own agent skills, with no third-party compatibility contract.
3. The hub is not a capability boundary. An unauthenticated `GET /` returns the
   web UI with the CSRF token embedded in its configuration (live), and `agy`
   carries `ANTIGRAVITY_LS_ADDRESS`/`ANTIGRAVITY_CSRF_TOKEN` for agent tool
   environments, with a bundled skill that drives the hub through `curl`
   (static). A turn with shell access could therefore call the hub outside any
   per-turn profile (unverified, not attempted).
4. Read-only controls are optional request fields in that private schema. No
   verified operation reports the effective tool, sandbox and MCP profile
   before a model turn.
5. The hub shares the user's state: global MCP servers
   (`~/.gemini/config/mcp_config.json`, where `coagent8 setup` registers
   CoAgent8), plugins, rules, memories, permission grants and the conversation
   list. Recursive invocation of CoAgent8 is therefore possible by default.

## Integration surfaces

| Surface | Access | Enables | Stability evidence | Limitations | Verification |
| --- | --- | --- | --- | --- | --- |
| Exported API | `vscode.extensions.getExtension('google.google-antigravity')`, then `exports` or `activate()` | `csrfToken` (fixed per extension-host lifetime) and a `port` getter (undefined until started, after a crash and during restart) | Documented in the bundle as "Public API exposed ... upon activation" | `activate()` awaits backend prewarm, which can download or update `agy` and wait up to `antigravity.serverStartupTimeoutMs`; only an extension host can call it | Static |
| Registered commands | `vscode.commands.executeCommand` from another extension | `startNewConversation`, `openConversation(cascadeId, path)`, `addContext(...)`, `triggerSend` | Mostly not contributed in `package.json` | Operate on the user's chat view and input; `triggerSend` focuses the view; no result retrieval or per-call isolation. This is UI automation | Static |
| Dynamic commands | `antigravity.dynamic.<id>` | Commands listed by the loaded webview (`ListCommands`) | Registered only after a webview exists | Depend on UI state; same objections as above | Static |
| Iframe RPC | postMessage Connect between extension host and the web UI iframe | `AntigravityApi` (17 methods, for example `NewConversation`, `AddContext`, `TriggerSend`, `SendCommand`) and `ExtensionApi` (37 host callbacks) | Internal to the extension and its web UI | Not reachable from another extension or process | Static |
| Hub HTTP | `http://127.0.0.1:<port>` | `/healthz` (JSON with `status` and `instanceId`), `/` (web UI), Connect JSON RPC | Internal protocol | See below | Live (health, CSRF rejection) and static (schema) |
| Hub RPC | `POST /exa.language_server_pb.LanguageServerService/<Method>`, `Content-Type: application/json`, header `x-codeium-csrf-token` | Full agent control: create, message, cancel, delete, read conversations; models; MCP; settings | Private; no versioning promise; the executable updates on each backend start | Shared user state; no verified read-only enforcement | Live: missing or invalid token returns HTTP 401 `unauthenticated` |
| Second loopback listener | Another `127.0.0.1` port of the hub process | Unknown; it answers plain HTTP with "Client sent an HTTP request to an HTTPS server" | None | Not identified | Live (metadata only) |
| `ChatClientServerService` | `StartChatClientRequestStream`, a server stream from hub to IDE client | Pushes `add_cascade_input`, `send_action_to_chat_panel` and similar requests to the IDE | Internal | Reverse direction; not an execution API | Static |
| Managed `agy` executable | `~/.gemini/bin/agy` (`agy.exe` on Windows) | The same CLI that CoAgent8 already runs with `--sandbox` | Installed and updated by the extension from a release manifest with a mandatory SHA-512/SHA-256 check; signature verification is not wired | Replaced when the extension starts its backend; may be stale after the extension is removed | Live: resolution, `--version` 1.3.1 and `agy models` |
| Cloud | Hub to Google services | Model calls, quota, sign-in | Not inspected | Out of scope | Not inspected |

`antigravity.serverUrl` and `ANTIGRAVITY_SERVER_URL` override the effective URL
for the web UI and health checks (static). They are read by the code but not
contributed as a setting, and they do not change the exported `port`.

## Protocol map

Only names decoded from descriptors are listed.

1. **VS Code commands** - see the table above.
2. **Exported API** - `csrfToken: string`, `get port(): number | undefined`.
   The hub is launched as
   `agy --hub --hub-port=<port> --app_data_dir=antigravity --csrf_token=<token>`
   plus `--add-dir=<folder>` per workspace folder and `antigravity.serverArgs`.
   The extension writes this full command line, including the token, to its
   `Antigravity` output channel and console.
3. **Iframe RPC** - package `gemini_coder.agent_ui_toolkit.iframe`, services
   `AntigravityApi` and `ExtensionApi`, transported by postMessage.
4. **Hub protocol** - package `exa.language_server_pb`, Connect over HTTP/1.1
   with JSON bodies; streams use Connect streaming. Relevant methods:
   - Session: `StartCascade` (`workspace_uris`, `requested_model`,
     `cascade_id`, `parent_conversation_id`, `custom_agent_spec`, ...) returns
     `cascade_id`; `DeleteCascadeTrajectory(cascade_id)`;
     `GetAllCascadeTrajectories`; `ForkConversation`.
   - Prompt: `SendUserCascadeMessage` (`cascade_id`, `items`, `cascade_config`,
     `blocking`, `client_type`, `propagate_error`, ...); the response is empty.
   - Events and results: `StreamCascadeReactiveUpdates` (reactive component
     diff stream), `GetCascadeTrajectory` (`trajectory`, `status`
     `CascadeRunStatus`, step counts), `GetCascadeTrajectorySteps`,
     `WaitForConversationFullyIdle` (`inactivity_timeout_seconds`, returns
     `timed_out`).
   - Cancellation: `CancelCascadeInvocation(cascade_id, kill_background_tasks)`,
     `CancelCascadeSteps`, `ForceStopCascadeTree(conversation_id)`.
   - Models: `GetAvailableModels`, `GetCascadeModelConfigs`,
     `GetModelStatuses`.
   - Policy fields (requests only): `CascadeConfig.planner_config.tool_config`
     with `write_to_file.force_disable`, `code.force_disable`/`apply_edits`,
     `run_command.force_disable`/`read_only_sandbox`, `mcp.force_disable`,
     `invoke_subagent.enabled`, `notebook_edit.enabled`,
     `antigravity_browser.enabled` and `permission_config`;
     `executor_config.research_only`.
   - Health and identity: `GET /healthz`, `Heartbeat`, `GetStatus`,
     `GetCapabilities`.
5. **Cloud** - not inspected.

The CSRF interceptor rejects a missing or invalid token with HTTP 401 (live).
The web UI receives the token from the hub's own page, not from the extension
(static and live). The token defends against cross-origin browser requests; it
does not authenticate one local process against another.

## Fit with the CoAgent8 contract

| Requirement | Hub path | Evidence |
| --- | --- | --- |
| Separate session without changing the user's active chat | Plausible through `StartCascade`; the conversation still appears in the user's list and shares memories, rules and plugins | Static |
| Workspace binding | `workspace_uris`/`override_workspace_uris` exist; the hub was started with the window's folders | Static |
| Request correlation and concurrency | Events and trajectories are keyed by `cascade_id` | Static; not exercised |
| Completion versus inactivity or disconnect | `CascadeRunStatus` and `WaitForConversationFullyIdle` exist; semantics of partial or disconnected runs are unknown | Static |
| Scoped cancellation | `CancelCascadeInvocation(cascade_id)` is session-scoped; it never requires stopping the shared hub | Static; not exercised |
| Read-only profile covering edits, terminal, tools and MCP | Only optional request fields; no verified read-back; shell access can reach the hub itself | Blocked |
| Inherited MCP isolation and recursion | The hub loads the user's global MCP configuration, including a CoAgent8 registration | Blocked |
| Model and effort selection verified before the turn | `requested_model` exists; effective model verification before a turn is not established | Unverified |
| Consent for expensive or unpriced models | Must stay in CoAgent8 before `SendUserCascadeMessage`; possible only after the model is verified | Unverified |
| Lifecycle | Port changes after restart; token is stable for the extension-host lifetime and changes on reload; `/healthz` `instanceId` identifies a hub instance | Static and live |
| Remote, WSL, SSH and containers | The extension declares no `extensionKind`, so it runs in the workspace extension host; the hub listens on that host's loopback. Reachability from CoAgent8 in each topology is unknown | Unverified |
| Version compatibility | No API version; the executable updates when the extension starts its backend | Static |

A prompt instruction is not a sandbox. Without enforced and observable read-only
execution, no model turn may run through this path; none was attempted.

## Architecture recommendation

Keep the CLI transport as the only Antigravity execution path:

```text
MCP client -> CoAgent8 core -> agy adapter -> CLI transport -> agy --sandbox
                                              (PATH, explicit AGY_PATH, or the
                                               extension-managed ~/.gemini/bin/agy)
```

This reuses what the extension already provides - an installed and updated
`agy`, whose sign-in is still checked separately - without depending on its
running hub, VS Code or private RPC.
Standalone MCP use, consent, redaction, bounded output and owned-process
cancellation are unchanged.

If Google publishes a supported execution API, re-evaluate the two hub options:

1. *Companion executes and forwards results.* Ties execution to the
   extension-host lifetime and requires an authenticated IPC channel from the
   MCP server to the companion. More code in the editor integration.
2. *Companion supplies endpoint metadata; CoAgent8 talks to the hub.* Keeps
   session, cancellation and result normalization in the existing core.
   Preferred, with these constraints: metadata only through the provider's
   process environment, never a discovery file; validate the endpoint with
   `/healthz` `instanceId` before each turn and fail the turn when it changes;
   cancel only with `CancelCascadeInvocation` on the owned `cascade_id`; never
   stop the hub or the extension; never replay a failed or uncertain turn
   through the CLI.

Prerequisites before any prototype model turn:

- a supported, versioned API with a compatibility promise;
- an enforced per-session profile that disables edits, terminal, browser,
  subagents and inherited MCP, verifiable by read-back before the turn;
- no route from agent tools back to the hub, or a scoped token that cannot
  create or reconfigure sessions;
- verified effective model and effort before the turn;
- conversations isolated from the user's list, memories and plugin state.

## Implemented change

`resolveCliCommand('agy')` now falls back to `~/.gemini/bin/agy` (`agy.exe` on
Windows) when PATH has no `agy`. PATH keeps precedence, explicit
`AGY_PATH`/`GEMINI_PATH` values stay authoritative and never fall back, and the
path is read on each fallback, so an update or removal is observed. The adapter
contract, sandbox flags, model selection, consent and cancellation are
unchanged.

Validation on Windows 11 Pro 26200, Node 26:

- `npm run typecheck`: PASS.
- `node tests/run.cjs tests/environment.test.js tests/execution/cli-resolver.test.js tests/execution/process.test.js tests/integrations/setup.test.js tests/integrations/vscode-extension.test.js`
  after `npm run build`: 34 pass, 2 skipped, 4 fail. The 4 failures are in
  `vscode-extension.test.js` and predate this change (its VS Code mock lacks the
  `extensions` API used by the CLI onboarding work).
- Live, metadata only, with no global `agy` on PATH: `agy` resolved to
  `~\.gemini\bin\agy.exe`; the adapter probe reported 1.3.1; `agy models`
  listed the catalog. No model turn ran.
- NOT_RUN: a model turn through the managed executable; Windows window
  observation for these launches; macOS and Linux.

## Method and limits

- Descriptors were decoded from `codegenv2.fileDesc()` blobs in `extension.js`
  and from raw `FileDescriptorProto` bytes in `agy.exe`; method and field names
  above come from those descriptors, not from string scraping.
- Live requests: `GET /healthz`, and `POST .../GetStatus` with no token and with
  an invalid token. One `GET /` inspected whether the page embeds the token; the
  token was not used. The session transcript contains a 12-character prefix of
  that token from an imperfect redaction filter; reloading the VS Code window
  rotates it.
- No companion extension host was run, so `getExtension(...).exports` was not
  read live. No UI automation, command execution against the user's chat,
  process command-line reading, file modification or model turn was performed.
