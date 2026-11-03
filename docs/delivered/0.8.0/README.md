---
title: Delivered in 0.8.0
---

# Delivered in 0.8.0

Status: **candidate**. 0.8.0 is not tagged; release evidence is added after
the tag ([rules](../README.md#rules)).

0.8.0 is the orchestration release: delegation of complete tasks to
cooperating agents ([ROADMAP](../../ROADMAP.md)).

## Records

| Card | Delivered in 0.8.0 | PRs |
| --- | --- | --- |
| [STANDARDS-001](STANDARDS-001.md) | Shared agent standards v0.1.0 and keyboard characters in CoAgent8 output | #96, #97 |
| [DELEGATE-001](DELEGATE-001.md) | Write delegation, asynchronous by default, with a wait command and a server-owned loop | #95, #105, #123, #125, #126, #131, #141, #143, #144 |
| [FORMAT-001](FORMAT-001.md) | One formatter (Prettier) checked in CI | #98 |
| [WINDOWS-001](WINDOWS-001.md) | Per-call Windows containment: launcher contract, helper and unsigned package | #102, #103, #133 |
| [REVIEW](REVIEW.md) | Reviews of large changes in parts and checks the server runs before a review | #145, #146 |

## Merged without a card record yet

| PR | Change |
| --- | --- |
| [#99](https://github.com/oktawianwybieralski/coagent8/pull/99) | PEM key redaction stays linear on repeated markers (CodeQL alert 4), `a778caa`, 2026-11-01 |
| [#100](https://github.com/oktawianwybieralski/coagent8/pull/100) | Dependabot: `@azure/msal-node` and `@azure/identity` in the VSIX packaging tool, `aa37095`, 2026-11-01 |
| [#101](https://github.com/oktawianwybieralski/coagent8/pull/101) | CodeQL alerts 1-3 and two deterministic timing tests, `696f6b1`, 2026-11-01 |
| [#104](https://github.com/oktawianwybieralski/coagent8/pull/104) | Backends answer the calling agent in English (`answerLanguage`), `c50def0`, 2026-11-01 |
| [#134](https://github.com/oktawianwybieralski/coagent8/pull/134) | The bug report form requires only its first field, `a175892`, 2026-11-02 |
| [#139](https://github.com/oktawianwybieralski/coagent8/pull/139) | Dependabot: the MCP SDK, tsdown and smol-toml patches, `6298a6e`, 2026-11-03 |

The history HANDOFF held while 0.8.0 was built is in [handoff-notes.md](handoff-notes.md).
