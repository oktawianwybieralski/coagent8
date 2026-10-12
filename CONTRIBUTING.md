# Contributing to CoAgent8

Bug reports, documentation improvements and focused code changes are welcome.
Before starting substantial work, check the [roadmap](docs/ROADMAP.md) and open
an issue to discuss scope with the maintainer. The roadmap is the active plan;
the [architecture](docs/ARCHITECTURE.md) defines contracts and the
[handoff](docs/HANDOFF.md) records current work and evidence.

## Reports and questions

Use the [bug-report form](https://github.com/oktawianwybieralski/coagent8/issues/new?template=bug_report.yml)
for ordinary bugs. Include reproduction steps, expected and actual behavior,
CoAgent8 and backend versions, operating system and Node.js version. The `issue`
tool can prepare a sanitized draft; check it for private information before
submitting. Use GitHub Issues for proposals and usage questions too.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) and report
privately. Do not put credentials, private code or session archives in public
reports.

## Local development

Use Node.js 24.11+ or 26+. In your checkout, install dependencies and build:

```bash
npm ci
npm run build
```

The built server is `node dist/index.cjs`. Restart a running MCP server after
rebuilding. An untagged source checkout is a development build, not a release.
Use isolated test profiles and preserve existing client registrations and data.

## Branches and pull requests

1. Create a topic branch from the current `develop`, such as
   `fix/short-description` or `docs/short-description`. There is no `main` branch.
2. Keep the change focused and follow [AGENTS.md](AGENTS.md) and its linked rules.
   Source, comments and documentation must be in English.
3. Use Conventional Commits for commit subjects and the PR title. Do not add
   attribution to AI tools in commits or PR descriptions.
4. Run the checks appropriate to the change, inspect the diff and verify links.
5. Before pushing, run `npm run changelog`. If `CHANGELOG.md` changes, commit
   only that file as `chore(changelog): regenerate`; never edit it manually.
6. Before opening a PR, run
   `npm run changelog:check -- --with-commit "<PR title>"`. A failure blocks
   submission. Documentation-only titles are omitted from the generated entries.
7. Open a PR targeting `develop`, as a draft if work or verification is incomplete.
   Describe the problem, change, related issues, verification and risks using the
   [required PR sections](.agents/rules/02-git-workflow.md#3-pull-requests).

Required CI checks and independent review must pass before merge. The author
cannot provide their own independent approval. The maintainer integrates changes
through squash merges; release tagging and publication are owner actions.
See the [Git workflow](.agents/rules/02-git-workflow.md) for release lines,
backports and the full process.

## Verification by scope

The [quality gate](.agents/rules/04-quality-gate.md) defines required checks.
Markdown prose needs content and link review plus `git diff --check`, without
runtime tests, builds or backend model calls solely for documentation edits.

Runtime changes need type checking and focused behavioral tests. For example,
`npm run typecheck` checks types and `node tests/run.cjs <file>...` runs the listed
test files. Build before checks that execute the bundle. Process, sandbox,
packaging and integration changes have additional requirements in the quality
gate; releases retain the full package and supported CI matrix gates.

Report checks as PASS, FAIL or NOT_RUN, with reasons for omissions. Do not weaken
tests to obtain a pass or treat a planned capability as implemented. Update the
owning documentation when behavior or contracts change.
