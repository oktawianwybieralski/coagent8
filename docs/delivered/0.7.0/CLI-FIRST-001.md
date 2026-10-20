---
title: CLI-FIRST-001 in 0.7.0
---

# CLI-FIRST-001 in 0.7.0: public CLI and MCP adapter

Card at closure: [ROADMAP CLI-FIRST-001 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#cli-first-001-public-cli-and-mcp-adapter); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#34](https://github.com/oktawianwybieralski/coagent8/pull/34) | `868dc2a` | 2026-10-13 | docs(architecture): specify public CLI syntax and dispatch contract |
| [#36](https://github.com/oktawianwybieralski/coagent8/pull/36) | `e2fe2b2` | 2026-10-13 | docs(architecture): specify registration migration contract |
| [#37](https://github.com/oktawianwybieralski/coagent8/pull/37) | `ce8f7cb` | 2026-10-13 | feat(cli): implement Option D mcp, help and version root dispatch |
| [#38](https://github.com/oktawianwybieralski/coagent8/pull/38) | `893e3ce` | 2026-10-13 | feat(integrations): recognize legacy and mcp registration shapes |
| [#39](https://github.com/oktawianwybieralski/coagent8/pull/39) | `a3768e9` | 2026-10-13 | feat(integrations): write and migrate explicit mcp registrations |
| [#40](https://github.com/oktawianwybieralski/coagent8/pull/40) | `9811319` | 2026-10-13 | feat(vscode): use explicit mcp in profile and server definitions |
| [#41](https://github.com/oktawianwybieralski/coagent8/pull/41) | `1ca16c9` | 2026-10-13 | feat(cli): expose models and doctor CLI diagnostics |
| [#42](https://github.com/oktawianwybieralski/coagent8/pull/42) | `926fd15` | 2026-10-13 | feat(cli): expose session list and history inspection |
| [#43](https://github.com/oktawianwybieralski/coagent8/pull/43) | `2738e8c` | 2026-10-13 | feat(vscode): add opt-in PATH integration and lifecycle cleanup |

## Scope at closure

Each item was met in the merges above.

- [x] 1.1 `CLI-FIRST-001a1` CLI syntax spec: ARCHITECTURE lists commands, global flags (`--help`, `--version`, `--json`), exit codes, bare and `mcp` behavior (option D) and the unknown-argument policy, with examples; reviewed READY.
- [x] 1.2 `CLI-FIRST-001a2` registration migration spec: ARCHITECTURE describes both registration shapes, owned-entry migration on setup, repair and extension update, manual-entry guidance, pinned copies and `npx -y coagent8@x mcp`; reviewed READY.
- [x] 1.4 `CLI-FIRST-001b1`: `coagent8 mcp` always serves MCP; bare with both TTYs prints help; piped bare serves MCP; `--version` works; none loads the setup bundle eagerly; tests for each stream combination.
- [x] 1.5 `CLI-FIRST-001b2`: runtime-path extraction in `setup-storage.ts` and `setup.ts` recognizes legacy and `mcp` entries without widening ownership; tests.
- [x] 1.6 `CLI-FIRST-001b3`: new and repaired owned registrations use `mcp`; migration is rolled back on failure; manual entries untouched; tests.
- [x] 1.7 `CLI-FIRST-001b4`: extension profile entries, `McpStdioServerDefinition` and shipped `mcp.json` pass `mcp`; extension tests.
- [x] 1.8 `CLI-FIRST-001c`: `coagent8 models` matches the spec (`--json`, exit codes) and agrees with MCP `doctor` models; installed-bin fixture.
- [x] 1.9-1.10 `CLI-FIRST-001d1`, `d2`: `session list` and `session history <handle> [--cursor] [--limit]` with workspace isolation, MCP paging and invalid-handle errors; fixtures.
- [x] 1.11 `CLI-FIRST-001e`: `coagent8 doctor` (`--scope models` or `--scope health`, `--json`) creates no sessions, keeps redaction, maps errors to exit codes, cancels on Ctrl+C; fixture.
- [x] 1.12-1.13 `CLI-FIRST-001h1`, `h2`: the extension asks once, adds an owned shim to the user PATH on yes, never on no or dismiss, and removes it on uninstall; tests; native check on Windows by the owner.

Not part of 0.7.0:

- `CLI-FIRST-001f` (one execution path), `g` (MCP through the packaged CLI, conditional), `h` per-OS PATH acceptance beyond Windows, `i` (topology measurement) and `j` (readable terminal output) stay in the ROADMAP.

## Delivered

- `coagent8 mcp` starts the MCP server; `coagent8` in a terminal prints help, and piped stdio without arguments still serves MCP for legacy registrations.
- `coagent8 models`, `coagent8 doctor` and `coagent8 session list|history` share the MCP implementations, with `--json` and documented exit codes.
- Setup, repair and the VS Code extension write registrations with the explicit `mcp` argument and migrate owned legacy entries; manual entries are preserved.
- On Windows the extension offers an opt-in `coagent8` command on the user PATH and removes it on uninstall.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#34](https://github.com/oktawianwybieralski/coagent8/pull/34) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_64f5b7db976a72a6f79260ba` |
| [#36](https://github.com/oktawianwybieralski/coagent8/pull/36) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_e0b195a75bb32188664615b7` |
| [#37](https://github.com/oktawianwybieralski/coagent8/pull/37) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_a9c92cb95d1b3a59a1e0f6cd` |
| [#38](https://github.com/oktawianwybieralski/coagent8/pull/38) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_0f3c8d3626d5c9ce75ceddd2` |
| [#39](https://github.com/oktawianwybieralski/coagent8/pull/39) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_7116a0c3f59c4a129b31c9aa` |
| [#40](https://github.com/oktawianwybieralski/coagent8/pull/40) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_e08c73c68588eaffb36fbd39` |
| [#41](https://github.com/oktawianwybieralski/coagent8/pull/41) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_acf4d806b0cd0d72798ec208` |
| [#42](https://github.com/oktawianwybieralski/coagent8/pull/42) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_1fc626610fd953a2b87305f5` |
| [#43](https://github.com/oktawianwybieralski/coagent8/pull/43) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_c9d4f1d8ac526c951019dbb5` |
