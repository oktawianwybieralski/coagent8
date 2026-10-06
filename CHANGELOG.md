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

### Fixed
- [`0c11032`](https://github.com/oktawianwybieralski/coagent8/commit/0c1103211b9efab5872b3b2ae6bd79ca02de7014) **execution:** Enforce process identity and safe teardown on Windows
- [`2b6a4d0`](https://github.com/oktawianwybieralski/coagent8/commit/2b6a4d0e978246cfbdc5d61c1fdacbbcca17637b) **execution:** Optimize process polling and align consumer package verification
- [`cd62aaf`](https://github.com/oktawianwybieralski/coagent8/commit/cd62aaf91a8ee7f60232738e99f35a99d3358886) **gemini:** Give agy a 2 s SIGTERM grace on POSIX

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
