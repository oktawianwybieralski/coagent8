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
  without asking again. Merging, tags, releases, publication, force pushes and
  repository settings stay with the owner.

## Findings labels

- Kind: `bug`, `enhancement`, `documentation`, `question`, `dead-code`,
  `cleanup`, `needs-verification`
- Priority: `priority: high`, `priority: medium`, `priority: low`
- Provenance: `found-in:vX.Y.Z` (the version where it was observed)

Labels not yet created in the repository are created by the owner.

## Commands

| Check | Command |
| --- | --- |
| Lint | `npm run lint:docs` (TSDoc) |
| Format | `npm run format:check`, `npm run format` (Prettier; Markdown keeps its own layout, `.prettierignore`) |
| Typecheck | `npm run typecheck` |
| Dependency boundaries | `npm run check:dependencies` |
| Tests | `npm test` (all), `node tests/run.cjs <file>...` (focused) |
| Build | `npm run build` |
| API documentation | `npm run docs` |
| Package | `npm pack --dry-run`, `npm run test:consumer`, `npm run package:vscode` |
| Changelog | `npm run changelog:check`, `npm run changelog:check -- --with-commit "<PR title>"` |
| Agent standards | `node .agents/standards/agent-standards.mjs check`, `node .agents/standards/check-keyboard-characters.mjs` |
