# CoAgent8 Mock CLI Test Fixtures

This directory contains standalone mock executables for external coding CLI engines:

- `claude-cli/claude.cjs` (Claude Code mock double)
- `codex-cli/codex.cjs` (OpenAI Codex CLI mock double)
- `agy-cli/agy.cjs` (Antigravity CLI mock double)

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

The runner derives a hermetic environment through `tests/helpers/environment.cjs`:
CLI overrides point to these fixtures, home/config roots are disposable, API keys
are removed, and PATH retains Node, Git and OS tools. Launch through `tests/run.cjs`
instead of bypassing that isolation. Fixtures model protocols and failure paths;
they do not prove native authentication, external MCP isolation or UI acceptance.
Recorded CLI transcripts under fixture subdirectories are dated historical evidence.
`prices/openrouter-models.json` abridges the OpenRouter model list of 2026-10-07 to
the models the fixtures name (id and pricing only) and adds `fixture/fixture-model`
for test doubles; the runner points `coagent8_PRICES_URL` at it, so no test reads
prices from the network.

Most unit/e2e checks load current `src/` via tsx. Setup checks use `dist/index.cjs`
and need a prior build for current-bundle evidence. Consumer smoke installs and
checks the tarball, also with fixtures. See the
[provenance policy](../../.agents/rules/04-quality-gate.md#source-bundle-and-artifact-provenance).

The shared runner limits concurrent test files to two because each suite can own
CLI process trees. Pass `--test-concurrency=N` for an
explicit stress run; all production and test deadlines remain unchanged.
