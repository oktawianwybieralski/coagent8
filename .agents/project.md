# Project parameters

The core rules in [rules/core/](rules/core/) refer to the sections below by
name. A value here may choose where a core rule leaves a choice or tighten a
core rule; it never relaxes one (agent-standards README "Precedence").

## Repository

- Integration branch: `develop`. There is no `main` (owner decision 2026-10-10).
- Release lines and tags: one line `X.Y.x` per maintained version (`1.0.x` from
  the first release candidate); releases are annotated tags `vX.Y.Z` on
  `develop` (betas) or on their line; fixes land on `develop` first and are
  backported by squash PRs ([rule 12](rules/12-release-workflow.md)).
- Issue tracker: GitHub Issues of `oktawianwybieralski/coagent8`.

## Languages

- Conversation with the owner: Polish.
- Agent to agent (consult, review, delegate): English; the calling agent answers the owner
  in Polish. The server asks backends for this (`answerLanguage`, owner decision 2026-11-01).
- UI languages: English only (CLI output, MCP tool text, VS Code extension).

## Primary sources

- MCP: the Model Context Protocol specification and
  `@modelcontextprotocol/sdk` at the version in `package-lock.json`.
- Codex CLI: the `openai/codex` repository and `codex app-server` protocol of
  the installed version (`codex --version`).
- Claude Code: the Claude Code documentation and the installed CLI's
  `--help` and stream-json output (`claude --version`).
- Antigravity CLI (`agy`): its documentation and the installed CLI's help and
  stream-json output (`agy --version`).
- VS Code extension API: the VS Code API documentation for the `engines.vscode`
  version in `extensions/vscode/package.json`.
- Node.js: the documentation of the supported versions (24 and 26).

Native CLI behavior that no documentation states is recorded with the CLI
version and date of the run that observed it.

## Reviewers

- Required: CoAgent8 `review` with backend `codex` and with backend `agy`, in
  parallel, on every reviewed head.
- P2 deferral: allowed with the owner's dated decision.

Models and efforts are not named here (core rule 03); they come from the review
tool's configuration, for CoAgent8 `~/.coagent8/config.json`.

## Standing go-aheads

- 2026-10-12: once the required reviews of a topic branch are READY and its
  local checks pass, the agent pushes the branch (fast-forward only), opens its
  PR into `develop`, pushes review fixes to it and updates its description
  without asking again. Merging follows the next item; tags, releases,
  publication, force pushes and repository settings stay with the owner.
- 2026-11-02 (the owner's instruction for every topic PR it covers): the agent
  squash-merges a topic PR into `develop` without asking again once its gate and
  CI pass and every required reviewer above is READY on its head. A reviewer that
  cannot finish (quota, deadline) is waited for, or the owner decides; the
  others never replace it (core rule 03). Bugs another agent reports are fixed
  as they come. Tags, releases, publication, force pushes and repository
  settings stay with the owner. Owner decision 2026-11-04: this departs on
  purpose from core rule 02's per-PR merge row; it is the owner's instruction,
  which the precedence in [AGENTS.md](../AGENTS.md) puts above the core rules,
  until the core rule accepts it
  ([agent-standards#5](https://github.com/oktawianwybieralski/agent-standards/issues/5)).

## Findings labels

- Kind: `bug`, `enhancement`, `documentation`, `question`, `dead-code`,
  `cleanup`, `needs-verification`
- Priority: `priority: high`, `priority: medium`, `priority: low`
- Provenance: `found-in:vX.Y.Z` (the version where it was observed)

## Backlog

GitHub Issues hold the whole backlog (owner requests 2026-11-02 and 2026-11-05): defects, findings
and every planned result, each small enough to close. A planned result (a card) is an issue with its
context, dated owner decisions, `Done when` and its open steps as a task list; a step that gets its
own PR becomes a sub-issue. Milestones: `0.8.0` (the release candidate) and `After 0.8.0`; an
issue without a milestone is not scheduled. `docs/ROADMAP.md` is the direction document: the
direction, the order of the milestones with links to their issues, and a table of the former card
identifiers. A finding issue has a title that states the problem, then what is wrong or missing,
`Evidence:` saying how it was verified and what was not, `Expected:` when it is not obvious, and
`Done when` with a condition that can be checked. It carries one kind label and,
except for questions, one priority label. Whatever a change finds and does not fix becomes an
issue, not a note in a PR. Issues, PRs and comments for people outside the project cite issue
numbers, not internal identifiers. The pinned core rules (v0.1.0) still name ROADMAP cards;
issues satisfy them, and the next standards update replaces that wording
([agent-standards#6](https://github.com/oktawianwybieralski/agent-standards/issues/6)).

## Commands

| Check | Command |
| --- | --- |
| Lint | `npm run lint:docs` (TSDoc) |
| Format | `npm run format:check`, `npm run format` (Prettier; Markdown keeps its own layout, `.prettierignore`) |
| Typecheck | `npm run typecheck` |
| Dependency boundaries | `npm run check:dependencies` |
| Tests | `npm test` (all), `node tests/run.cjs <file>...` (focused) |
| Build | `npm run build` |
| Windows job helper | `cargo build --release --examples --bins` in `native/coagent8-job` (tests on Windows), `node scripts/build-job-helper.cjs` (package) |
| API documentation | `npm run docs` |
| Package | `npm pack --dry-run`, `npm run test:consumer`, `npm run package:vscode` |
| Changelog | `npm run changelog:check`, `npm run changelog:check -- --with-commit "<PR title>"` |
| Agent standards | `node .agents/standards/agent-standards.mjs check`, `node .agents/standards/check-keyboard-characters.mjs` |
