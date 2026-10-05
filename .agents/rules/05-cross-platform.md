# P2: Cross-Platform & CI Matrix Guardrails (`05-cross-platform.md`)

> **Priority Level: P2 (Compatibility & Code Standards)**  
> Universal cross-platform compatibility across Windows, macOS, and Linux.

---

## 1. Supported CI Environment Matrix
CoAgent is verified across a 6-job matrix:
* **Operating Systems:** Ubuntu (`ubuntu-latest`), macOS (`macos-latest`), Windows (`windows-latest`).
* **Node.js LTS Versions:** Node 20.x and Node 22.x.

---

## 2. Cross-Platform Runtime Rules

All test/helper launches on Windows must suppress visible windows, including
descendants launched through PowerShell `Start-Process` (`-WindowStyle Hidden`).
Hiding a parent with `windowsHide: true` is not enough for independently launched
descendants. Keep cancellation and awaited cleanup while reducing redundant
supervision; do not remove process-tree guarantees to suppress windows.

1. **No Shell Glob Assumptions:**
   - `tests/helpers/discovery.cjs` selects only `*.test.js` recursively under `tests/`, excluding fixtures, helpers, consumer tooling and artifacts. Both tests and coverage invoke `tests/run.cjs`, which passes each discovered path as an individual argument to tsx. Empty discovery fails. Never pass shell globs to Node's test runner.
2. **Process Tree Teardown:**
   - On POSIX: Spawn detached (`detached: true`) and terminate using process group signalling (`process.kill(-proc.pid, 'SIGTERM')` followed by `SIGKILL`).
   - On Windows: Terminate the owned tree so that no owned background child process survives. Destroy stdio streams upon exit.
   - **Process identity (safety invariant):**
     - A process's identity is its PID **plus its creation time**. Never select a
       process for termination by PID or `ParentProcessId` alone. Windows keeps
       stale parent PIDs and reuses PIDs, so a parent-PID match can name an
       unrelated user process.
     - A descendant is owned only if it was created no earlier than its verified
       parent and the root identity was captured while the root was alive.
     - Re-check identity immediately before each kill. Do not apply `/T` to a PID
       whose identity is unverified.
     - Process-name allow/deny lists are not a safety mechanism and must not
       substitute for identity checks.
     - Do not start a sweep after a clean exit when no descendant was observed.
     - Test teardown selection with synthetic process snapshots and owned fixture
       trees, never by sweeping a live desktop. The current implementation
       violates this invariant; remediation is `WINDOWS-001` (AUD-P0-1) in the
       [roadmap](../../docs/ROADMAP.md#audit-remediation-index).
3. **Memory Limits & Stream Safety:**
   - Always enforce strict `maxBufferBytes` (512 KiB in `runCommand`, 4 MiB in `runGit`) and `StringDecoder` to prevent split UTF-8 corruption and memory exhaustion.
4. **Node 20 Build Compatibility:**
   - The standalone and VSIX builds use esbuild targeting Node 20. No Promise polyfill or tsdown preload is required.
