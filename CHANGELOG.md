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


### Changed
- [`6ccfd91`](https://github.com/oktawianwybieralski/coagent8/commit/6ccfd91df94882934d0048788fea97e7fcf58e5d) **src:** Group backend files per CLI and split shared modules
- [`4f0027c`](https://github.com/oktawianwybieralski/coagent8/commit/4f0027c6238ae87e435c999ec4db1c38999faeac) **src:** Place type definitions next to the modules that own them
- [`137a3f3`](https://github.com/oktawianwybieralski/coagent8/commit/137a3f3df7fbae9403872539db1f30b936e886b5) **src:** Import symbols from the modules that define them
- [`2ebb6ba`](https://github.com/oktawianwybieralski/coagent8/commit/2ebb6bae8674830e05eff98f75593dc04d68fc97) **src:** Delete dead code found by the audit
- [`7ad4eac`](https://github.com/oktawianwybieralski/coagent8/commit/7ad4eacc9034784a92c630dfad83e7dd370b160d) **src:** Drop StreamReducer line framing and test-only collector API
- [`b99782d`](https://github.com/oktawianwybieralski/coagent8/commit/b99782df904945062dd2760cfdb4a1f0afc8eb42) **src:** Stop exporting declarations used only in their own module
- [`5ab841f`](https://github.com/oktawianwybieralski/coagent8/commit/5ab841f212287daafe9406917c1cd61f41b760ee) **build:** Bundle the MCP server with tsdown and ship license notices separately

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
