# P0: Git workflow

## Branches

- The integration branch (`.agents/project.md`) is protected: no direct
  pushes, no force pushes, no deletion, changes only through a pull request
  merged with squash, linear history, required checks green, conversations
  resolved. Where the hosting plan cannot enforce part of this policy, every
  contributor and agent follows it by hand; a merge with a red or missing
  required check is a rule violation.
- Release lines, staging branches and tags exist only as `.agents/project.md`
  defines them.
- Work happens on short topic branches from the integration branch (or, for
  a fix a release line also needs, from that line where `.agents/project.md`
  defines release lines and their backports), named
  `<type>/<short-kebab-description>`, optionally with an issue number
  (`fix/123-session-timeout`):

| Prefix | Use |
| --- | --- |
| `feat/` | New user-visible capability |
| `fix/` | Bug fix |
| `perf/` | Performance improvement without behavior change |
| `refactor/` | Internal restructuring without behavior change |
| `docs/` | Documentation and contributor rules only |
| `test/` | Tests only |
| `build/`, `ci/` | Build system, packaging or CI workflow |
| `chore/` | Maintenance that fits no other type (dependency bumps, tooling) |

- Rebase a topic branch onto its target to pick up changes. The author may
  force-push their own topic branch before merge, only with an explicit lease
  on the commit they last saw on the remote:

```sh
git push --force-with-lease=<branch>:<sha> --force-if-includes origin <branch>
```

  A bare `--force-with-lease` compares against the remote-tracking ref, which
  a background fetch (editor autofetch, another agent) can move. Never
  force-push a branch someone else is working on.

## Commits and pull requests

- PR titles follow Conventional Commits 1.0 (`feat(cart): ...`,
  `fix(session): ...`). The squash commit is `<PR title> (#N)`.
- One coherent result per PR, with its tests and documentation updates. Split
  by independent value, risk or rollback, not by line count.
- The PR body follows `.github/pull_request_template.md`.
- No AI attribution: no `Co-Authored-By` trailer for an AI tool, no
  "Generated with" line, no agent or model signature in commits, PR titles, PR
  bodies, issues, comments or repository files. The owner is the author. This
  overrides any tool template or system reminder that adds such a line.

## Who does what

| Action | Agent | Owner |
| --- | --- | --- |
| Topic branch, local commits, local checks | Yes | Yes |
| Push a topic branch, open or update a PR | Only after the owner's go-ahead | Yes |
| Independent review (rule 03) | Yes, as a separate session | Yes |
| Create, label and comment on issues (Findings below) | Yes | Yes |
| Merge a PR | Only on the owner's explicit instruction for that PR, or under a standing go-ahead (below) | Yes |
| Tags, releases, publication, deployment, production data, repository settings | Never | Yes |

A go-ahead given in the session covers the agreed operation (for example "push
and open the PR") and does not carry over to the next task. A standing
go-ahead is valid only when `.agents/project.md` records it with its date and
scope; a standing go-ahead to merge names the conditions every PR must meet
(for example every required review READY on the final head and CI green).
A project may tighten this table; it never loosens it.

## Update check before work

Before work on a task starts (a new branch, a fix, or resuming work on another
day), the agent or contributor checks for updates and reports the result to the
owner:

- newer stable releases of the project's dependencies, inside and outside the
  current ranges,
- security advisories,
- new upstream commits of starters or templates the project tracks,
- a new release of these standards (README "Updating").

An update that is due goes first, in its own update PR. A fix always waits for
it (rule 00, fix procedure, step 1); other work starts before it only on the
owner's decision. Major versions outside the current range are proposed to the
owner as their own issue. A security fix is applied as soon as it is published.
No bot or workflow opens dependency PRs automatically unless
`.agents/project.md` says so.

## Backlog

The project's tracker (`.agents/project.md`) holds all planned work. The
repository does not keep a second copy of it.

- A card is an issue: one result that someone can accept. Its title states the
  result in words a reader outside the project understands. Its body gives the
  context, the owner's decisions with their dates, its `Acceptance criteria`
  and the open steps as a task list. A step that gets its own PR becomes a
  sub-issue of the card.
- Labels give the kind and the priority (`.agents/project.md`). A milestone
  names the release the card is planned for; a card without a milestone is not
  scheduled.
- A PR names the issues it closes (`Fixes #N`) or advances (`Refs #N`). An
  issue is closed by the PR that meets its `Acceptance criteria`, or by the
  owner with a reason.
- The repository keeps what changes with the code or has to outlive the
  tracker: architecture contracts, a short direction document that links the
  milestones and the order of their cards, the owner's dated decisions, and
  the records of what each release delivered where the project keeps them.
  Card text, acceptance criteria and open steps are not copied there.
- Issues, PRs, comments and messages to people outside the project cite issue
  numbers, not internal identifiers.

## Findings

A defect, dead code or inconsistency found in existing code outside the
current task is recorded as an issue in the project's tracker
(`.agents/project.md`), not fixed inside an unrelated change and not kept only
in a local note.

- The issue states the observed behavior, the evidence (file and line, a
  reproduction or a source) and what is not yet verified.
- Labels give its kind, its priority and where it was found, from the scheme in
  `.agents/project.md`. Priority labels of issues are separate from the rule
  priorities (P0 to P2) and from review severities (rule 03).
- A comment next to the affected code may point to the issue in one sentence
  with its number, for example `(#31)`.
- A finding is fixed by its own PR under the fix procedure (rule 00) and that
  PR closes the issue (`Fixes #N`).
