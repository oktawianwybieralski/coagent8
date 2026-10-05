# CoAgent Mock CLI Test Fixtures

This directory contains standalone mock executables for external coding CLI engines:
- `claude-cli/claude.cjs` (Claude Code mock double)
- `codex-cli/codex.cjs` (OpenAI Codex CLI mock double)
- `gemini-cli/gemini.cjs` (Google Antigravity / Gemini CLI mock double)

## Architectural Isolation Invariant (P2)
These test doubles are CommonJS executables (`.cjs`) that simulate subprocess communication via `stdin`/`stdout`/`stderr` and emit JSON-RPC / CLI protocols.

They live under `tests/fixtures/` and are launched explicitly by tests and consumer smoke.

### Rationale
`tests/helpers/discovery.cjs` selects only `*.test.js` under `tests/`, excluding
`fixtures`, `helpers`, `consumer`, and `artifacts` directories. `npm test` and
`npm run test:coverage` share `tests/run.cjs`, which passes individual file paths
to tsx without shell glob expansion and fails on empty discovery.

The explicit discovery contract prevents these CLI doubles from executing as
tests, including nested fixtures with test-like filenames. Resolve fixture paths
from the referring file instead of assuming the shell's current directory.

The shared runner limits concurrent test files to two because each suite can own
CLI process trees and Windows CIM workers. Pass `--test-concurrency=N` for an
explicit stress run; all production and test deadlines remain unchanged.
