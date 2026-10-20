---
title: PROPOSALS-001 in 0.7.0
---

# PROPOSALS-001 in 0.7.0: proposals awaiting an owner decision

Card at closure: [ROADMAP PROPOSALS-001 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#proposals-001-proposals-awaiting-an-owner-decision); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#68](https://github.com/oktawianwybieralski/coagent8/pull/68) | `1547bdb` | 2026-10-18 | docs: record owner decisions on proposals k to n |
| [#69](https://github.com/oktawianwybieralski/coagent8/pull/69) | `a52d72f` | 2026-10-18 | fix(mcp): ask for file paths, describe cancel and compact session resources |
| [#70](https://github.com/oktawianwybieralski/coagent8/pull/70) | `141f86d` | 2026-10-18 | build(registry): add server.json and mcpName for the MCP Registry |

## Scope at closure

Each item was met in the merges above.

- [x] 3.0: owner accepts or rejects `PROPOSALS-001k` to `n`; the proposal cards record it (2026-10-18).
- [x] 3.9 `PROPOSALS-001a`: `server.json` and `mcpName` added; publication to the MCP Registry stays an owner action.
- [x] 3.10, 3.10b, 3.11 `PROPOSALS-001d`, `l`, `h`: tool descriptions and skills ask for paths; session resources use compact JSON; the cancel description; tool-definition budget test passes.
- [x] 3.13, 3.13b `PROPOSALS-001g`, `k`, `n`: rule and AGENTS.md texts for the accepted items.

Not part of 0.7.0:

- `PROPOSALS-001b` (Open VSX) moved to `0.8.0`; `001e` (signed-commit ruleset) and `001f` (pre-push hook) stay open; `001m` was deferred as research.

## Delivered

- Callers are asked to name files instead of pasting them; `cancel` describes the protocol interrupt; session resources are compact JSON; `server.json` prepares the MCP Registry listing; force pushes name the expected remote commit.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#68](https://github.com/oktawianwybieralski/coagent8/pull/68) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_87a1bba167797aec0291b2b1` |
| [#69](https://github.com/oktawianwybieralski/coagent8/pull/69) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_9f12c19c4cb487f776df3515` |
| [#70](https://github.com/oktawianwybieralski/coagent8/pull/70) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_bdc795a102f8f35f2447ecbc` |
