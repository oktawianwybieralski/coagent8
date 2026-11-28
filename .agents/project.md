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

## Agent roles

Owner decision 2026-11-26 (adopted from the owner's practice of 2026-11-25 in
another repository): the agent the owner talks to coordinates, another agent
implements and a third reviews, so the coordinator spends its effort on
judgement rather than typing code.

- Coordinator (the owner's session): picks the next issue, writes the task
  spec, delegates, checks the result, commits, pushes, opens and merges the PR,
  watches CI and keeps the rules, docs and issues current. It is answerable for
  every change it commits; the owner stays the author (core rule 02).
- Implementer: CoAgent8 `delegate` with backend `agy`. It edits code, tests and
  docs and drafts the PR body; it does not commit, push or open PRs.
- Reviewer: CoAgent8 `review` with backend `codex` (see "Reviewers"), and
  CoAgent8 `consult` with backend `codex` on the plan of a non-trivial issue.

Owner decisions 2026-11-27 and 2026-11-28: `agy` implements every change,
and `codex` reviews it; nothing is delegated to `claude`, whose usage is saved
(owner, 2026-11-28). A change to a boundary where a mistake directly exposes
the user (the consent to run on the host, model consent and cost governance
([rule 11](rules/11-security-and-sandboxes.md)), secret redaction, the
isolation of turns from the user's own tools, files and MCP servers, and the
publication tooling that holds registry credentials
([rule 12](rules/12-release-workflow.md))) gets the same `agy` implementation
and `codex` review, and the coordinator checks its diff with extra care for
the area's invariants. Every change gets the `codex` review and the
coordinator's own check of the diff after it. Native runs of the claude CLI,
when evidence needs one, are done by the coordinator, since an agy turn sees
CoAgent8's agy profile as `USERPROFILE` on Windows (#224).

Parallel work (owner decision 2026-11-27): each task gets its own git worktree
in `../coagent8-worktrees/<type>-<short-name>` from `origin/develop`, and its
delegate runs there (`workspace_path`); the main checkout stays the owner's.
The coordinator removes the worktree and its branch once the PR is merged and
`develop` is green.

The task spec is self-contained: the issue, its `Acceptance criteria` and dated
decisions quoted; the branch and base commit; the allowed paths (`scope`) and
what is out of scope, with "stop and report" when the task needs more; the
pattern to follow and the rules that apply; the exact check commands
(`checks`); and what to return: changed paths, assumptions, each check as PASS,
FAIL or NOT_RUN with its reason, and a PR body draft. One delegate session per
worktree at a time; the coordinator runs the long suites itself.

The coordinator reads the whole diff and the list of changed and untracked
files against the scope; the implementer's summary is an index, not proof. A
confirmed review finding goes back to the implementer's session
(`session_handle`) quoted with its severity and location. The coordinator does
the work itself, or narrows the task first, when it updates dependencies or the
implementer fails twice on the same task. After the review is READY, the
coordinator still judges the change itself: it solves the issue, follows the
pattern and the rules, is not overbuilt, and its tests prove the acceptance
criteria. A READY review alone never merges a change.

## Reviewers

- Required: CoAgent8 `review` with backend `codex` on every reviewed head
  (owner instructions 2026-11-26 and 2026-11-27), followed by the coordinator's
  own check of the change (Agent roles). The `agy` review is no longer
  required, since `agy` now implements the change.
- P2 deferral: allowed with the owner's dated decision.

Owner decision 2026-11-21 (#208, #211): reviewers run on the host without a
read-only sandbox, like every other role; this replaces the read-only mode of core
rule 03 for this project. A review stays a separate session that leaves the
workspace as it found it, and the server checks its snapshot again after the turn.

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
  CI pass, every required reviewer above is READY on its head and the
  coordinator has judged the change (Agent roles). A reviewer that
  cannot finish (quota, deadline) is waited for, or the owner decides; the
  others never replace it (core rule 03). Bugs another agent reports are fixed
  as they come. Tags, releases, publication, force pushes and repository
  settings stay with the owner.

## Findings labels

- Kind: `bug`, `enhancement`, `documentation`, `question`, `tech-debt`,
  `needs-triage`
- Priority: `priority: high`, `priority: medium`, `priority: low`
- Provenance: `found-in:vX.Y.Z` (the version where it was observed)

## Backlog

GitHub Issues hold the whole backlog (owner requests 2026-11-02 and 2026-11-05): defects, findings
and every planned result, each small enough to close. A planned result (a card) is an issue with its
context, dated owner decisions, `Acceptance criteria` and its open steps as a task list; a step that gets its
own PR becomes a sub-issue. Milestones: `0.8.0` (the release candidate) and `1.0.0`; an
issue without a milestone is not scheduled. `docs/ROADMAP.md` is the direction document: the
direction, the order of the milestones with links to their issues, and a table of the former card
identifiers. A finding issue has a title that states the problem, then what is wrong or missing,
`Evidence:` saying how it was verified and what was not, `Expected:` when it is not obvious, and
`Acceptance criteria` with a condition that can be checked. It carries one kind label and,
except for questions, one priority label. Whatever a change finds and does not fix becomes an
issue, not a note in a PR. Issues, PRs and comments for people outside the project cite issue
numbers, not internal identifiers.

## Commands

| Check | Command |
| --- | --- |
| Lint | `npm run lint:docs` (TSDoc) |
| Format | `npm run format:check`, `npm run format` (Prettier; Markdown keeps its own layout, `.prettierignore`) |
| Typecheck | `npm run typecheck` |
| Dependency boundaries | `npm run check:dependencies` |
| Tests | `npm test` (all), `node tests/run.cjs <file>...` (focused) |
| Build | `npm run build` |
| Windows job helper | `cargo build --release --examples --bins` in `native/coagent8-job` (tests on Windows), `node tooling/scripts/build-job-helper.cjs` (package) |
| API documentation | `npm run docs` |
| Package | `npm pack --dry-run`, `npm run test:consumer`, `npm run package:vscode` |
| Changelog | `npm run changelog:check`, `npm run changelog:check -- --with-commit "<PR title>"` |
| Agent standards | `node .agents/standards/agent-standards.mjs check`, `node .agents/standards/check-keyboard-characters.mjs` |
