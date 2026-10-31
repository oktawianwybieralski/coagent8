<!-- Follow .agents/rules/core/02-git-workflow.md and section 3 of
.agents/rules/12-release-workflow.md. Title: Conventional Commit.
Replace the comments, mark sections that do not apply N/A. -->

## Summary

<!-- The problem and the resulting behavior. -->

## Links

<!-- Fixes #N / Refs #N, ROADMAP card, ARCHITECTURE decision. None if nothing applies. -->

## Changes

<!-- Behavior, contracts, configuration and stored data, removed code or
dependencies, and the `pending` changelog entry from the title preview. -->

## Verification

<!-- Checked SHA, platform and Node version, commands run with
PASS/FAIL/NOT_RUN and the reason. -->

Independent review: NOT_RUN; pending review of the current head.

<!-- One line per required reviewer (.agents/project.md), core rule 03:
Independent review (<backend>): READY | BLOCKED; head <sha>; base <sha>; scope <base>..<head>; coverage COMPLETE | PARTIAL; unresolved P1/P2: <n>
A consult is advisory and does not satisfy independent review. -->

## Risk and rollback

<!-- What can break, data impact, how to revert. -->

## Checklist

- [ ] Core rule 01 checked: no secrets, personal data, local paths or hard-coded hosts.
- [ ] Docs, contracts and ROADMAP/HANDOFF updated where needed.
- [ ] No dead code or unused dependencies left behind.
- [ ] CHANGELOG.md unchanged (it is regenerated only in release PRs).
- [ ] Conventional Commit title preview passed.
- [ ] No AI attribution in commits or this description.
