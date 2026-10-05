# P1: CoAgent Review & Independent Audit (Author–Reviewer Separation) (`03-author-reviewer.md`)

> **Priority Level: P1 (Verification & Engineering Gate)**  
> Strict Author/Reviewer separation via CoAgent Review is mandatory before PR merge.

---

## 1. Roles & Separation of Concerns
CoAgent strictly enforces **CoAgent Review / Independent Audit** (Author–Reviewer separation):
* **Author (Authoring Agent — Antigravity / Primary Assistant):**
  - Primary author responsible for writing TypeScript code, modifying schemas, managing unit tests, and driving git branch lifecycle.
* **Reviewer (Independent Auditor — Codex Sol `gpt-6.1-sol` / Claude Code via CoAgent Review):**
  - Independent code verification in read-only sandbox, security audits, architectural consistency checks, and edge-case probing.

---

## 2. Mandatory Audit Protocol

Review scope and executed checks follow [04-quality-gate.md](04-quality-gate.md).
Ordinary documentation edits do not require launching a backend AI or runtime
tests merely to populate an envelope. Independent review requirements before
merge remain applicable; record unexecuted checks honestly. The repository's
release review format is separate from the planned ordinary consult response.

Before merging significant architectural changes, refactors, or creating Release Candidates:
1. Invoke `review` (or `consult` with `backend: "codex"`) against the uncommitted diff in read-only sandbox mode.
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

   CHECKS: typecheck=<PASS|FAIL>; tests=<PASS|FAIL>
   END_REVIEW
   ```
3. **Severity Thresholds:**
   * **P1 (Critical / Security / Correctness)**: MUST be remediated immediately. Blocks PR merge.
   * **P2 (Robustness / Resource Leaks / Edge Cases)**: MUST be remediated before PR merge.
   * **P3 (Style / Minor Nits)**: Optional recommendations that do not block the gate.

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
