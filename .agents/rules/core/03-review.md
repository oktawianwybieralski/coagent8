# P1: Independent review

## Separation

- The author of a change cannot approve it. Review runs as a separate agent
  session in read-only mode, through the review tool `.agents/project.md`
  names (for example CoAgent8 `review`). The role is independent of model and
  provider: the same model may review in a separate session, and a different
  provider alone does not make a review independent.
- `.agents/project.md` names the required reviewers. Every required reviewer
  reviews the exact head; none replaces another, and when one is unavailable
  the author waits for it instead of accepting the others alone.
- Rules and project files name reviewer roles and backends, never models or
  reasoning efforts. The model and effort come from the review tool's own
  configuration (for CoAgent8, `backends.<id>.defaultModel` in
  `~/.coagent8/config.json`), so changing a model never changes a rule.
- Follow-up turns in an earlier review session may check single fixes. Once
  the last accepted fix is reviewed READY, the final head is reviewed once
  more in new sessions that start without earlier review context.
- A finding is a lead, not a proven defect. The author verifies each one
  against the code, the documentation or a reproduction before acting: fix a
  confirmed one, and answer a refuted one with the evidence in the PR instead
  of changing the code to satisfy the reviewer.
- The owner's architecture and code review normally happens before the PR is
  opened; the author prepares the candidate, the relevant diff, the check
  evidence and the open questions for it. Independent review does not replace
  that review or the owner's decisions, and later changes are disclosed with
  their effect on an earlier review.

## Review input

A reviewer checks what it is given. The review instructions carry the
requirements, not an implementation summary or a list of touched files:

- the acceptance text of every ROADMAP card the change closes, and the dated
  ARCHITECTURE decisions it implements, quoted or linked by heading;
- the proposed PR title and description, which the reviewer cannot read from
  Git;
- for an export of material the reviewer cannot reach (issues, external
  pages), a copy in an ignored local folder.

The author asks the reviewer to check, beyond correctness:

1. each acceptance criterion and decision against the code, including the
   wording users and calling agents see;
2. every claim in changed documentation and comments against the code and the
   merged history;
3. code that cannot run or has no effect, such as a check whose condition is
   constant;
4. the PR title and description against rule 02.

A review whose instructions name only areas or files is narrowed; the author
owns what it misses. A large change may be reviewed in parts, each part
against the same head, as long as the parts cover the whole diff.

## Severity

- P1 blocker (correctness, security, data or money integrity): fix before
  merge.
- P2 important (robustness, edge cases, missing tests for changed behavior):
  fix before merge, or record the owner's dated decision to defer it together
  with a tracked issue or ROADMAP card. `.agents/project.md` may forbid
  deferral.
- P3 minor: optional.

A finding about existing code that the change did not touch is recorded as an
issue (rule 02, "Findings") and does not block the PR.

## Evidence in the PR

The author records the checks they ran separately from the reviewers'
findings. In the PR's Verification section, record one line per required
reviewer:

```text
Independent review (<backend>): READY | BLOCKED; head <sha>; base <sha>; scope <base>..<head>; coverage COMPLETE | PARTIAL; unresolved P1/P2: <n>
```

A review covers the head it saw. New commits or a rebase make it stale until
the new head is reviewed; editing only the PR description does not. Until a
review runs, write `NOT_RUN` with the reason. Checks a read-only reviewer could
not run stay NOT_RUN in its record even when the author or CI ran them. Never
write or imply the owner's approval on their behalf.
