---
title: FORMAT-001 in 0.8.0
---

# FORMAT-001 in 0.8.0: one formatter

Card at closure: [ROADMAP FORMAT-001](../../ROADMAP.md#standards-001-shared-agent-standards).
The PR's squash commit, which fixes the card text at closure, is filled in by
the next PR ([rules](../README.md#rules)).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| Formatter PR | pending | pending | chore(format): format the repository with Prettier |

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

The author checks and final independent reviews are in the PR body; the next
PR moves them here with its squash commit.
