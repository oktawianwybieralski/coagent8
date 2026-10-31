# P1: CoAgent8 quality gate

CoAgent8 project rule. It adds scopes and checks to
[core rule 04](core/04-quality-gate.md) and never removes one. The commands are
listed in [`.agents/project.md`](../project.md#commands).

## Additional scopes

| Scope | Required local evidence |
| --- | --- |
| Installation commands or executable examples | The prose checks plus focused verification of the changed behavior, in an isolated environment when needed. Report commands not executed. |
| TSDoc or documentation tooling | `npm run lint:docs` and `npm run docs`; typecheck and runtime checks when executable code changed too. |
| Runtime logic, schemas, adapters or routing | Typecheck and focused behavioral tests; build when bundle compatibility is affected. Broaden for shared contracts or unresolved integration risk. |
| Process lifecycle, cancellation, sandbox, privacy or sessions | Typecheck and the relevant unit, integration and failure-path tests on the affected platforms. Verify owned cleanup and hidden Windows descendants. |
| Dependencies, build, package contents or entry points | Typecheck, `npm run check:dependencies`, build, package inspection, `npm run test:consumer` and the affected regression tests. Package safety is not limited to changes in `src/`. |
| A runtime change that reaches the package (tool list, skills, exports) | Everything CI runs after the tests: `npm run docs`, `npm run build`, `npm pack --dry-run`, `npm run test:consumer`, `node scripts/publish-npm.cjs --dry-run`, `npm run package:vscode`. |
| VS Code or setup integration | The relevant setup and provider tests and the build and package checks; real host acceptance for changed installation, update or repair claims, in isolated profiles that keep working registrations. |
| Test harness or CI | Discovery, selection and cleanup regressions and the affected suite; the required status checks stay valid. |

Whatever the scope, run `npm run changelog:check` before every push and preview
the PR title with `npm run changelog:check -- --with-commit "<PR title>"`
before opening a PR or changing its title
([rule 12](12-release-workflow.md#6-changelog)). Both only read the Git history,
so they apply to prose-only changes too.

## Test runner

`node tests/run.cjs <file>...` runs only the listed test files; with no file
arguments it discovers the full inventory. Concurrency defaults to two test
files and can be overridden with `--test-concurrency=N`. CI runs the suite once,
under coverage. Never run the full suite concurrently with a CoAgent8 review.

## Source, bundle and artifact provenance

Most unit tests import `src/` through tsx, and the MCP end-to-end fixtures
launch source. Setup and integration checks can execute `dist/index.cjs`; build
first when testing them against current runtime changes. `npm test` does not
rebuild `dist/`, and a source-loaded pass does not establish the provenance of a
pre-existing bundle. A build after a suite run cannot make that run fresh-dist
evidence.

The consumer smoke installs a tarball in an isolated environment with fixture
CLIs. It verifies package contents and compares the supplied bundle with
freshly built source. Keep the manifest and artifact SHA-256 and record whether
the smoke packed a new artifact or checked a supplied one. Fixtures establish
protocol behavior, not native CLI authentication, sandbox isolation or host UI.
Restart MCP clients that keep an old bundle before live integration acceptance.

`.artifacts/` holds only what project scripts write there: build and packaging
output, coverage, API documentation and acceptance evidence. Agents keep their
scripts, logs, PR body drafts and notes in their session scratch directory, so
that removing `.artifacts/` before a clean rebuild loses nothing and packaging
never picks up agent files (owner decision 2026-10-13, `PROPOSALS-001g`).
Evidence worth keeping goes into `docs/HANDOFF.md` or the PR.

## Full release gate

For a release candidate, a shared-runtime overhaul or another change whose risk
spans the whole package, run on a clean checkout:

```bash
npm run typecheck
npm run build
npm test
npm pack --dry-run
npm run test:consumer
```

Validate required assets and exclusions, bundled runtime loading and the exact
tarball intended for distribution, with the applicable coverage, documentation
and VSIX checks. Release governance in [rule 12](12-release-workflow.md) also
requires the six supported OS/Node jobs, soak evidence and independent review.
Record platform, Node version, base, candidate and tree hashes, artifact SHA-256
and check results. Candidate content changes invalidate release approval.
