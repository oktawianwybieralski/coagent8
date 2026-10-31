# Delivered work

The permanent record of what each version delivered. [ROADMAP.md](../ROADMAP.md)
holds the active plan and [HANDOFF.md](../HANDOFF.md) the current state; both are
overwritten as work moves on. A record here keeps what a card promised for a
version and the evidence that it was delivered. Records are history, not
instructions: the three active documents named in [AGENTS.md](../../AGENTS.md)
still decide what to do next.

## Layout

- `docs/delivered/<version>/README.md` lists the version's records, the merged
  PRs without a card and the release status.
- `docs/delivered/<version>/<CARD>.md` records one card's part of that version,
  for example [`0.7.0/CLI-FIRST-001.md`](0.7.0/CLI-FIRST-001.md).
- The version is the first release that ships the work: the next tag after the
  PR merges into `develop`. A card delivered over several versions gets one
  record per version. A backport to a release line adds a dated note to the
  existing record instead of a second file.

## Rules

- The PR that delivers a card's subtasks adds or extends the version's record
  and its row in the version README. The record holds:
  - **Scope:** the delivered subtasks with their acceptance text as the
    ROADMAP or task queue stated it at closure, each met or deferred by a
    dated owner decision, and what stays open.
  - **Delivered:** the behavior and files a user or contributor can rely on.
  - **Evidence:** author checks, native or owner verification and the
    independent review (verdict, reviewed head, handle) of each PR, without
    personal data. Evidence moves here before HANDOFF overwrites it.
- In the same PR the ROADMAP card links the record, and once the card is
  complete it shrinks to one line with its status and that link. HANDOFF
  links the record instead of repeating the evidence.
- The PR number is known once the PR opens; its squash SHA and merge date only
  after the merge, and the next PR fills them in. Existing text is never
  rewritten: later deliveries of the same card in that version add items and
  evidence below it, and corrections go into a dated note at the end.
- Release evidence (native acceptance of the candidate artifacts, the
  release review and publication) is added by the first PR after the tag, in
  the version README. A version without a tag is a candidate, and its README
  says so.

## Versions

| Version | Status | Records |
| --- | --- | --- |
| 0.7.0 | Candidate (release PR #85) | [0.7.0/README.md](0.7.0/README.md) |
| 0.8.0 | Candidate | [0.8.0/README.md](0.8.0/README.md) |

Versions up to 0.6.1 predate these records; their changes are in
[CHANGELOG.md](../../CHANGELOG.md) and the git history.
