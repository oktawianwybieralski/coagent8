# P2: Cross-Platform & CI Matrix Guardrails (`05-cross-platform.md`)

> **Priority Level: P2 (Compatibility & Code Standards)**  
> Universal cross-platform compatibility across Windows, macOS, and Linux.

---

## 1. Supported CI Environment Matrix
CoAgent8 is verified across a 6-job matrix:
* **Operating Systems:** Ubuntu (`ubuntu-latest`), macOS (`macos-latest`), Windows (`windows-latest`).
* **Node.js Versions:** Node 24.x (LTS) and Node 26.x. The minimum supported
  version is 24.0 (`engines` in `package.json`); older release lines are not
  supported.

---

## 2. Cross-Platform Runtime Rules

All test/helper launches on Windows must suppress visible windows, including
descendants launched through PowerShell `Start-Process` (`-WindowStyle Hidden`).
Hiding a parent with `windowsHide: true` is not enough for independently launched
descendants. Keep cancellation and awaited cleanup; do not trade teardown
guarantees for window suppression.

1. **No Shell Glob Assumptions:**
   - `tests/helpers/discovery.cjs` selects only `*.test.js` recursively under `tests/`, excluding fixtures, helpers, consumer tooling and artifacts. Both tests and coverage invoke `tests/run.cjs`, which passes each discovered path as an individual argument to tsx. Empty discovery fails. Never pass shell globs to Node's test runner.
   - **Hermetic test environment:** `tests/run.cjs` runs the whole suite in the environment from `tests/helpers/environment.cjs`: backend CLIs point to the fixtures, profile and configuration roots point to a disposable directory, and `PATH` keeps only Node.js, Git and the operating system. Tests never start a real Claude, Codex or agy installation (which would load the user's MCP servers and shells, open windows and spend quota). `tests/environment.test.js` fails when the suite runs outside `tests/run.cjs` or a real CLI is reachable. A test that needs another CLI uses a fixture under `tests/fixtures/`.
2. **Process Teardown (safety invariant):**
   - Terminate only what this process owns: a spawned `ChildProcess` through its
     handle (`proc.kill()`; on Windows `TerminateProcess` on the handle held since
     spawn) or, on POSIX, the process group created by spawning it detached
     (`process.kill(-proc.pid, 'SIGTERM')` followed by `SIGKILL`).
   - Never select a process by PID, `ParentProcessId`, creation-time heuristics or
     process name. Windows keeps stale parent PIDs and reuses PIDs, so a parent-PID
     match can name an unrelated user process. Do not use `taskkill /T`,
     `Stop-Process`, CIM/WMI snapshots or descendant polling.
   - Stop a protocol CLI gracefully first: interrupt its turn over its own
     protocol and close stdin on the terminal event, then force-stop the owned root
     after a bounded grace period.
   - Descendants are the backend's responsibility. A chain of Node processes ends
     with its root through libuv's `KILL_ON_JOB_CLOSE` job on Windows. A per-run Job
     Object helper is the only acceptable way to extend ownership to other
     descendants (`WINDOWS-001` in the [roadmap](../../docs/ROADMAP.md)).
   - After the root exits, stop waiting for inherited stdout/stderr after a bounded
     drain period instead of searching for the holder.
   - Test teardown with owned fixture trees only, never by sweeping a live desktop.
3. **Memory Limits & Stream Safety:**
   - Always enforce strict `maxBufferBytes` (512 KiB in `runCommand`, 4 MiB in `runGit`) and `StringDecoder` to prevent split UTF-8 corruption and memory exhaustion.
4. **Node 24 Build Compatibility:**
   - The standalone and VSIX builds use esbuild targeting Node 24. No polyfill or preload is required.
