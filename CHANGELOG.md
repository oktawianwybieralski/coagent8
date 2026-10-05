# Changelog

All notable changes to CoAgent are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Release procedure: [.agents/rules/02-git-workflow.md](.agents/rules/02-git-workflow.md).

## [Unreleased]

Planned as `1.0.0-beta.1`. Release is blocked by the open audit findings listed
in [docs/ROADMAP.md](docs/ROADMAP.md#audit-remediation-index).

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
- Claude Code subscription quota in `doctor` and `smart_quota` routing, read
  from `claude -p /usage` without a model call through a new optional
  `CliAdapter.inspectQuota()`; quota window summarizing is shared with Gemini.

### Changed
- Claude Code backend runs in `--restricted` read-only print mode instead of
  `--bare`, so a claude.ai subscription login works without an API key. It now
  streams public events (`stream-json`), resumes native sessions
  (`--session-id`/`--resume`), passes `--effort`, validates model identifiers
  before argv, checks the read-only profile on every run, maps failures from
  structured CLI output, and probes with `--version` and `claude auth status`
  instead of `--bare --help` inside each execution.
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

### Security
- Known issues found by the independent audit at `c265cdf` (Windows process
  teardown identity, output redaction, history growth) are tracked in
  [docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md#7-known-deviations-audit-at-c265cdf)
  and must be fixed before this release.
