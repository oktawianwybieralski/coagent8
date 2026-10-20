---
title: Delivered in 0.7.0
---

# Delivered in 0.7.0

Status: **candidate**. Release PR [#85](https://github.com/oktawianwybieralski/coagent8/pull/85)
is not merged or tagged; release evidence is added after the tag
([rules](../README.md#rules)). The tester notes (`docs/releases/v0.7.0.md`) and
the full list of changes in [CHANGELOG.md](../../../CHANGELOG.md) arrive with the
release PR.

0.7.0 is a stability release (owner decision 2026-10-15): a public CLI,
the findings of the 0.6.1 acceptance, review and diagnostics evidence, token
usage, an isolated native acceptance runner and release automation. Delegation
and coagent profiles follow in 0.8.0.

## Records

| Card | Delivered in 0.7.0 | PRs |
| --- | --- | --- |
| [CLI-FIRST-001](CLI-FIRST-001.md) | `coagent8 mcp`, help, version, `models`, `doctor`, `session`; explicit `mcp` registrations; Windows PATH opt-in | #34, #36-#43 |
| [FEEDBACK-061](FEEDBACK-061.md) | Findings of the 0.6.1 native acceptance | #45, #46, #51, #54-#57, #59-#61, #63, #65, #66 |
| [ENVELOPE-001](ENVELOPE-001.md) | Server-owned review terminator | #72 |
| [ACCEPT-001](ACCEPT-001.md) | Isolated native acceptance runner and scenarios N2-N4 | #67, #71 |
| [AX-001](AX-001.md) | Token usage per turn and its list-price equivalent | #81 |
| [AX-002](AX-002.md) | Recency order under a price limit | #47 |
| [AX-004](AX-004.md) | Configuration provenance and one catalog read per doctor run | #82 |
| [AX-005](AX-005.md) | Readiness decided from evidence | #82 |
| [AUDIT-001](AUDIT-001.md) | Audit findings A08-A21 | #80 |
| [RELEASE-001](RELEASE-001.md) | Verified draft releases, npm publication to `next`, published-package verification | #35, #73-#77, #83, #84 |
| [PROPOSALS-001](PROPOSALS-001.md) | Accepted proposals a, d, g, h, k, l, n | #68-#70 |
| [FEEDBACK-070](FEEDBACK-070.md) | Findings of the 0.7.0 native acceptance: finding headers, cache-write prices, deleted workspaces, binary changes | #86 |

## Merged without a card record

Planning, rules and test-stability changes that belong to no delivered card:

| PR | Change |
| --- | --- |
| [#33](https://github.com/oktawianwybieralski/coagent8/pull/33) | Recorded the 0.6.1 release and planned 0.7.0 |
| [#44](https://github.com/oktawianwybieralski/coagent8/pull/44) | `CHANGELOG.md` is regenerated only in release PRs |
| [#52](https://github.com/oktawianwybieralski/coagent8/pull/52) | Reviewers receive the requirements; PR numbers stay out of titles |
| [#53](https://github.com/oktawianwybieralski/coagent8/pull/53) | The issue tool output is a report to paste |
| [#58](https://github.com/oktawianwybieralski/coagent8/pull/58) | Planned the review retry and Codex read-denial fixes |
| [#64](https://github.com/oktawianwybieralski/coagent8/pull/64) | Split the 0.7.0 stability release from 0.8.0 orchestration |
| [#79](https://github.com/oktawianwybieralski/coagent8/pull/79) | Codex stop-timing tests independent of runner speed |

## Moved to 0.8.0

WSL acceptance (`ACCEPT-001c`, including the POSIX recovery checks of 2.12d)
and Open VSX (`PROPOSALS-001b`), owner decision 2026-10-19. Delegation
(`DELEGATE-001`) is built by the owner on a separate branch.
