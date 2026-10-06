# Handoff: audit blockers (`AUDIT-001`, execution order 1)

```yaml
standard_version: "1.0.0"
task_id: "AUDIT-001"
role: "Author (Authoring Agent)"
mode: "implementation"
topic_branch: "fix/audit-blockers"   # create from release/v1.0.0
target_branch: "release/v1.0.0"       # PR with Squash and Merge
base_sha: null                       # first commit of release/v1.0.0; runtime logic equals the audited c265cdf (only comments and version metadata differ)
candidate_sha: null                  # no candidate yet
```

This handoff points to the plan; it is not a second plan. The
[roadmap](ROADMAP.md#audit-remediation-index) owns scope, order and acceptance.
The [independent audit](PROJECT_REVIEW_2026-10-05.md#independent-audit-at-c265cdf)
owns the findings, reproductions and proposed fixes.

## Objective

Close execution order 1. Each finding lands in its owning milestone, with a
regression test derived from the audit reproduction:

| Finding | Milestone | Done when |
| --- | --- | --- |
| AUD-P0-1 | `WINDOWS-001` | Layered teardown: protocol interrupt (Claude, Codex), then the owned root handle or POSIX group; no PID, PPID, snapshot or polling anywhere; see the decision record in `WINDOWS-001` |
| AUD-P0-2 | `REDACTION-002` | Ordinary code in answers round-trips unchanged; credential formats are still redacted |
| AUD-P0-3 | `HISTORY-002` | Streamed answers persist within a small constant factor of their size; archive failures are warnings; a full archive never blocks a CLI launch |
| AUD-P1-3 | `HISTORY-002` | Bookkeeping failures never discard a successful answer |
| AUD-P1-1 | `ROUTING-MIGRATE-001` | One cooldown write per rate-limited turn, verified through the controller sequence |
| AUD-P1-2 | `ERRORS-001` | Typed `ToolError`; no prefix parsing; unknown failures map to `PROCESS_ERROR` |
| AUD-P1-10 | `PACKAGE-001` | No build output in Git; packed bundle matches packed source |

Small independent fixes may land as separate PRs into the target branch.

## Constraints

- Follow the [core invariants](../.agents/rules/00-core-invariants.md),
  [security rules](../.agents/rules/01-security-and-sandboxes.md),
  [Git workflow](../.agents/rules/02-git-workflow.md) and
  [cross-platform rules](../.agents/rules/05-cross-platform.md). The
  cross-platform rules now require process-identity validation.
- Do not test process teardown by sweeping a live Windows desktop. Use synthetic
  process snapshots for selection logic and owned fixture trees for kill paths.
- Fix root causes. Do not add name lists, larger limits or retries that hide a
  finding.
- Preserve stored histories, sessions and host registrations. Any storage-format
  change needs an explicit migration.
- Do not mark a roadmap item `[x]` without a reference to evidence that measures
  it. Do not repeat the previous handoff's unsupported claims.

## Verification

Select checks with the [quality gate](../.agents/rules/04-quality-gate.md):
typecheck plus focused behavioral tests for each changed runtime area, plus build
and package checks for `PACKAGE-001`. Re-run the audit reproductions and record
results in the project review before requesting an independent review by the Reviewer.

## Next after this handoff

Execution order 2 in the roadmap: probe caching and argv validation (`EXEC-001`),
caller-proof consent, agy forward compatibility, resource workspace isolation
and `LOCKS-001`.
