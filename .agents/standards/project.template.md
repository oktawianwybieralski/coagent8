# Project parameters

<!-- Copy to .agents/project.md and fill in. The core rules in
.agents/rules/core/ refer to the sections below by name. A value here may
choose where a core rule leaves a choice or tighten a core rule; it never
relaxes one (README "Precedence"). -->

## Repository

- Integration branch: `develop`
- Release lines and tags: none. <!-- Or the model, for example `X.Y.x`. -->
- Issue tracker: GitHub Issues of this repository.

## Languages

- Conversation with the owner: Polish.
- UI languages: <!-- for example Polish primary, English planned -->

## Primary sources

<!-- Official documentation, source repositories and retrieval channels of
the stack, with the pinned versions (rule 00). -->

## Reviewers

- Required: CoAgent8 `review` with backend `codex` and with backend `agy`, in
  parallel, on every reviewed head.
- P2 deferral: allowed with the owner's dated decision. <!-- Or: forbidden. -->

Models and efforts are not named here (rule 03); they come from the review
tool's configuration, for CoAgent8 `~/.coagent8/config.json`.

## Standing go-aheads

<!-- Each with its date and scope, for example:
- 2026-10-29: when every required review is READY, the agent pushes the topic
  branch and opens the PR without asking again. Merge stays with the owner. -->

## Findings labels

- Kind: `bug`, `dead-code`, `cleanup`, `needs-verification`
- Priority: `priority: high`, `priority: medium`, `priority: low`
- Provenance: <!-- for example `found-in-docs` -->

## Commands

| Check | Command |
| --- | --- |
| Lint | |
| Format | |
| Typecheck | |
| Tests | |
| Build | |
