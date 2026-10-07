# Antigravity Observation Report: MCP Comparisons and CoAgent8 Gaps

**Author:** Antigravity (Pair Programming Agent)
**Date:** 2026-10-07 (Europe/Warsaw)
**Context:** Independent verification complementing the prior Codex observation report ([`docs/MCP_COMPARISON_2026-10-07.md`](MCP_COMPARISON_2026-10-07.md)).
**Active Plan:** [ROADMAP.md](ROADMAP.md) governs product direction and implementation priorities.
**Working tree:** `feat/dark-theme-branding` at `271152a`.

The run below is recorded by the report's original author. Its timings, tool
operations and Node.js findings were not independently re-executed during commit
preparation. Source inspection corrected the capability descriptions below.

---

## 1. Antigravity Verification Run (Context7 + CoAgent8 Codex / `gpt-6-luna`)

To evaluate real-world MCP interoperability and verify technical claims across distinct tools, Antigravity executed the following workflow:

### Step 1: Retrieval via Context7
- **Tool:** `context7:resolve-library-id`
  - Input: `libraryName: "Node.js"`, `query: "process.loadEnvFile"`
  - Result: Resolved `/nodejs/node` (High reputation, 22,707 snippets, benchmark score 81.62). Duration: ~2.0s.
- **Tool:** `context7:query-docs`
  - Input: `libraryId: "/nodejs/node"`, `query: "process.loadEnvFile"`
  - Result: Retrieved documentation for `process.loadEnvFile(path)` and `util.parseEnv(content)` introduced in Node.js 20.12.0 LTS. Noted limitation: `NODE_OPTIONS` defined inside `.env` has no effect on the running Node.js process. Duration: ~2.0s.

### Step 2: Second Opinion via CoAgent8 (`codex` / `gpt-6-luna`)
- **Tool:** `coagent8:consult`
  - Input:
    - `backend: "codex"`
    - `model: "gpt-6-luna"`
    - `proposal`: Prompt asking whether `process.loadEnvFile` and `util.parseEnv` were added in Node.js 20.12.0 without external packages, and whether `NODE_OPTIONS` works.
  - Result: Confirmed true. `gpt-6-luna` explained that `loadEnvFile()` defaults to `./.env` without needing `dotenv`, and elaborated on the root cause of the `NODE_OPTIONS` limitation: startup options are fixed by the runtime before JavaScript executes `loadEnvFile()`.
  - Execution metadata:
    - Backend: `codex`
    - Model: `gpt-6-luna`
    - Duration: 21.0s (2 ops)
    - Session handle: `syn_sess_53757f413f2f6ae93244e915` (ready)
    - Workspace fallback: `~\Home\oki.dev\coagent8`

---

## 2. Structural Differences When Using MCP

Comparing Context7 (external documentation server) with CoAgent8 (local CLI orchestrator):

| Dimension | Context7 (Documentation Provider) | CoAgent8 (CLI Bridge Orchestrator) |
| --- | --- | --- |
| **Operational Model** | Documentation lookup via MCP; internal transport/state not established by this report | Stateful subprocess bridge over local CLI runtimes |
| **Tool Flow** | Multi-phase lookup (`resolve-library-id` $\rightarrow$ `query-docs`) | Single-phase execution (`consult`, `review`) with optional session tracking |
| **Response Latency** | ~2.0s per request (~4.0s total) | Reported 21.0s in this run; 23.8s in the prior Gemini run; not a general benchmark |
| **Disk & State Footprint** | No local session exposed in the observed response; internal storage not verified | Disk sessions and turn leases; archival history can be disabled |
| **Payload Structure** | Markdown documentation excerpts with source URLs | Single text response + human-readable execution metadata footer |
| **Structured Output** | None | None (kept in single content block for client channel safety) |
| **Turn Continuation** | Library ID parameter | Stateful `session_handle` passed across subsequent turns |
| **Factual Grounding** | Grounded against indexed documentation sources | Grounded against model internal weights and caller-supplied context |

---

## 3. What CoAgent8 Lacks

Based on direct testing, source inspection, and the active [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md):

### 1. Ephemeral / Session-Free Execution Mode
* **Current state:** Execution acquires a disk session and turn lease. Archival history can be disabled with `coagent8_HISTORY=off`, and archive failures are best-effort; disabling history does not remove the session dependency.
* **Gap:** When calling agents only need a quick, one-off factual verification (like the Node.js check above), allocating disk sessions adds unnecessary I/O overhead and storage buildup. A lightweight `ephemeral: true` or `session_mode: "none"` mode is missing.

### 2. Machine-Readable Structured Metadata Channel
* **Current state:** Critical execution metrics (backend provider, model identifier, elapsed duration, session handle, ops count) are rendered into a markdown footer at the end of the text response.
* **Gap:** Automated callers must parse markdown to extract session handles or duration. Optional machine-readable metadata may help, but must preserve the plain answer channel: the current absence of `structuredContent` is deliberate client compatibility behavior, not itself a defect.

### 3. Integrated Source Retrieval & Grounding (Web / Doc Indexing)
* **Current state:** CoAgent8 operates as a CLI execution bridge and provides no dedicated documentation index or source-verification contract. Actual independent retrieval depends on backend capabilities and their isolation; its absence cannot be inferred from one consultation.
* **Gap:** The caller must explicitly request and verify factual grounding. Inherited external MCP access is a separate security limitation, not a supported shortcut for documentation retrieval.

### 4. Enforcement of Subprocess MCP Tool Isolation (`CUR-002`)
* **Current state:** Claude Code runs with explicit empty MCP configuration (`--tools Read,Glob,Grep`). However, Codex and Gemini/agy CLI subprocesses inherit the parent environment's registered MCP tools.
* **Gap:** Risk of accidental re-entrant calls into CoAgent8 or unintended tool invocations during consultations. Strict MCP isolation across all three backends remains an open roadmap item.

### 5. In-Flight Cancellation of the Initial Turn (`CUR-008`)
* **Current state:** The `cancel` tool strictly requires an existing `session_handle`. On a fresh consultation, the `session_handle` is only revealed in the footer of the completed response.
* **Gap:** If an initial turn hangs or takes too long, callers cannot abort it via the `cancel` tool; they are forced to rely on transport-level host cancellation.

### 6. Progress Visibility and Final Answer Delivery
* **Current state:** The final answer is returned as a single text block, but [the progress reporter](../src/execution/progress.ts) sends `notifications/progress` when the request supplies a progress token. [The server](../src/server.ts) connects that reporter to execution.
* **Gap:** Host rendering of progress was not verified in this run. A client that does not supply a progress token will not receive these notifications; the final answer is not streamed as successive tool results.

### 7. MCP Prompts Surface
* **Current state:** CoAgent8 exposes tools and resources (`coagent8://sessions`), but does not define MCP `prompts`.
* **Gap:** Standardized prompt templates for common agent workflows (e.g., code review audits, security sanity checks) are absent from the MCP schema.

---

## 4. Verification Evidence

- `docs/MCP_COMPARISON_2026-10-07.md` restored to exact original Codex baseline.
- `docs/ANTIGRAVITY_MCP_REPORT_2026-10-07.md` authored as Antigravity's distinct report.
- Ran `git diff --check` with 0 errors.
