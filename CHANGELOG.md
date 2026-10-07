# Changelog

All notable changes to CoAgent8 are documented in this file. It is generated
from the Conventional Commits history by [git-cliff](https://git-cliff.org/)
(`npm run changelog`); do not edit it by hand. Each entry starts with the commit
that introduced it.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Release procedure: [.agents/rules/02-git-workflow.md](.agents/rules/02-git-workflow.md).

## [Unreleased]

### Breaking
- [`ca8cf88`](https://github.com/oktawianwybieralski/coagent8/commit/ca8cf88ad560307cbb511a9e9f3b66a19da8c103) **execution:** Layered owned-process termination with protocol interrupts
- [`c0c030f`](https://github.com/oktawianwybieralski/coagent8/commit/c0c030fdf70d593e5c6fd555912ad3dc8d25561e) Require Node.js 24 and test on Node 24 and 26
- [`5ba52da`](https://github.com/oktawianwybieralski/coagent8/commit/5ba52da1caf4be61e9ed568f53b4f5b7ffc12f1e) **mcp:** Remove the compact tool profile
- [`e1f83e2`](https://github.com/oktawianwybieralski/coagent8/commit/e1f83e29fae3bc5be3b88190b8a5a4d315783aeb) **errors:** Typed ToolError codes; unknown failures are PROCESS_ERROR
- [`891875b`](https://github.com/oktawianwybieralski/coagent8/commit/891875b0fccec132efb5d9f42f4fa1dd175a9471) Stop tracking dist/ and check the packed bundle against a fresh build
- [`070ad58`](https://github.com/oktawianwybieralski/coagent8/commit/070ad58fd4ceca472eebc7211b84246176e32386) **sessions:** Scope MCP resources and session list to the workspace
- [`3480af4`](https://github.com/oktawianwybieralski/coagent8/commit/3480af430a606a8e704d8daf918283ee0f7fa78c) **policy:** Ask the user for top-tier models through MCP elicitation
- [`5a14941`](https://github.com/oktawianwybieralski/coagent8/commit/5a1494104a12df86b03180ef333edbb791498ae4) **result:** Return execution results as markdown only
- [`1d3c8dc`](https://github.com/oktawianwybieralski/coagent8/commit/1d3c8dc31e8b677c83db44df8480f747356a4414) **models:** Take models and defaults from the CLIs and config.json, never from the source
- [`ce882ba`](https://github.com/oktawianwybieralski/coagent8/commit/ce882baeb85c9c534325fee275b668a2eb55d328) **consent:** Ask the user by a model's approximate price, not by its name

### Added
- [`2b17165`](https://github.com/oktawianwybieralski/coagent8/commit/2b171652b995f025c36a14ec710227cf64e3f733) **routing:** Choose another CLI than the client when auto is ambiguous
- [`81b5e2b`](https://github.com/oktawianwybieralski/coagent8/commit/81b5e2b417ae2b8b65e01c9071e3bb97796e2266) **doctor:** Summary by default, full detail, backend filter and quota switch
- [`16aca5c`](https://github.com/oktawianwybieralski/coagent8/commit/16aca5c5c6875efba64fd1a4305127007248e5d7) **mcp:** Resolve the workspace from client roots and report it
- [`49387f8`](https://github.com/oktawianwybieralski/coagent8/commit/49387f8c322b624da4d965fe009acc98d9468d0d) **tools:** Say how to call CoAgent8 right on the first attempt
- [`e414ea8`](https://github.com/oktawianwybieralski/coagent8/commit/e414ea81d00b04b90618e74b3e28ac8f4b304c08) **branding:** Support dark themes and record MCP observations

### Changed
- [`6ccfd91`](https://github.com/oktawianwybieralski/coagent8/commit/6ccfd91df94882934d0048788fea97e7fcf58e5d) **src:** Group backend files per CLI and split shared modules
- [`4f0027c`](https://github.com/oktawianwybieralski/coagent8/commit/4f0027c6238ae87e435c999ec4db1c38999faeac) **src:** Place type definitions next to the modules that own them
- [`137a3f3`](https://github.com/oktawianwybieralski/coagent8/commit/137a3f3df7fbae9403872539db1f30b936e886b5) **src:** Import symbols from the modules that define them
- [`2ebb6ba`](https://github.com/oktawianwybieralski/coagent8/commit/2ebb6bae8674830e05eff98f75593dc04d68fc97) **src:** Delete dead code found by the audit
- [`7ad4eac`](https://github.com/oktawianwybieralski/coagent8/commit/7ad4eacc9034784a92c630dfad83e7dd370b160d) **src:** Drop StreamReducer line framing and test-only collector API
- [`b99782d`](https://github.com/oktawianwybieralski/coagent8/commit/b99782df904945062dd2760cfdb4a1f0afc8eb42) **src:** Stop exporting declarations used only in their own module
- [`5ab841f`](https://github.com/oktawianwybieralski/coagent8/commit/5ab841f212287daafe9406917c1cd61f41b760ee) **build:** Bundle the MCP server with tsdown and ship license notices separately
- [`918baea`](https://github.com/oktawianwybieralski/coagent8/commit/918baea495fc4cbc39ad6e28b8447e0f9927eb2e) **mcp:** One-sentence server instructions and compact tool definitions
- [`e40950b`](https://github.com/oktawianwybieralski/coagent8/commit/e40950bc904de79beba97fd737e1a8db909a6303) **result:** Compact structured content, one-line footer and actionable consent errors
- [`f4a075e`](https://github.com/oktawianwybieralski/coagent8/commit/f4a075e8d6d10fad77daa4e3b5bce657d400f030) **prompts:** Shorter review and consult prompts with a server-filled snapshot
- [`2dc46e4`](https://github.com/oktawianwybieralski/coagent8/commit/2dc46e48c3a961936b0ea49bc4f9ae1652db7360) **result:** Shorter footer with each line as its own quoted paragraph
- [`ec7844f`](https://github.com/oktawianwybieralski/coagent8/commit/ec7844fac5e8eac5f086bc80104e276deb8ebe17) **backends:** Reuse probes across requests and read agy quota only in doctor
- [`8d2c56b`](https://github.com/oktawianwybieralski/coagent8/commit/8d2c56b9ad530f703895c9c4351a27884f650ee8) **gemini:** Keep only the runCommand deadline
- [`68be8a2`](https://github.com/oktawianwybieralski/coagent8/commit/68be8a242c8289379a1fd550664be47c8134bbbf) **startup:** Inject background maintenance instead of environment test hooks
- [`c1ed6e7`](https://github.com/oktawianwybieralski/coagent8/commit/c1ed6e7f9cf7b37946448e90a01a779e0835fd62) **tools:** Map the deprecated tools and run actions through one alias table
- [`cb8c30b`](https://github.com/oktawianwybieralski/coagent8/commit/cb8c30bdab0021175b313bba8631f39df6f64489) **backends:** One structured-error extractor parameterized per backend
- [`651df5f`](https://github.com/oktawianwybieralski/coagent8/commit/651df5f9e6fdd965eb455b72b889f23d8a177eac) **progress:** Redact each progress message once, where it leaves for the client

### Fixed
- [`0c11032`](https://github.com/oktawianwybieralski/coagent8/commit/0c1103211b9efab5872b3b2ae6bd79ca02de7014) **execution:** Enforce process identity and safe teardown on Windows
- [`2b6a4d0`](https://github.com/oktawianwybieralski/coagent8/commit/2b6a4d0e978246cfbdc5d61c1fdacbbcca17637b) **execution:** Optimize process polling and align consumer package verification
- [`cd62aaf`](https://github.com/oktawianwybieralski/coagent8/commit/cd62aaf91a8ee7f60232738e99f35a99d3358886) **gemini:** Give agy a 2 s SIGTERM grace on POSIX
- [`8555d0c`](https://github.com/oktawianwybieralski/coagent8/commit/8555d0c3dd4014aa08534b47f35dd340d0591884) **redaction:** Split credential format from diagnostic redaction
- [`991b7e4`](https://github.com/oktawianwybieralski/coagent8/commit/991b7e4f20b5919cf8440d0532907d27089ff1fe) **build:** Order license notices independently of the build locale
- [`ba7edd9`](https://github.com/oktawianwybieralski/coagent8/commit/ba7edd9853fca71d4835ec4f0bb960dbc27e6b45) **history:** Append-only streaming deltas with credential tail buffering
- [`46984f0`](https://github.com/oktawianwybieralski/coagent8/commit/46984f0a3f106fb73ffba3b32dd6d9c201017eb6) **controller:** Isolate CLI execution from archive and session bookkeeping
- [`b205085`](https://github.com/oktawianwybieralski/coagent8/commit/b205085f967bee49ed90dc2e57698c8c61114e27) **history:** Address Opus review findings on tail buffering, capacity locking, and cooldowns
- [`bd1e63c`](https://github.com/oktawianwybieralski/coagent8/commit/bd1e63c0db81bf38984b7599807474fc795a9f8a) **history:** Address lock ordering, AWS key tail buffering, and capacity accounting
- [`5f4488b`](https://github.com/oktawianwybieralski/coagent8/commit/5f4488b28714780a303867f42123ad0e29b813f0) **history:** Restore JWT and Slack prefix checks and decouple append from capacity lock
- [`0cddde5`](https://github.com/oktawianwybieralski/coagent8/commit/0cddde59d02fc71912d9ce707a25c1a5b207e225) **history:** Safely catch rollback lock errors to guarantee original io error propagation
- [`46fa155`](https://github.com/oktawianwybieralski/coagent8/commit/46fa15551dbe961e9d93e8953523469101d58e4e) **backends:** Report the model each backend resolved
- [`c1cf900`](https://github.com/oktawianwybieralski/coagent8/commit/c1cf9007b1e46f6224d9c394f232b89e51455460) **gemini:** Keep the answer when the sandbox denies an action
- [`1f5ea07`](https://github.com/oktawianwybieralski/coagent8/commit/1f5ea07908d87f9501b3efa4549a9bf1c359e14b) **setup:** Raise the Codex tool timeout for CoAgent8 to 30 minutes
- [`abcff7d`](https://github.com/oktawianwybieralski/coagent8/commit/abcff7d142b2f4bee2d1e1678030e50c12a900fa) **routing:** Record one cooldown per rate-limited turn with the parsed reset
- [`bc04df9`](https://github.com/oktawianwybieralski/coagent8/commit/bc04df9159dd2dbcb19f6dad09e2fa1f7f19c45b) **codex:** Read the default model from config.toml with a TOML parser
- [`9cdb710`](https://github.com/oktawianwybieralski/coagent8/commit/9cdb710bb1a3b05229cb88089194077dca4a2935) **backends:** Reject option-like model identifiers before they reach a CLI
- [`d23ad1b`](https://github.com/oktawianwybieralski/coagent8/commit/d23ad1bb91a720d5ee1fce18d6d180315c2e1f6d) **gemini:** Ignore unknown agy event types with a warning
- [`35f015c`](https://github.com/oktawianwybieralski/coagent8/commit/35f015cb8bb65eec8c2ec8722296ac7798fdaa6e) **locks:** Publish leases atomically, renew them and reclaim stale ones by age
- [`cb0f723`](https://github.com/oktawianwybieralski/coagent8/commit/cb0f72326f71fbebe246876d0da680841249d485) **backends:** Classify CLI errors by anchored phrases and parse ms and decimal resets
- [`d88c07d`](https://github.com/oktawianwybieralski/coagent8/commit/d88c07dbe62c265c6ce1477617bcd7b33c159698) **gemini:** Treat a usage window without remaining_fraction as unmeasured
- [`96ebcfd`](https://github.com/oktawianwybieralski/coagent8/commit/96ebcfd99f0b687bacffa59722223d6d370e0ff4) **errors:** Remove dead catches and report the failures that were ignored
- [`8b43688`](https://github.com/oktawianwybieralski/coagent8/commit/8b436883d4655deadf25159acbb6008a849efe33) **config:** Report an unusable configuration in doctor and refuse execution
- [`07db345`](https://github.com/oktawianwybieralski/coagent8/commit/07db345b3b504c2936da0143bd53dc02834cb373) **history:** Replace empty catches with explicit absence and cache handling
- [`967a0e5`](https://github.com/oktawianwybieralski/coagent8/commit/967a0e53859fb25192432cd15f63b5f2a7bb63a2) **mcp:** Stop declaring resource list notifications that are never sent
- [`ee51b52`](https://github.com/oktawianwybieralski/coagent8/commit/ee51b5248ff10fcb14dd7ee32aec5589d489a8e1) **process:** Report POSIX group signal failures and skip the grace for an exited group
- [`cc95c1e`](https://github.com/oktawianwybieralski/coagent8/commit/cc95c1e9e9ced39d320e1e7b4f0e41f4f9834f2d) **result:** Keep answer lines that quote npm notices or update banners
- [`21e6bab`](https://github.com/oktawianwybieralski/coagent8/commit/21e6bab365f0e7255cc34fcf42d5980417e6deae) **session:** Report cancelled only when a running turn was stopped or released
- [`26ac5fd`](https://github.com/oktawianwybieralski/coagent8/commit/26ac5fd9fadd79f880bbf7215b9bb2e607637a07) **session:** Show workspace paths under the home directory as ~ in session lists
- [`e5a89f0`](https://github.com/oktawianwybieralski/coagent8/commit/e5a89f00a95d09633d965e9efdc4ace456574ca9) **errors:** Type rejected models and drop the invented answer of a failed run
- [`8d12ee6`](https://github.com/oktawianwybieralski/coagent8/commit/8d12ee6ec2f1262519469952ac1049f8cefbf6bb) **models:** Check model and effort against the catalog the CLI reports
- [`50f2146`](https://github.com/oktawianwybieralski/coagent8/commit/50f214636295065102c886b982335163f779c1c7) **codex:** Return the final answer without the turn's commentary
- [`bf73c79`](https://github.com/oktawianwybieralski/coagent8/commit/bf73c79aa0b7ed0566e4dbaef37c2e45d11069fb) **consult:** Pass a plain question on as asked
- [`2437d98`](https://github.com/oktawianwybieralski/coagent8/commit/2437d98886a4e7e7d08dba163ff867153cda4823) **result:** Name the requested model in the footer of a refused call
- [`d811099`](https://github.com/oktawianwybieralski/coagent8/commit/d811099477da70e79f431238a46b6740a4c65e85) **consent:** Accept only an explicit approve: true as the user's consent
- [`690b3d0`](https://github.com/oktawianwybieralski/coagent8/commit/690b3d022364eba3c063bd91db89f5d5803bf06f) **session:** Keep the session's reasoning effort on a continuation
- [`dcf9a90`](https://github.com/oktawianwybieralski/coagent8/commit/dcf9a90f3605419f0465cc7e9005c30dee4b481b) **gemini:** Disable agy's auto-updater, whose console window takes the focus
- [`0c89f70`](https://github.com/oktawianwybieralski/coagent8/commit/0c89f7063f8351012be36e821eb158ecfed62b6c) **consent:** Report a cancelled approval request as unanswered, not declined
- [`84bd6cf`](https://github.com/oktawianwybieralski/coagent8/commit/84bd6cf9ca13de348ae9536ac01ef4c86f7e8afc) **vscode:** Clarify CLI names and embed private preview logo
- [`7028da8`](https://github.com/oktawianwybieralski/coagent8/commit/7028da85fe3a05d1473fe9518e8bef153963458c) **vscode:** Use the new okidev publisher

## [1.0.0-beta.1] - 2026-10-05 ([`v1.0.0-beta.1`](https://github.com/oktawianwybieralski/coagent8/tree/v1.0.0-beta.1))

### Added
- Canonical tool surface: `consult` (with `task_type`), `review`, `doctor`,
  `session`, `cancel`, `issue`; compact profile through `run`.
- Plain `consult` answers with a structured `verdict` field; the State Envelope is
  enforced for `review` only.
- Generic MCP interoperability: tools are listed without a recognized client and
  without invoking a backend.
- Optional `setup`, `repair` and `status` commands for Codex, Claude Code and agy
  host registration, reused by the VS Code extension.
- Claude Code backend in restricted read-only mode with streaming and resume.
- Claude Code subscription quota read from `/usage` before routing.
- Native Gemini (`agy`) quota inspection in `doctor`.
- Focused test file selection in `tests/run.cjs`.

### Changed
- Session pruning runs in the background after the MCP transport connects.
- Backend resolution no longer writes the default backend to the configuration.
- Hidden PowerShell windows for Windows process supervision and tests.
- License changed to GPL-3.0-only.
- Product and npm package renamed to CoAgent8 (`coagent8`).

### Deprecated
- Tools `analyze`, `debug` and `implement`; use `consult` with `task_type`.
  Removal is planned for v1.1.0.

### Fixed
- Gemini sandbox-denial handling no longer reports valid results as duplicates.
- Escaped and structured Windows home paths are redacted in diagnostics.
- Claude Code events require `init`, `inspectQuota` is version-gated and
  sessions are hardened.
- Adapter startup errors keep their diagnostics; billing failures map to
  authentication errors.
