---
name: pr-merge
description: Merge pull requests that the owner lists explicitly into develop of this repository. Use when the owner says "merge #15, #16" or similar. Rebases each PR onto develop, regenerates the changelog, waits for the six CI jobs and squash-merges with a message that follows rule 02. Not for reviewing, fixing or creating pull requests, and not for release PRs.
---

# Merge pull requests into develop

Merging is an owner action ([rule 02](../../rules/02-git-workflow.md)): run this
only when the owner lists the PR numbers in the request, and merge only those,
one at a time, in the order given (ascending if no order was given). Never touch
any other PR. The owner's list also authorizes rebasing and force-pushing the
listed PRs' branches; it covers nothing else.

## How to run commands

- Run each command as its own terminal call. Do not chain with `&&` or `;`,
  and do not use command substitution.
- **Any command that fails or prints something this file does not expect:
  stop and report the command and its output.** Do not improvise a fix. Two
  non-zero exits are expected: `git rebase` and `rebase --continue` stopping
  on a conflict (handled in step 5), and `gh pr checks` exiting with 8 while
  checks are pending (step 8).
- Never open an editor: continue a rebase with
  `git -c core.editor=true rebase --continue`.
- Never use `git stash`, `git worktree`, `git merge`, `git reset`,
  `git rebase --skip` or `git rebase --abort`. Merge commits break
  `npm run changelog`; branches are updated by rebase only.
- Never push to `develop`. Push only a listed PR's branch, with a lease bound to
  the commit you observed (step 7).
- Never add AI attribution (Co-Authored-By, "Generated with") anywhere.

## Before the first PR

1. `git status --short` must be empty. If it is not, stop and report: the
   files belong to someone else.
2. Note the current branch (`git branch --show-current`) for the report.
3. `git fetch origin`, then `git rev-parse origin/develop` gives the current
   `develop` commit; `gh run list --workflow CI --commit <that SHA>` must list
   a finished run with conclusion `success`. If it is red or missing, stop:
   rule 02 allows no further merge until a fix restores green CI.

## For each PR number N

1. Read the PR:
   `gh pr view N --json state,title,body,headRefName,headRefOid,baseRefName,isCrossRepository,mergeStateStatus`
   - Stop unless `state` is `OPEN`, `baseRefName` is `develop` and
     `isCrossRepository` is `false` (the branch lives in this repository).
   - Stop if `headRefName` starts with `release/`: a release PR is merged by
     the owner per rule 02 section 5, and its changelog needs `--tag`.
   - Stop unless the body's Verification section records an independent
     review with verdict `READY` in the format of
     [rule 03](../../rules/03-author-reviewer.md#recording-pr-evidence). If its
     reviewed head differs from `headRefOid`, step 9 reviews the head again.
   - Stop if the PR has an open review finding or unresolved conversation:
     rebasing is allowed only after the review is complete (rule 02
     section 3, "Review and merge").
   - Remember `title`, `body`, `headRefName` (the branch) and `headRefOid`
     (the observed head).
2. `gh pr checks N`: stop if any job failed; never rerun jobs.
3. If `mergeStateStatus` is `CLEAN`, go to step 8.
4. Update the branch (each must succeed):
   - `git fetch origin`
   - `git checkout <branch>`
   - `git pull --ff-only`
   - `git rev-parse HEAD` must equal `headRefOid`; otherwise stop (someone
     else changed the branch, or the local copy has unpushed commits).
   - `git rebase origin/develop`
5. Rebase conflicts. `git status --short` lists them; for each conflicted file:
   - `CHANGELOG.md`: run `npm run changelog`, then `git add CHANGELOG.md`.
     Never edit it by hand (rule 02 section 6).
   - `docs/ROADMAP.md`: run `git show REBASE_HEAD -- docs/ROADMAP.md` to see
     the exact edit of the commit being replayed. Keep the `<<<<<<< HEAD` side
     whole and apply to it exactly that edit (typically one card changed from
     `- [ ]` to `- [x]` with new text). Remove all conflict markers and check
     that none remain, then `git add docs/ROADMAP.md`. Stop if the edit does
     not apply cleanly to the HEAD side (both sides changed the same card), or
     if you are unsure.
   - Any other file: stop and report the file names. Do not resolve code or
     test conflicts: they need a new review.
   - Then `git -c core.editor=true rebase --continue`; repeat until the rebase
     finishes.
6. Changelog and checks (each must exit 0):
   - `npm run changelog`; if `git status --short` then lists `CHANGELOG.md`,
     run `git add CHANGELOG.md` and
     `git commit -m "chore(changelog): regenerate"`.
   - `npm run changelog:check -- --with-commit "<title>"`
   - `npm run typecheck`
   - For each test file the PR changes
     (`git diff --name-only origin/develop -- tests`),
     `node tests/run.cjs <file>`, which must report `fail 0`.
7. `git rev-parse HEAD` gives the new local head. Push with
   `git push --force-with-lease=<branch>:<headRefOid> origin <branch>`, then
   `gh pr view N --json headRefOid` must equal the new local head (otherwise
   stop: someone else pushed). From now on `headRefOid` is that SHA.
8. CI on the current head: `gh pr view N --json headRefOid` must still equal
   `headRefOid`; run `gh pr checks N` every two minutes until no job is
   pending. Exactly six jobs must be listed and all must be `pass`, also
   when step 3 skipped the update. On a failure, stop and report the last 60
   lines of `gh run view <run id> --log-failed`; never rerun jobs.
9. Independent review of the current head (rule 03). A rebase or new commit
   supersedes earlier review evidence. Reuse the review recorded in the PR body
   only if it names head `headRefOid`, scope `<base>...<head>` with base equal
   to `git merge-base origin/develop <headRefOid>` (the whole PR, not one
   commit), coverage `COMPLETE` and 0 unresolved P1/P2. Otherwise:
   - `git fetch origin`, `git checkout <branch>`, `git pull --ff-only`;
     `git rev-parse HEAD` must equal `headRefOid`;
   - run the CoAgent8 `review` tool with scope `origin/develop...<branch>`
     (backend and model as the owner named, else the defaults);
   - require `VERDICT: READY` and `COVERAGE: COMPLETE`; on `BLOCKED`, stop and
     report the findings (do not fix them: that is the Author's work);
   - afterwards `git rev-parse HEAD` and `gh pr view N --json headRefOid`
     must both still equal `headRefOid`, else the review covered another
     snapshot: stop;
   - update the PR body's Verification section with `gh pr edit N --body-file
     <file>`: mark the old review line superseded and add the new one in the
     rule 03 format (verdict, head, base, scope, coverage, unresolved P1/P2,
     session handle as evidence). Change nothing else in the body.
10. `gh pr view N --json mergeStateStatus` must be `CLEAN`; if it is
    `BEHIND` again, go back to step 4. `CLEAN` also means that the ruleset's
    conditions (resolved conversations, required checks) hold.
11. Write the squash message body (rule 02 section 2) to a file outside the
    repository, for example in the system temp directory:
    - the text of the PR body's `## Summary` section (why the change is
      needed and what behavior changes), wrapped at 72 characters;
    - a blank line, then one footer per line, collected from the whole PR
      body: `Fixes #123`, `Refs #123`, `Refs: <roadmap card>` and every
      `BREAKING CHANGE:` footer;
    - nothing else: no Verification table, checklist, file list or AI
      attribution. Stop if the Summary is missing or a footer is ambiguous.
12. `gh pr merge N --squash --match-head-commit <headRefOid> --subject "<title> (#N)" --body-file <file>`.
    The repository deletes the merged branch itself.
13. `gh pr view N --json state,mergeCommit`: `state` must be `MERGED`;
    remember `mergeCommit.oid`. Delete the message file.
14. Wait for the CI run of that merge commit: run
    `gh run list --workflow CI --commit <mergeCommit.oid>` every two minutes
    until it lists a finished run, and require conclusion `success` before the
    next PR. If it is red, stop the batch and report: the
    cause is found and fixed in a new PR before anything else is merged.

## Report

A table: PR, title, conflicts and how they were resolved, local checks
(PASS/FAIL with the command), CI result, merged yes/no, `develop` CI after the
merge. Name every step that was skipped and why, and the branch noted at the
start.
