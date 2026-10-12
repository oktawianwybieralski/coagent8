# P1: CoAgent8 Review & Independent Audit (Author-Reviewer Separation) (`03-author-reviewer.md`)

> **Priority Level: P1 (Verification & Engineering Gate)**  
> Strict Author/Reviewer separation via CoAgent8 Review is mandatory before PR merge.

---

## 1. Roles & Separation of Concerns
CoAgent8 strictly enforces **CoAgent8 Review / Independent Audit** (Author-Reviewer separation):
* **Author (assigned implementation agent):**
  - Primary author responsible for writing TypeScript code, modifying schemas, managing unit tests, and driving git branch lifecycle.
* **Reviewer (independent agent via CoAgent8 Review):**
  - Independent code verification in read-only sandbox, security audits, architectural consistency checks, and edge-case probing.

Roles are independent of model size and provider (owner decision, 2026-10-08).
The same provider/model may be used in separate author and reviewer executions;
the implementation author cannot approve their own changes. A planner may review
a worker's implementation, but must evaluate the original requirements as well
as their plan. The [full coagent plan](../../docs/ROADMAP.md#full-coagent-direction)
defines configurable product roles without relaxing independent review gates.

---

## 2. Mandatory Audit Protocol

Review scope and executed checks follow [04-quality-gate.md](04-quality-gate.md).
Ordinary documentation edits do not require launching a backend AI or runtime
tests merely to populate an envelope. Independent review requirements before
merge remain applicable; record unexecuted checks honestly. The repository's
release review format is separate from the implemented plain consult response.

Before merging significant architectural changes, refactors, or creating Release Candidates:
1. Invoke `review` against the complete relevant diff in read-only sandbox mode.
   A plain `consult` is advisory and does not request or enforce an envelope.
   An explicitly assigned advisory consultation cannot substitute for bound
   independent release approval.
2. The auditor produces a structured **State Envelope**:
   ```text
   REVIEW: <turn>
   SNAPSHOT: <sha>
   COVERAGE: COMPLETE | PARTIAL
   VERDICT: READY | BLOCKED

   [P1/P2/P3] <file>:<line>
   Problem: <concise statement>
   Evidence: <reproducible detail>
   Fix: <actionable remedy>

   CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>
   END_REVIEW
   ```
3. Verify expected scope/snapshot and actual check evidence outside the text gate.
   The runtime gate blocks incomplete input, a wrong snapshot, changed workspace
   and failed CHECKS (`CUR-001`, fixed locally). It validates reported outcomes
   but does not prove a model's PASS claim or bind a release artifact. Required checks that failed block readiness;
   inapplicable checks stay NOT_RUN with an explanation. A read-only reviewer
   cannot run checks: its NOT_RUN does not block, the server verdict names them
   (`READY (typecheck and tests not run)`), and the author runs them locally and
   CI on the pull request (owner decision 2026-10-11).
4. **Severity Thresholds:**
   * **P1 (Critical / Security / Correctness)**: MUST be remediated immediately. Blocks PR merge.
   * **P2 (Robustness / Resource Leaks / Edge Cases)**: MUST be remediated before PR merge.
   * **P3 (Style / Minor Nits)**: Optional recommendations that do not block the gate.

---

## Recording PR evidence

The Author records checks they actually executed separately from the independent
reviewer's findings. In the PR's Verification section, record the review verdict,
reviewed commit SHA, target/base and scope, coverage and unresolved P1/P2 findings;
link the review record when available. For example:

```text
Independent review: READY; head <sha>; base <sha>; scope <base>...<head>;
coverage COMPLETE; unresolved P1/P2: 0; evidence <link or record>.
```

Until review is performed, record `NOT_RUN` and the reason. A plain `consult`
is advice, not independent approval. Report the review's actual limitations:
reviewer NOT_RUN checks do not become PASS because author checks or CI passed.
The reviewed head must match the current PR head before merge (rule 02); after
new commits or a rebase, mark old review evidence as superseded until the
independent reviewer has verified the new snapshot. Editing the PR description
alone does not change the code snapshot. Release reviews additionally require
the hashes in section 3. Never write or imply the owner's approval on their behalf.

---

## 3. Release Candidate Audit Binding
For releases and release candidates, the Reviewer's review must evaluate the complete committed release diff against its accepted base commit (`<base_sha>..<candidate_sha>`).
* Approval must explicitly record and bind to:
  - Base commit SHA
  - Candidate commit SHA
  - Exact Tree SHA
  - Package artifact tarball SHA-256
* Uncommitted-diff reviews are advisory until bound to that committed snapshot.
* Any code change to the candidate invalidates prior approval and requires a fresh audit turn.
