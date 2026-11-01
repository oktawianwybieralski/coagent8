---
title: FORMAT-001 in 0.8.0
---

# FORMAT-001 in 0.8.0: one formatter

Card at closure: [ROADMAP FORMAT-001 at `e91b598`](https://github.com/oktawianwybieralski/coagent8/blob/e91b598f36f90ce272f75e984fb41782f9731657/docs/ROADMAP.md#standards-001-shared-agent-standards).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#98](https://github.com/oktawianwybieralski/coagent8/pull/98) | `e91b598` | 2026-11-01 | chore(format): format the repository with Prettier |

## Scope at closure

- [x] `FORMAT-001` - one formatter configuration checked in CI, added with a
  one-time mechanical reformat in its own PR. Check: R, CI.

Owner decisions 2026-10-31:

- Prettier with a line width of 140, chosen after measuring the reformat:
  239 files and about 18k changed lines at 140, against 250 files and 34k at
  100. Biome gave the same size but formats neither Markdown nor YAML.
- Markdown keeps its hand-written layout: Prettier aligns tables, so every
  later edit that widens a column would rewrite each row.

Not part of this record:

- `.git-blame-ignore-revs` needs the reformat's squash commit, which the next
  PR adds.

## Delivered

- `.prettierrc.json` (width 140, single quotes, arrow parentheses only when
  needed, LF) and `.prettierignore`, which states a reason for each exclusion:
  - Markdown;
  - generated files;
  - the verbatim agent-standards copy;
  - the recorded Claude CLI output;
  - local editor folders.
- `npm run format` and `npm run format:check`; CI runs the check on every
  job before Typecheck.
- **Every TypeScript, JavaScript, JSON and YAML file is formatted.**
  - Two non-mechanical changes keep it so: `scripts/branding.cjs` generates
    `src/generated/server-icon.ts` in the formatted layout, and the VS Code
    command test reads registrations independent of line breaks.
  - Rule 14 and `.agents/project.md` name the check.

## Evidence

[#98](https://github.com/oktawianwybieralski/coagent8/pull/98), author checks
on Windows 11, Node 24.21.0, base `a778caa`, head `5a93087`:

- The mechanical commit equals Prettier with the committed configuration run on
  the `develop` tree; `dist/index.cjs` and `dist/setup.cjs` built from
  `develop` and from the head are byte-identical.
- The agent standards check, the keyboard-characters check, `git diff --check`,
  `npm run typecheck`, `check:dependencies`, `lint:docs`, `docs` (no
  warning), `build`, `format:check` (also after `build`), `test` (937
  tests: 933 pass, 0 fail, 3 skipped, 1 todo), `test:consumer`,
  `npm pack --dry-run`, `node scripts/publish-npm.cjs --dry-run`,
  `package:vscode`, the link check and the changelog check: PASS.
- CI: all jobs passed after one rerun of windows-latest Node 24, whose
  AUDIT-001-A12 wall-clock bound (3 s) was exceeded under coverage (4.1 s);
  the next PR makes that test count attempts instead.
- Review rounds: the first reviews at the earlier heads found one P3 (the PR
  number missing from this record), fixed. Codex cannot read the whole diff
  (input limit 1,048,576 characters), so it reviewed everything after the
  mechanical commit; agy reviewed the whole branch.

Final independent review of #98:

| Reviewer | Head | Scope | Verdict | Handle |
| --- | --- | --- | --- | --- |
| codex | `5a93087` | `9ae0277...HEAD` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_2dd7bd3a1a9976762c04f722` |
| agy | `5a93087` | `origin/develop...HEAD` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_d54af60950115daec99c5298` |

Note 2026-11-01: `.git-blame-ignore-revs` lists the squash commit `e91b598`.
