---
name: pr-merge
description: Merge pull requests that the owner lists explicitly into develop of this repository. Use when the owner says "merge #15, #16" or similar. Rebases each PR onto develop, regenerates the changelog, waits for the six CI jobs and squash-merges with a message that follows rule 02. Not for reviewing, fixing or creating pull requests.
---

# Merge pull requests into develop

Merging is an owner action ([rule 02](../../rules/02-git-workflow.md)): run this
only when the owner lists the PR numbers in the request, and merge only those,
one at a time, in the order given (ascending if no order was given). Never touch
any other PR.

## How to run commands

- Run each command as its own terminal call. Do not chain with `&&` or `;`,
  and do not use command substitution.
- Never open an editor: continue a rebase with
  `git -c core.editor=true rebase --continue`.
- Never use `git stash`, `git worktree`, `git merge`, `git reset --hard`,
  `git rebase --skip` or `git rebase --abort` unless this file says so. Merge
  commits break `npm run changelog`; branches are updated by rebase only.
- Never push to `develop`. Push only the PR's topic branch, with
  `--force-with-lease`.
- Never add AI attribution (Co-Authored-By, "Generated with") anywhere.

## Before the first PR

1. `git status --short` must be empty. If it is not, stop and report: the
   files belong to someone else.
2. Note the current branch (`git branch --show-current`) for the report.

## For each PR number N

1. `gh pr view N --json state,title,body,headRefName,baseRefName,mergeStateStatus`
   - `state` must be `OPEN` and `baseRefName` must be `develop`, else stop.
   - Remember `title`, `body` and `headRefName` (the branch).
2. `gh pr checks N`. If any job failed, stop and report it; never rerun jobs.
3. If `mergeStateStatus` is `CLEAN`, go to step 9.
4. Update the branch:
   - `git fetch origin`
   - `git checkout <branch>`
   - `git pull --ff-only`
   - `git rebase origin/develop`
5. Rebase conflicts. `git status --short` lists them; for each conflicted file:
   - `CHANGELOG.md`: run `npm run changelog`, then `git add CHANGELOG.md`.
     Never edit it by hand (rule 02 section 6).
   - `docs/ROADMAP.md`: keep everything from the develop side (the
     `<<<<<<< HEAD` part) and re-apply only this branch's own card edit
     (typically `- [ ]` changed to `- [x]` plus the card's new text). Remove
     all conflict markers, check that none remain, then
     `git add docs/ROADMAP.md`. If both sides changed the same sentence
     differently, stop and report.
   - Any other file: stop and report the file names. Do not resolve code or
     test conflicts.
   - Then `git -c core.editor=true rebase --continue`; repeat until the rebase
     finishes.
6. Changelog and checks:
   - `npm run changelog`; if `git status --short` then lists `CHANGELOG.md`,
     run `git add CHANGELOG.md` and
     `git commit -m "chore(changelog): regenerate"`.
   - `npm run changelog:check -- --with-commit "<title>"` must exit 0.
   - `npm run typecheck` must exit 0.
   - For each test file the PR changes
     (`git diff --name-only origin/develop -- tests`), run
     `node tests/run.cjs <file>`; each must report `fail 0`.
   - On any failure, stop and report the command and its output.
7. `git push --force-with-lease origin <branch>`
8. Wait for CI: run `gh pr checks N` every two minutes until no job is
   pending. All six jobs must pass. On a failure, stop and report the last
   60 lines of `gh run view <run id> --log-failed`; never rerun jobs.
9. `gh pr view N --json mergeStateStatus` must be `CLEAN`; if it is `BEHIND`
   again, go back to step 4.
10. Write the squash message body (rule 02 section 2) to a file outside the
    repository, for example in the system temp directory:
    - the text of the PR body's `## Summary` section (why the change is
      needed and what behavior changes), wrapped at 72 characters;
    - a blank line, then one footer per line from the PR body's `## Links`
      section: `Fixes #123`, `Refs #123`, `Refs: <roadmap card>`, and any
      `BREAKING CHANGE:` footer;
    - nothing else: no Verification table, checklist or file list.
11. `gh pr merge N --squash --subject "<title> (#N)" --body-file <file>`. The
    repository deletes the merged branch itself.
12. `gh pr view N --json state` must be `MERGED`. Delete the message file.

## After the last PR

1. `gh run list --branch develop --limit 3`; wait until the run of the last
   merge finishes and report its conclusion. A red `develop` is reported
   first: its cause is found and fixed in a new PR before anything else.
2. Report a table: PR, title, conflicts and how they were resolved, local
   checks (PASS/FAIL with the command), CI result, merged yes/no. Name every
   step that was skipped and why.
