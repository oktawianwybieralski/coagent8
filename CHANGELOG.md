# Changelog

All notable changes to CoAgent8 are documented in this file. It is generated
from the Conventional Commits history by [git-cliff](https://git-cliff.org/)
(`npm run changelog`); do not edit it by hand. Each entry starts with the commit
that introduced it.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Release procedure: [.agents/rules/02-git-workflow.md](.agents/rules/02-git-workflow.md).

## Baseline: 1.0.0-beta.1 development line ([`67d28ce`](https://github.com/oktawianwybieralski/coagent8/commit/67d28ce343c5b9bec81bedbb9f942f86e884ee54))

### Added
- Canonical tool surface: `consult` (with `task_type`), `review`, `doctor`,
  `session`, `cancel`, `issue`; compact profile through `run`.
- Plain `consult` answers with a structured `verdict` field; the State Envelope is
  enforced for `review` only.
- Generic MCP interoperability: tools are listed without a recognized client and
  without invoking a backend.
- Optional `setup`, `repair` and `status` commands for Codex, Claude Code and agy
  host registration, reused by the VS Code extension.
- Native Gemini (`agy`) quota inspection in `doctor`.
- Focused test file selection in `tests/run.cjs`.

### Changed
- Session pruning runs in the background after the MCP transport connects.
- Backend resolution no longer writes the default backend to the configuration.
- Hidden PowerShell windows for Windows process supervision and tests.
- License changed to GPL-3.0-only.

### Deprecated
- Tools `analyze`, `debug` and `implement`; use `consult` with `task_type`.
  Removal is planned for v1.1.0.

### Fixed
- Gemini sandbox-denial handling no longer reports valid results as duplicates.
- Escaped and structured Windows home paths are redacted in diagnostics.
