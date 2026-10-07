# OmniAgent MCP - Architecture & Release Roadmap (v1.0.0 & v1.1.0)

> Historical snapshot. Original findings, plans, commands and version labels
> are preserved as evidence; they do not define current policy or release status.
> Use the [active roadmap](../ROADMAP.md), [runtime contract](../RUNTIME_CONTRACT.md)
> and [archive index](README.md). Historical source references describe their
> original tree, including modules that no longer exist.


> **Historical roadmap:** Current RC scope, agent ownership, chat/history requirements and release gates are maintained in [PLAN_RC1.md](PLAN_RC1.md). Earlier completion claims below require verification against [AUDIT_CODEX.md](AUDIT_CODEX.md).

> **Update 2026-10-03:** The package is now `coagent8@0.9.0-dev`. Codex execution has been migrated to the shared runner after a reproducible integration regression. Current local verification is 58/58 tests; real CLI safety, independent review and six CI jobs remain open. Consult [RC1_STATUS.md](RC1_STATUS.md) for evidence. The older Claude recommendation below is superseded by the current `--bare` profile; historical checkboxes and release claims are not current acceptance.

> **Architectural Specification & Release Roadmap (Audited & Approved by Codex Sol)**  
> **Status:** Steps 1-9 Complete | Step 10 (v1.0.0 Tagging & Publishing) & v1.1.0 Enhancements In Progress  
> **Author:** Oktawian Wybieralski  
> **NPM Package:** `omniagent-mcp` | **MCP ID:** `omniagent`

---

## 1. Architectural Hardening & Security (Codex Sol Author-Reviewer)

During the architectural audit with **Codex Sol** (`gpt-6.1-sol`), the following security and compliance requirements were identified and enforced:

1. **Claude Code: `--permission-mode dontAsk` is NOT a read-only sandbox.**
   - In Claude Code, `dontAsk` merely suppresses user confirmation prompts; it does not restrict pre-authorized write tools.
   - **Enforced Solution:** Strict read-only tool whitelisting (`--tools "Read,Glob,Grep"`) to prohibit file modifications.
2. **Claude Code: `--bare` vs Subscription OAuth Profiles.**
   - Running `--bare` bypasses local user subscription tokens (`claude auth login`) and demands `ANTHROPIC_API_KEY`.
   - **Enforced Solution:** Use standard subscription profiles with strict tool sandboxing without forcing `--bare`.
3. **Code Privacy & No Silent Cross-Provider Fallback:**
   - Private repository code must never be transmitted across providers without explicit user consent.
   - If a backend encounters an error, outage, or rate limit, report the error directly rather than silently transferring code to another provider.
4. **Persistent Onboarding & Default Backend:**
   - When multiple agent CLIs are present, the default backend is chosen by the user and persisted in `~/.omniagent/config.json`.
   - If a configured default is uninstalled or unavailable, OmniAgent fails fast with actionable instructions rather than silently falling back and switching providers.
5. **Accurate Quota Telemetry (No Fabricated Metrics):**
   - Quotas remain honest and unmeasured (`usedPercent: null`, `resetsAt: null`) unless real telemetry or exhaustion is observed.
   - Active rate-limiting cooldowns (e.g. HTTP 429) are tracked locally in `quota-cache.json` and automatically cleared once expired.

---

## 2. Persistent Onboarding & Configuration (`~/.omniagent/config.json`)

Following established VS Code and MCP ecosystem conventions (Cline, Roo Code, Continue), user preferences are persisted in a validated JSON configuration file:

### Configuration Schema (`~/.omniagent/config.json`):
```json
{
  "schemaVersion": 1,
  "defaultBackend": "codex",
  "routing": {
    "strategy": "fixed",
    "allowedBackends": ["codex", "claude"]
  }
}
```

### First-Run Experience (Onboarding Flow):
1. **Explicit Request:** If a tool call specifies `backend: "claude"` or `backend: "codex"`, it is executed directly after checking `allowedBackends`.
2. **Single Installed CLI:** If only one CLI is installed (e.g. only Claude Code), OmniAgent automatically records it as `defaultBackend` on first run.
3. **Multiple Installed CLIs (No Default Set):**
   - The server throws a structured `[ONBOARDING_REQUIRED]` error listing all detected CLIs.
   - The user or IDE agent sets the default via the **`omniagent_set_default({ backend })`** MCP tool.
   - The selection is persisted to `~/.omniagent/config.json`.

---

## 3. Quota-Aware Routing (`smart_quota`)

Both **OpenAI Codex** and **Claude Code** operate on rolling 5-hour limit windows.

### Zero-Token Limit Tracking:
- **Telemetry & Cooldown Tracker:** Monitors runtime execution for rate-limit conditions (HTTP 429, usage limit errors) and assigns temporary cooldowns.
- **Immediate Expiry Sanitization:** Cooldown timestamps are continuously evaluated; expired cooldowns immediately restore operational status without waiting for cache invalidation.
- **Provider Allowlist Enforcement:** `smart_quota` candidate evaluation strictly respects `routing.allowedBackends`.

### Selection Algorithm in `smart_quota` Mode:
1. Identify all installed CLIs permitted by `routing.allowedBackends`.
2. Filter out exhausted or rate-limited backends (`usedPercent >= 100` or active `rate_limited` cooldown).
3. If only one healthy backend remains, select it immediately.
4. If multiple healthy backends have measured metrics:
   - Select the backend with significantly higher headroom (difference $\ge 10\%$).
   - Otherwise, select the backend with the earlier reset timestamp.
5. If metrics are unmeasured/null, select the first available backend in configured preference order.
6. If all backends are rate-limited, fail fast with a clear notification showing the earliest cooldown reset timestamp.

---

## 4. Real-Time Observable Activity Streaming (v1.1.0 Roadmap)

### Problem Definition:
Displaying a generic elapsed-time ticker like `Processing with Codex CLI... (45s elapsed)` provides poor user feedback and looks like an unresponsive process. The user must clearly see what subagents are doing and thinking in real time.

### Architecture (`codex exec --json` & Streaming Decoder):
```text
CLI Process (stdout) ───► JSONL Stream Decoder ───► Event Normalizer ───► MCP notifications/progress
                                                                     ├──► Final Output Accumulator
```

1. **JSONL Event Normalization:**
   Run Codex with `--json` and stream newline-delimited JSON events:
   - `thread.started`: Captures `thread_id` immediately.
   - `turn.started`: Emits `[Codex] Initializing task analysis...`.
   - `item.started`: Emits real-time activities:
     - `command`: `[Codex] Running git diff...`
     - `file_search` / `read_file`: `[Codex] Reading src/router.js...`
     - `thought` / `summary`: `[Codex] Analyzing architecture & potential edge cases...`
   - `item.completed`: Emits step completion.
2. **MCP Progress Protocol Adherence:**
   - Increments an indeterminate progress counter (`observedUpdates++`) while omitting `total`.
   - Throttles progress notifications to 2-4 updates per second to avoid UI saturations.
   - Incorporates an idle heartbeat (`[Codex] Reasoning in progress... (15s since last action)`) when long model generation produces no interim tool events.
3. **Response Isolation:**
   - Raw JSONL streams are kept off stdout of the MCP server.
   - Final responses are extracted cleanly from completed agent messages or `-o <file>`.

---

## 5. Multi-Turn Session & Thread Persistence (v1.1.0 Roadmap)

### Problem Definition:
Spawning a brand new CLI process on every MCP request causes the agent to lose conversation context, forcing it to repeatedly re-index and re-read the repository during iterative code reviews.

### Architecture & Session Lifecycle:
1. **Opaque Session Handle (`session_handle`):**
   - MCP tool responses return an opaque `session_handle` (e.g. `omni_sess_a8f91c`).
   - Subsequent calls accept `session_handle: "omni_sess_a8f91c"`.
2. **Backend Thread Mapping:**
   - `session_handle` maps to Codex `thread_id` (or Claude session UUID).
   - In Codex: Spawns `codex exec resume <thread_id> -` via stdin.
   - In Claude: Spawns `claude --resume <session_id>`.
3. **Lifecycle Management:**
   - One active turn per thread to prevent race conditions.
   - Sandboxing and read-only policies are re-applied strictly on every resumed invocation.
   - Expired or completed sessions can be explicitly terminated using tool `omniagent_close_session`.

---

## 6. Zero-Friction Bug & Issue Reporting (v1.1.0 Roadmap)

### Problem Definition:
Users encounter errors or environment quirks and want to report bugs directly to GitHub (`nyupyu/omniagent`), but the MCP server cannot authenticate to GitHub on behalf of the user without credentials.

### Dual-Channel Architecture:
1. **Channel A: Pre-Filled Issue URL (Zero-Auth / 1-Click Browser Workflow - Default):**
   - Constructs a standardized, pre-filled URL:
     `https://github.com/nyupyu/omniagent/issues/new?title=...&body=...`
   - Formats a comprehensive, sanitized markdown bug report:
     - OmniAgent version, Node.js version, OS platform & architecture.
     - Installed CLI versions & diagnostic summary from `omniagent_doctor`.
     - Error category and sanitized stack trace.
     - **Strict Privacy Sanitization:** Strips all personal tokens (`*_API_KEY`, Bearer tokens), user home paths, and repository code.
   - User reviews the pre-filled issue in their browser and clicks "Submit new issue".
2. **Channel B: GitHub CLI Integration (`gh issue create` - Opt-In):**
   - Asynchronously probes `gh auth status`.
   - If authenticated, prompts the user: *"Would you like OmniAgent to submit this issue directly via GitHub CLI (`gh issue create`)?"*
   - Upon explicit consent, executes `gh issue create --repo nyupyu/omniagent --title ... --body-file -` via stdin without opening external shells.

---

## 7. TypeScript Architecture & Fast Bundling Blueprint (`tsdown`)

> *"When building an MCP (Model Context Protocol) server for VS Code, TypeScript (TS) is highly recommended over plain JavaScript (JS)."*

To ensure long-term maintainability, eliminate monolithic handler files, and establish strong compile-time type safety before tagging v1.0.0, OmniAgent adopts modern TypeScript with **`tsdown`** as the dedicated bundler (following best practices from [modelcontextprotocol.io](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server), [masseater/mcp-server-template](https://github.com/masseater/mcp-server-template), and [tsdown.dev](https://tsdown.dev)).

### 7.1 Bundler Selection: Why `tsdown` over Webpack & `tsup`

- **Webpack is deprecated for Node CLI/MCP servers:** Webpack was designed for browsers and complex frontend bundling; in Node.js stdio MCP servers, it adds heavy overhead, 15-30s build times, and bloated configuration.
- **`tsup` is in maintenance mode:** As officially announced by the author:
  > *"This project is not actively maintained anymore. Please consider using [tsdown](https://github.com/rolldown/tsdown/) instead. Read more in [the migration guide](https://tsdown.dev/guide/migrate-from-tsup)."*
- **`tsdown` (Powered by Rolldown + Oxc in Rust):**
  - **Blazing Fast:** 2x to 8x faster than `tsup`, compiling and bundling in under 100ms.
  - **Single Executable Bundle (`bundle: true`):** Bundles dependencies into a single output file (`dist/index.cjs`), cutting VS Code cold-start latency to near-instant by eliminating multi-file disk traversal of `node_modules`.
  - **Target Node 22+ LTS:** Clean ECMAScript syntax compilation targeting Node.js 22 LTS.
  - **Native Hashbang Support:** Preserves `#!/usr/bin/env node` and produces directly executable binaries for CLI and MCP clients.
  - **Output Format (CommonJS `format: ['cjs']`):** Guarantees rock-solid stability with Node stdio transport, child process spawning, and backward compatibility with test harnesses.

### 7.2 Stdio Protocol & Stderr Safety (Codex Sol Audit Mandate)

- **Exclusive Protocol Ownership:** **Only the MCP transport writes to `process.stdout`**.
- **No stdout pollution:** Direct stdout writes, `console.log`, and child process stdout inheritance are strictly prohibited.
- **Injected Stderr Logger:** All operational logs, diagnostics, and debug traces are directed to `stderr` (`console.error`).

### 7.3 Session Lock Race Resolution (Codex Sol Audit Mandate)

- Rather than relying on a potentially destructive reap-rename that could stomp a concurrently acquired fresh lock, the TypeScript `SessionService` implements:
  - Exclusive atomic lock acquisition.
  - Asynchronous bounded backoff retry loop (replacing blocking synchronous busy-spin).
  - Explicit per-turn ownership tokens validated on write and release.

### 7.4 Refactored Modular Structure:
```text
omniagent/
├── tsconfig.json                 # Strict TypeScript configuration (target: ES2022, moduleResolution: NodeNext)
├── tsdown.config.ts              # Modern Rust-powered bundler config (format: cjs, target: node22, bundle: true)
├── package.json                  # scripts: build, dev, test, typecheck; bin: dist/index.cjs
├── src/
│   ├── index.ts                  # Minimal CLI bootstrap, hashbang, & StdioServerTransport lifecycle
│   ├── server.ts                 # McpServer instantiation & modular tool attachment
│   ├── types/                    # Shared TypeScript interfaces & types
│   │   ├── adapter.types.ts
│   │   ├── session.types.ts
│   │   ├── config.types.ts
│   │   ├── quota.types.ts
│   │   └── issue.types.ts
│   ├── services/                 # Core domain business logic
│   │   ├── session.service.ts    # Atomic turn locking & persistence (safe async backoff)
│   │   ├── quota.service.ts      # Cooldown & rolling limit tracking
│   │   ├── router.service.ts     # Privacy guard & backend resolution
│   │   ├── issue.service.ts      # Privacy redaction & GitHub bug reports
│   │   ├── config.service.ts     # User preference persistence
│   │   ├── git.service.ts        # Git scope & ref sanitization
│   │   └── policy.service.ts     # Astra/Opus model governance
│   ├── adapters/                 # Typed CLI process adapters
│   │   ├── base.adapter.ts       # Shared adapter interface and safe stream decoder
│   │   ├── codex.adapter.ts      # Codex CLI streaming & execution
│   │   ├── claude.adapter.ts     # Claude Code CLI sandboxed execution
│   │   └── gemini.adapter.ts     # Gemini CLI prober
│   └── tools/                    # Modular typed tool definitions
│       ├── review.tool.ts        # omniagent_review & codex_review_code
│       ├── consult.tool.ts       # omniagent_consult & codex_consult
│       ├── analyze.tool.ts       # omniagent_analyze & codex_analyze
│       ├── debug.tool.ts         # codex_debug_error
│       ├── implement.tool.ts     # codex_implement
│       ├── doctor.tool.ts        # omniagent_doctor & codex_status
│       ├── quota.tool.ts         # omniagent_quota_status
│       ├── config.tool.ts        # omniagent_set_default
│       ├── session.tool.ts       # omniagent_close_session
│       └── issue.tool.ts         # omniagent_report_bug
├── test/                         # Unit tests (node --test)
└── dist/                         # Compiled bundle (dist/index.cjs)
```

---

## 8. MCP Tool Catalog

### Primary Multi-Agent Tools:
1. **`omniagent_doctor`** - Comprehensive multi-agent diagnostics (CLI availability, versions, paths, auth profiles, and non-intrusive install instructions).
2. **`omniagent_review`** - Cross-model code review (`backend: "auto" | "codex" | "claude" | "smart_quota"`, with session continuation).
3. **`omniagent_consult`** - Cross-model architectural consultation and second opinion.
4. **`omniagent_analyze`** - Cross-model codebase and dependency analysis in read-only mode.
5. **`omniagent_set_default`** - Persistently sets the default backend in `~/.omniagent/config.json`.
6. **`omniagent_quota_status`** - Fast inspection of active rate limits and cooldown statuses.
7. **`omniagent_report_bug`** - Generates sanitized GitHub issue report URL / submits via GitHub CLI with user consent.
8. **`omniagent_close_session`** - Closes and clears active multi-turn session handle.

### Legacy Codex Tools (100% Backward Compatible):
- `codex_status` $\rightarrow$ `src/tools/doctor.tool.ts`
- `codex_review_code` $\rightarrow$ `src/tools/review.tool.ts`
- `codex_consult` $\rightarrow$ `src/tools/consult.tool.ts`
- `codex_analyze` $\rightarrow$ `src/tools/analyze.tool.ts`
- `codex_debug_error` $\rightarrow$ `src/tools/debug.tool.ts`
- `codex_implement` $\rightarrow$ `src/tools/implement.tool.ts`

---

## 9. Execution Checklist & Migration Plan

- [x] **Step 1: Core utility modules** (`src/process.js`, `src/git.js`, `src/progress.js`, `src/policy.js`).
- [x] **Step 2: Backend adapters & JSONL streaming** (`src/adapters/codex.js`, `src/adapters/claude.js`, `src/adapters/gemini.js`).
- [x] **Step 3: Multi-turn session persistence & turn locking** (`src/session.js`).
- [x] **Step 4: Sanitized issue reporting & secret redaction** (`src/issue.js`).
- [x] **Step 5: Diagnostic engine & persistent onboarding** (`src/doctor.js`, `src/config.js`, `src/quota.js`).
- [x] **Step 6: TypeScript & `tsdown` Toolchain Setup** (`npm install -D tsdown typescript @types/node`, `tsdown.config.mts`, `tsconfig.json`).
- [x] **Step 7: Modular TS Architecture Migration** (Disassemble monolithic code into `src/types/*.ts`, `src/services/*.ts`, `src/adapters/*.ts`, `src/tools/*.ts`, `src/server.ts`, `src/index.ts`).
- [x] **Step 8: Build Verification & Strict Typecheck** (`npm run typecheck`, `npm run build`, `npm test` verifying 100% test pass).
- [x] **Step 9: Author-Reviewer Audit Gateway & Hardening (Codex Sol Consultation)**:
  - [x] **9.1 Routing Consistency**: Filter `smart_quota` candidates strictly against `routing.allowedBackends` and verify `probe.installed` before returning.
  - [x] **9.2 Contract Strict Typing**: Replace `adapter: any` and `request.params as any` with `CliAdapter` interfaces and runtime schema validation.
  - [x] **9.3 Process & Stream Safety**: Enforce process tree termination on POSIX (`-proc.pid`) and bounded stream buffers for stdout/stderr to prevent memory leaks.
  - [x] **9.4 CI Matrix Hardening**: Fix Node 20 Windows glob expansion issue (`Could not find ...\test\*.test.js`) and update CI workflow from legacy `node --check` to `npm run typecheck` + `npm run build`.
- [x] **Step 10: Author-Reviewer Final Sign-Off (`codex_review_code`)** for zero P1/P2 findings.
- [x] **Step 11: Release Candidate (RC) Tagging & Extension Verification**:
  - [x] Git commit and tag `v1.0.0-rc.1`.
  - [x] End-to-end verification across VS Code and Antigravity.
  - [x] Package validation (`npm pack --dry-run`).

---

## 10. Audit Findings from Codex Sol (`gpt-6.1-sol`)

During live MCP consultation on October 3, 2026, **Codex Sol** (`gpt-6.1-sol`) audited the newly migrated TypeScript codebase and approved the core architecture while recommending 4 key hardenings for Release Candidate:

1. **Routing Policy Consistency (`router.service.ts`):**
   - The `smart_quota` path must strictly filter candidates against `config.routing.allowedBackends` before passing them to `selectSmartQuotaBackend`.
   - The selected backend must be confirmed as installed and operational before invocation; fail fast with clear install guidance if not.
2. **Contract & Parameter Typing (`server.ts` & `router.service.ts`):**
   - Eliminate `any` types in `ResolvedBackend.adapter` by implementing the `CliAdapter` interface across all adapters (`codex.adapter.ts`, `claude.adapter.ts`, `gemini.adapter.ts`).
   - Validate MCP tool call arguments at runtime instead of blind casting `request.params as any`.
3. **POSIX Process Tree Termination & Stream Memory Bounds (`process.service.ts`):**
   - On POSIX systems, `proc.kill('SIGTERM')` only signals the root shell process. Support process group termination (via `detached: true` and `process.kill(-proc.pid, 'SIGTERM')`) where applicable to guarantee complete cleanup of spawned CLI child sub-trees.
   - Enforce bounded memory buffers (`MAX_STDOUT_BYTES = 512 * 1024`) in `runCommand` to avoid memory exhaustion from runaway processes.
4. **CI Matrix & Windows Node 20 Compatibility (`ci.yml`):**
   - In GitHub Actions, Node 20 on Windows fails with `Could not find ...\test\*.test.js` because `cmd.exe` does not expand globs and Node 20's `--test` runner expects already-expanded file paths. Running tests via `tsx --test` or letting the native test runner discover files resolves the failure.
   - Replace legacy `node --check index.js src/*.js` in `.github/workflows/ci.yml` with modern `npm run typecheck` and `npm run build`.

---

## 11. Systematic Rebranding & Purge Roadmap: OmniAgent -> CoAgent8

Following user direction, all internal and external artifacts, handles, configuration directories, and environment variables are transitioning from the legacy `omni` prefix to `syn`:

### Action Items & Transition Status
- [x] **Session Handle Prefixes**: Migrated default generated session handles from `omni_sess_*` to `syn_sess_*` (`src/services/session.service.ts` & `src/constants/index.ts`). Backward compatibility retained for reading/pruning legacy `omni_sess_*` session files.
- [ ] **TypeScript Interfaces & Types**: Rename `OmniAgentConfig` -> `CoAgent8Config` in `src/types/config.types.ts` and services (maintaining a deprecated type alias for backwards compatibility).
- [ ] **Logger & Error Prefixes**: Replace all remaining `[OmniAgent]` console log and error tags with `[CoAgent8]` across adapters, services, and tool handlers.
- [ ] **Configuration & Environment Variables**: Complete transition of primary configuration paths to `~/.coagent8/config.json` and `coagent8_*` env vars, retaining `~/.omniagent` and `OMNIAGENT_*` exclusively as legacy fallbacks.
- [ ] **Legacy Tool Aliases (`omniagent_*`)**: Mark all `omniagent_*` tool definitions with explicit `@deprecated (Use coagent8_* instead)` annotations.
- [ ] **Documentation & Rules Cleanup**: Scrub lingering mentions of `omniagent` across `.agents/rules/*.md`, `docs/`, and `README.md` while keeping deliberate legacy compatibility documentation intact.
