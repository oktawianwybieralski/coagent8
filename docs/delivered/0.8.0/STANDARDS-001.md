---
title: STANDARDS-001 in 0.8.0
---

# STANDARDS-001 in 0.8.0: shared agent standards

Card at closure: [ROADMAP STANDARDS-001](../../ROADMAP.md#standards-001-shared-agent-standards).
The adoption PR's squash commit, which fixes the card text at closure, is filled
in by the next PR ([rules](../README.md#rules)).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#96](https://github.com/oktawianwybieralski/coagent8/pull/96) | `55b0785` | 2026-10-31 | fix(output): use keyboard characters in CoAgent8 output |
| Adoption PR | pending | pending | chore(rules): adopt the shared agent standards v0.1.0 |

## Scope at closure

- [x] `STANDARDS-001a` - adopt v0.1.0: core copy, lock and checks in CI,
  `.agents/project.md`, project rules 10-15, `AGENTS.md`, `CLAUDE.md` and
  `GEMINI.md` entry points and the PR template. Check: P, R, the two standards
  checks. Met in the two merges above.

Owner decisions 2026-10-31:

- An agent merges a PR only on the owner's explicit instruction for that PR
  (#94).
- The standing go-ahead of 2026-10-12 (push reviewed topic branches and open
  PRs) is recorded in `.agents/project.md`.
- User-visible separators use `-` instead of the middle dot, which core rule
  00 forbids; that change ships first in its own PR (#96).
- `CHANGELOG.md` is regenerated once to v0.7.0 in the adoption PR, a dated
  exception in rule 12 section 6.

Not part of this record:

- `FORMAT-001` (one formatter, its own PR) and `STANDARDS-001b` (the owner
  creates the missing labels) stay in the ROADMAP.

## Delivered

- The core rules of [agent-standards](https://github.com/oktawianwybieralski/agent-standards)
  v0.1.0 in `.agents/rules/core/`, their scripts in `.agents/standards/` and the
  lock `.agents/standards.lock.json` (commit `e69b2d0`).
- CoAgent8's own rules as project rules 10-15, with parameters in
  `.agents/project.md`; `AGENTS.md` maps the earlier rule numbers.
- CI verifies the core copy against the lock and that tracked files carry
  keyboard characters only; `.agents/keyboard-characters.json` excludes the
  verbatim Claude CLI recordings.
- CoAgent8 output (result footer, usage line, doctor, session list, VS Code UI)
  separates fields with ` - `.

## Evidence

[#96](https://github.com/oktawianwybieralski/coagent8/pull/96), author checks
on Windows 11, Node 24.21.0, at head `f312726`:

- `npm run typecheck`, `npm run lint:docs`, `npm run docs` (no warning) and
  `npm run build`: PASS.
- `npm test`: PASS (936 tests: 932 pass, 0 fail, 3 skipped, 1 todo for the
  expected WINDOWS-001a observation).
- `npm run test:consumer`, `npm run package:vscode` and
  `npm run changelog:check -- --with-commit "<title>"`: PASS.
- CI: the six test jobs (three OSes, Node 24 and 26), Analyze and CodeQL
  passed.

Final independent review of #96, base `origin/develop`, scope
`origin/develop...HEAD`:

| Reviewer | Head | Verdict | Handle |
| --- | --- | --- | --- |
| codex | `f312726` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_edfebb71cb4e412b4cf2e39c` |
| agy | `f312726` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_04b995d977abaeb1769a2b5a` |

The adoption PR's author checks and final reviews are in its PR body; the next
PR moves them here with its squash commit.
