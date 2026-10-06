# P1: Scope-Based Quality Verification

Local checks follow the risk and scope of the change. This rule is the single
source of verification requirements referenced by AGENTS, skills and the roadmap.
It replaces the blanket full local gate for every push/PR. Required remote checks
and branch protection must not be bypassed; CI scoping changes remain planned.

## Local change gate

Before completing work or submitting a change, inspect the diff, choose the
applicable checks below, and record their actual results. For mixed changes use
the union of affected scopes. Do not run the full suite after every file edit,
commit, branch operation or unchanged retry.

| Scope | Required local evidence |
| --- | --- |
| Markdown prose, plans, contributor rules, ordinary README edits | Review content against source, check local links and git diff --check. No typecheck, build, runtime tests, packaging, documentation generation or backend AI calls solely for prose changes. |
| Installation commands or executable examples | Document checks plus focused verification of the changed behavior in an isolated environment when needed; no automatic full suite. Report commands not executed. |
| TSDoc/source documentation or documentation tooling | lint:docs and docs for affected comments/tooling; add typecheck/runtime checks if executable code or its dependencies changed. |
| Runtime logic, schemas, adapters or routing | Typecheck and focused behavioral tests; build when runtime/bundle compatibility is affected. Broaden for shared contracts or unresolved integration risk. |
| Process lifecycle, cancellation, sandbox, privacy or sessions | Typecheck and relevant unit/integration/failure-path tests on affected platforms. Verify owned cleanup and hidden Windows descendants; preserve meaningful assertions. |
| Dependencies, build, package contents or entrypoints | Typecheck, build, package inspection, consumer smoke and affected regression tests. Package safety is not limited to changes in src/. |
| VS Code/setup integration | Relevant setup/provider tests and build/package checks; real host acceptance for changed installation/update/repair claims. Use isolated profiles and preserve working registrations. |
| Test harness or CI | Discovery/selection/cleanup regressions and the affected suite; confirm required status checks remain valid. |

`node tests/run.cjs <file>...` runs only the listed test files; with no file
arguments it discovers the full inventory. Concurrency defaults to two test files
and can be overridden with `--test-concurrency=N`. Do not replace a focused check
with repeated full runs by habit. Coverage executes tests; avoid a redundant
identical suite run unless distinct evidence is needed. Current CI still runs both.

A test that passes is evidence only for the property it measures. When a fix
addresses a measured defect, such as an audit reproduction, the regression test
must assert the measured property (for example persisted bytes or the recorded
cooldown duration), not a proxy such as string presence.

Once applicable checks pass, repeat or broaden them only for new changes, failures
or unresolved risks. Static inspection is not a runtime reproduction. Never label
an unexecuted check PASS. Retain complete failure logs; an unexplained green retry
is not a root-cause fix.

## Full release gate

For a release candidate, shared-runtime overhaul or other change whose risk spans
the complete package, run the full gate:

```bash
npm run typecheck
npm run build
npm test
npm pack --dry-run
npm run test:consumer
```

Use a clean checkout for release validation. All required checks must run and
pass. Validate required assets and exclusions,
bundled runtime loading and the exact tarball intended for distribution. Include
applicable coverage, documentation and VSIX checks; coverage may supply suite
execution evidence when it runs the same complete inventory. Do not change remote
required checks without an explicit workflow change.

Release governance in [02-git-workflow.md](02-git-workflow.md) still requires the
six supported OS/Node jobs, soak evidence and independent review. Record platform,
Node version, base/candidate/tree hashes, artifact SHA-256 and check results.
Candidate content changes invalidate release approval and require validation of
the replacement artifact. That release rule does not require full runtime testing
for each ordinary documentation revision.
