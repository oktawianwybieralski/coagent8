---
title: FEEDBACK-061 in 0.7.0
---

# FEEDBACK-061 in 0.7.0: findings of the 0.6.1 native acceptance

Card at closure: [ROADMAP FEEDBACK-061 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#feedback-061-findings-of-the-061-native-acceptance); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#45](https://github.com/oktawianwybieralski/coagent8/pull/45) | `23d48a1` | 2026-10-13 | fix(diagnostics): report running version and clarify update guidance |
| [#46](https://github.com/oktawianwybieralski/coagent8/pull/46) | `953412f` | 2026-10-14 | fix(setup): unify shared registration policy and prevent runtime downgrade |
| [#51](https://github.com/oktawianwybieralski/coagent8/pull/51) | `5f4bc05` | 2026-10-14 | fix(issue): link the bug report form and paste the sanitized report |
| [#54](https://github.com/oktawianwybieralski/coagent8/pull/54) | `6ad6038` | 2026-10-14 | fix(vscode): report extension selection outside profile as unavailable |
| [#55](https://github.com/oktawianwybieralski/coagent8/pull/55) | `906f5c8` | 2026-10-14 | feat(issue): add open actions for bug report form in extension and CLI |
| [#56](https://github.com/oktawianwybieralski/coagent8/pull/56) | `189a40e` | 2026-10-14 | fix(review): carry server turn number in review envelope (#56) |
| [#57](https://github.com/oktawianwybieralski/coagent8/pull/57) | `62eb7b2` | 2026-10-14 | fix(codex): support large prompt lines up to 16 MiB in app-server reviews (#57) |
| [#59](https://github.com/oktawianwybieralski/coagent8/pull/59) | `303fe94` | 2026-10-15 | fix(review): retry reviews that ended with partial coverage |
| [#60](https://github.com/oktawianwybieralski/coagent8/pull/60) | `3821852` | 2026-10-15 | fix(codex): report read denials and restore Windows workspace reads |
| [#61](https://github.com/oktawianwybieralski/coagent8/pull/61) | `7937a30` | 2026-10-15 | docs(handoff): record Windows native recovery check evidence for 2.12d |
| [#63](https://github.com/oktawianwybieralski/coagent8/pull/63) | `b12265a` | 2026-10-15 | docs(roadmap): close Codex read denials as a known limitation |
| [#65](https://github.com/oktawianwybieralski/coagent8/pull/65) | `2d3e283` | 2026-10-15 | fix(agy): preserve requested session id on resume without conversation id |
| [#66](https://github.com/oktawianwybieralski/coagent8/pull/66) | `6f2bb1b` | 2026-10-15 | docs: record native client acceptance procedure |

## Scope at closure

Each item was met in the merges above.

- [x] 2.1-2.2 `FEEDBACK-061a1`, `a2`: `doctor` health shows the running server version and runtime path; the extension's update notice says open chats keep the old runtime until restarted; tests.
- [x] 2.3-2.4 `FEEDBACK-061b1`, `b2`: a fixture reproduces two profiles writing different `coagent8_DIR` values; the chosen policy is implemented with no downgrade offer when a registration points to a newer runtime; tests.
- [x] 2.5 `FEEDBACK-061b3`: a `vscode-extension` selection in a profile without the vendor extension is reported as unavailable here, not "Selected CLI not found"; tests.
- [x] 2.6-2.8 `FEEDBACK-061c1`, `d`, `f`: `issueUrl` points to `?template=bug_report.yml`; the prompt has the clickable link and a copy block; `structuredContent` adds `prompt` and `pasteRequired`; one doctor reminder line; tests.
- [x] 2.9-2.10 `FEEDBACK-061c2`, `c3`: an explicit VS Code action and `coagent8 issue --open` open the form; never automatic; tests.
- [x] 2.11 `FEEDBACK-061e`: the returned envelope carries the server's turn number; the model's value is ignored; tests.
- [x] 2.12 `FEEDBACK-061g`: prompt size and `maxLineBytes` agree for Codex; test with a prompt above 512 KB.
- [x] 2.12a `FEEDBACK-061j`: only complete-coverage reviews with complete input deduplicate; PARTIAL and failed reviews rerun with or without a handle; tests.
- [x] 2.12b-2.12c `FEEDBACK-061k1`, `k2`: Codex read denials reproduced and attributed; observed denied paths reach the review result; the remaining Codex sandbox cause became known limitation `CUR-014` (owner decision 2026-10-15); tests.
- [x] 2.12d native recovery check: Windows passed; the POSIX run moved to row 2.18 in `0.8.0` (owner decisions 2026-10-15 and 2026-10-19).
- [x] 2.13 `FEEDBACK-061i`: agy `final` mapping documented; a resumed turn without a conversation id keeps the requested id.
- [x] 2.14 `FEEDBACK-061h`: "Native VS Code acceptance" lists new chats, the runtime version check, sequential clients and a tree check after closing a client.

Not part of 0.7.0:

- The POSIX half of 2.12d runs in the WSL lane, `ACCEPT-001c`, in `0.8.0`.

## Delivered

- Doctor reports the running runtime version and path; the extension says when open chats still run an older runtime.
- Registrations shared by several VS Code profiles follow one policy and are never downgraded.
- The issue tool links the bug report form and returns a sanitized report to paste; VS Code and the CLI open the form only on request.
- Reviews: the server owns the turn number, partial reviews can be retried, Codex accepts prompts up to 16 MiB per line and read denials are reported and block READY.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#45](https://github.com/oktawianwybieralski/coagent8/pull/45) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_989e121394d22a8f29925181` |
| [#46](https://github.com/oktawianwybieralski/coagent8/pull/46) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_b187424ebe7bb00faaecd100` |
| [#51](https://github.com/oktawianwybieralski/coagent8/pull/51) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_8dc9bc345cd3bade7cf2b5fb` |
| [#54](https://github.com/oktawianwybieralski/coagent8/pull/54) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_d57e528035e930cbf5c324fa` |
| [#55](https://github.com/oktawianwybieralski/coagent8/pull/55) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_6770f2b59f970562283ecf50` |
| [#56](https://github.com/oktawianwybieralski/coagent8/pull/56) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_16de8afa606263549fdaf490` |
| [#57](https://github.com/oktawianwybieralski/coagent8/pull/57) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_cd2276691b703e072547c412` |
| [#59](https://github.com/oktawianwybieralski/coagent8/pull/59) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_188c69880941cdb33382576b` |
| [#60](https://github.com/oktawianwybieralski/coagent8/pull/60) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_bfcecc23ebdf656a393a9ec9` |
| [#61](https://github.com/oktawianwybieralski/coagent8/pull/61) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_01cb3233f8dea7aebac62c6f` |
| [#63](https://github.com/oktawianwybieralski/coagent8/pull/63) | READY, coverage COMPLETE, no unresolved P1/P2; handle not recorded in the PR body (round 2 READY) |
| [#65](https://github.com/oktawianwybieralski/coagent8/pull/65) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_bf0658c7ac0ccd2ee72ab37e` |
| [#66](https://github.com/oktawianwybieralski/coagent8/pull/66) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_3dac48e495ebc58a0b221910` |
