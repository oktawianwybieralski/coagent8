# RFC: Interactive CLI Prompt Handling, Adaptive Timeouts & Release Architecture

> Historical snapshot. Original findings, plans, commands and version labels
> are preserved as evidence; they do not define current policy or release status.
> Use the [active roadmap](../ROADMAP.md), [runtime contract](../RUNTIME_CONTRACT.md)
> and [archive index](README.md). Historical source references describe their
> original tree, including modules that no longer exist.


**Date:** 2026-10-04  
**Status:** DEFERRED / HISTORICAL DISCUSSION
**Target Branch:** `release/v1.0.0-rc`  
**Authors:** Oktawian Wybieralski & Antigravity  

---

## Authority and scope

This RFC is not an active implementation plan or permission to auto-confirm CLI
prompts. [ROADMAP.md](../ROADMAP.md) owns prioritization; interactive confirmation and
adaptive timeouts remain deferred. Historical latency statements below were not
remeasured in the product reassessment. The earlier workflow proposals are consolidated in section 4;
current Git policy is [02-git-workflow.md](../../.agents/rules/02-git-workflow.md) and
local verification is [04-quality-gate.md](../../.agents/rules/04-quality-gate.md).
In particular, packaging, dependency, test-harness and integration changes can
require tests even when no TypeScript logic under src/ changed.

## 1. Context & Motivation

During the stabilization of CoAgent8 v1.0.0-rc.1, two major systemic inefficiencies were identified:
1. **Premature Main Pollution & Premature RC Releases:**
   - Multiple intermediate commits (`e70d911`, `#7`, `#9`) were merged to `main` before the release was stabilized, polluting `main` history with noisy hotfixes.
2. **Extreme Request Latency (30-60 minutes per turn):**
   - Headless subprocesses frequently hang on unobserved prompts or get killed prematurely by wall-clock deadlines.
   - Blind adherence to heavy verification rituals (e.g., executing a full 134-test suite during git renames or documentation edits).
   - Arbitrary 120-second timeout deadlines cut reasoning models off mid-thought, causing a second multi-minute retry turn that doubled latency.

---

## 2. Interactive CLI Prompt Handling (`[y/N]`)

### Problem
When a CLI tool (Codex, Claude, git, npm, etc.) prints an interactive confirmation prompt:
```text
Do you want to proceed? [y/N]
Apply suggested changes? (Y/n)
Are you sure? [yes/no]
```
In a headless environment without an interactive TTY, the child process blocks on `stdin.read()`.
Currently, the bridge simply waits in total silence until the global 120-second deadline expires (`CLI deadline exceeded`).

### The Anti-Pattern: Fail-Fast Abort
Simply detecting the prompt and killing the process immediately (`killProcessSafely`) is unacceptable UX. **The user invoked the tool to obtain an answer, not to receive an aborted process.**

### Proposed Architecture: Stdin Stream Interceptor & Auto-Confirm Protocol

```mermaid
flowchart TD
    Child[Subprocess Output Stream] --> Scanner[Prompt Pattern Matcher]
    Scanner -->|Normal Output| Buffer[Collector & Parser]
    Scanner -->|Detected [y/N]| Decision{Policy & Stdin Mode}
    Decision -->|autoConfirm: 'yes'| InjectY[Write 'y\n' to child.stdin]
    Decision -->|autoConfirm: 'no'| InjectN[Write 'n\n' to child.stdin]
    Decision -->|escalate / interactive| Notify[Escalate to User / Tool Caller]
    InjectY --> Child
    InjectN --> Child
```

#### 1. Stream Scanning
The line/chunk decoder checks incoming stdout/stderr for interactive prompt patterns:
```typescript
const INTERACTIVE_PROMPT_REGEX = /(?:\[y\/n\]|\(y\/n\)|continue\?\s*\[|confirm\?\s*\[|are you sure\?|proceed\?\s*\[)/i;
```

#### 2. Configurable Auto-Confirm / Stdin Injection
Instead of closing `stdin` immediately upon launch (`child.stdin.end()`), keep `stdin` open and pipe the intended decision:
* **Default policy:** For read-only consultations, audits, and non-destructive queries, configure default auto-response (`'yes'` or `'no'`).
* **Immediate response:** When `INTERACTIVE_PROMPT_REGEX` matches, write `'y\n'` to `child.stdin` without human delay.
* **Result:** The child process receives its confirmation in <10ms and continues execution, delivering the complete answer to the caller without hanging.

---

## 3. Adaptive & Activity-Based Timeouts (Eliminating Mid-Sentence Cuts)

### Problem
A rigid wall-clock timeout (e.g., `120_000 ms`) treats a deadlocked process identically to a model generating a deep architectural response.
Cutting off a model at 120s when it was about to finish at 130s wastes the first 120s entirely and forces a second multi-minute turn.

### Proposed Architecture

1. **Activity / Idle Timeout (Liveness):**
   - Track `lastActivityTimestamp = Date.now()` on every received stdout/stderr chunk.
   - Trigger a timeout **only if the process is completely silent for > 60 seconds** (indicating a true freeze, dead connection, or infinite loop).
2. **Generous Upper Ceiling:**
   - If the process is continuously streaming tokens or progress updates, allow it to run up to a realistic ceiling (e.g., 5-8 minutes) before intervening.
   - Never truncate deep-reasoning models mid-sentence.

---

## 4. Superseded workflow proposals

The earlier branching and local-gate prescriptions have been consolidated into
[Git governance](../../.agents/rules/02-git-workflow.md) and the
[quality gate](../../.agents/rules/04-quality-gate.md). This RFC does not maintain a
second checklist. Prose-only changes need document checks; runtime, dependency,
packaging, integration and harness changes need verification matching their risk.
Full exact-artifact validation remains required for a release.
