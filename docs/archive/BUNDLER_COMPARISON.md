# Bundler Comparison: esbuild vs tsdown for the MCP Server

Date: 2026-10-06. Branch: `perf/tsdown-bundle-comparison`, based on
`fix/hermetic-test-environment` (`076b59d`). Candidates: esbuild 0.25.12 and
tsdown 0.23.0 (rolldown 1.2.12). The first version of this report (`a36a267`)
measured only warm start-up. It recommended staying on esbuild and is superseded
by this version. Section 9 explains what changed.

**Question.** Does building the MCP server with tsdown make the server faster for
a user, above all on its first launch, and is that worth a new dev dependency?

**Answer.** Yes. The build now uses tsdown (`5ab841f`). In VS Code 1.140 on
Windows, starting the server from a newly written bundle until VS Code has its
tools dropped from **484 ms to 218 ms** (median of 20). Warm start improved 9% in
VS Code and 9-12% on Linux. Most of the first-launch gain does not come from
JavaScript execution. Microsoft Defender scans esbuild's identifier-mangled
output about four times longer than tsdown's (section 5). The bundle no longer
contains license comments; the notices ship in `dist/THIRD_PARTY_NOTICES.txt`
(section 8). The largest remaining cost is the MCP SDK and its zod/ajv
dependencies (section 6).

## 1. Environment

| Item | Value |
| --- | --- |
| Windows | Windows 11 Pro 10.0.26200, AMD Ryzen 5 7235HS (8 logical cores), 31.7 GiB, AC power, "Balanced" power plan |
| Linux | Docker Desktop 29.1.3 on the same machine, kernel 6.6.87.2-microsoft-standard-WSL2, images `node:24-slim` and `node:26-slim` |
| Node.js | 24.21.0 (Scoop `nodejs-lts`) and 26.10.0 (Scoop `nodejs`) on Windows; 24.21.0 and 26.10.0 in the containers |
| VS Code | 1.140.0, isolated profile (`--user-data-dir`, `--extensions-dir`, `--disable-extensions`) |
| Antivirus | Microsoft Defender, real-time and on-access protection on; platform 4.18.26080.4, engine 1.1.26080.3, signatures 1.459.576.0 |
| Bundlers | esbuild 0.25.12, tsdown 0.23.0, rolldown 1.2.12 |

Every process the scripts spawned used `windowsHide: true`, except the VS Code
instance, which the owner asked for (one "Extension Development Host" window).
Servers ran in the hermetic environment from `tests/helpers/environment.cjs`.
No real backend CLI was started; the handshake calls no backend.

## 2. Candidates and equivalence

All candidates are built from the same source, with `keepNames`, `target: node24`,
CJS, a source map, every dependency inlined and **no legal comments** (esbuild
`legalComments: 'none'`; rolldown `comments: { legal: false, annotation: false,
jsdoc: false }`). The script is in Appendix B (`candidates.cjs`).

| Name | Build | Size (B) | gzip -9 (B) |
| --- | --- | --- | --- |
| `es-mangle` | esbuild `minify: true` (the previous build, without its legal comment) | 491142 | 149689 |
| `es-nomangle` | esbuild `minifyWhitespace` + `minifySyntax`, no identifier mangling | 707849 | 170967 |
| `td-mangle` | tsdown `minify: true` | 493019 | 137599 |
| `td-nomangle` | tsdown `minify: { compress: true, mangle: false, codegen: true }` | 642954 | 157186 |
| `ceiling-raw` | 918-byte JSON-RPC responder without the SDK, same nine-tool payload shape (reference floor only) | 918 | - |

`td-mangle` is the adopted build. `npm run build` now produces it byte-identically
(`66690a03...`) on Node 24.21.0 and 26.10.0.

Gate results for the adopted build (Windows):

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS, no `/*!`, `@license`, `@preserve`, `SPDX` or `Copyright` text in `dist/index.cjs` |
| `npm test` on Node 24.21.0 | PASS: 199 tests, 197 pass, 0 fail, 2 skipped |
| `node tests/run.cjs` on Node 26.10.0 | PASS: 199 tests, 197 pass, 0 fail, 2 skipped |
| `npm pack --dry-run` | PASS: 72 files, `dist/index.cjs` 493.0 kB, `dist/THIRD_PARTY_NOTICES.txt` 12.6 kB |
| `npm run test:consumer` | PASS, including the new assertions: no license comments in the installed bundle, notices cover the bundled packages, no tsdown/rolldown/esbuild in the consumer |
| `npm run build:vscode` | PASS, `THIRD_PARTY_NOTICES.txt` copied into the VSIX `dist/` |
| Negative checks | The previous esbuild bundle fails the new no-license assertion. A tsdown build that externalizes dependencies fails the external-import check. |

## 3. Method

- **Start-up time** (`startbench.cjs`). One process per run. `initialize` is
  written right after `spawn`, and the clock stops when its response arrives.
  `tools/list` follows. Variants run round-robin with a rotating start.
  95% intervals are percentile bootstrap (5000 resamples) of the median ratio
  against `es-mangle`.
  - *warm*: the same file every run, after 5 discarded warm-up rounds.
  - *fresh*: before every run the bundle is copied (`fs.copyFileSync`) to a new
    directory and started immediately. Section 5 shows that this is the
    worst case for Defender.
- **VS Code** (`vscode-bench/`). An isolated VS Code 1.140.0 runs a helper
  extension that registers the server through
  `vscode.lm.registerMcpServerDefinitionProvider` (the same API as the CoAgent8
  extension). Each run gets a new server label. In fresh mode it also gets a
  newly copied bundle. The clock runs from
  `workbench.mcp.startServer('*', { waitForLiveTools: true })` until VS Code has
  the server's 9 tools. VS Code's own MCP log ("Starting server" to "Discovered 9
  tools") is reported as a cross-check.
- **Linux**: the same `startbench.cjs` inside `node:24-slim` and `node:26-slim`.
  Bundles are copied into the container file system first.
- **Defender**: `open-probe.cjs`, `write-modes.cjs`, `write-delay.cjs` and
  `copy-delay.cjs` time only the open and read of a file in a new hidden Node
  process, with no JavaScript executed from it.
- **Profile**: `node --cpu-prof --cpu-prof-interval 100` on an unminified esbuild
  bundle, with self time attributed to the original module through esbuild's
  module comments.

Round 1 showed no difference between running from the repository and from the
installed tarball (section 9), so round 2 runs every bundle from
`.artifacts/bundler/cand/`.

## 4. Results

### 4.1 Windows, synthetic host (40 runs per cell)

`initialize` in ms. The ratio compares with `es-mangle` in the same cell.

| Node / mode | Variant | median | p95 | IQR | ratio (95% CI) |
| --- | --- | --- | --- | --- | --- |
| 24 fresh | es-mangle | 420.9 | 547.9 | 412.1-476.3 | 1 |
| 24 fresh | es-nomangle | 205.3 | 244.2 | 199.0-230.9 | 0.488 (0.457-0.511) |
| 24 fresh | **td-mangle** | **176.4** | 205.0 | 173.3-182.4 | **0.419 (0.392-0.428)** |
| 24 fresh | td-nomangle | 182.7 | 216.6 | 175.2-202.9 | 0.434 (0.405-0.449) |
| 24 warm | es-mangle | 125.3 | 144.7 | 122.5-132.1 | 1 |
| 24 warm | es-nomangle | 124.9 | 146.2 | 120.9-133.9 | 0.996 (0.960-1.039) |
| 24 warm | **td-mangle** | **115.4** | 133.5 | 110.2-120.0 | **0.921 (0.886-0.942)** |
| 24 warm | td-nomangle | 120.5 | 137.1 | 114.3-125.8 | 0.961 (0.919-0.996) |
| 26 fresh | es-mangle | 430.7 | 552.8 | 420.5-513.0 | 1 |
| 26 fresh | es-nomangle | 211.2 | 252.1 | 202.9-231.8 | 0.490 (0.465-0.525) |
| 26 fresh | **td-mangle** | **190.0** | 215.4 | 178.3-201.0 | **0.441 (0.414-0.467)** |
| 26 fresh | td-nomangle | 193.4 | 216.7 | 183.1-208.3 | 0.449 (0.419-0.472) |
| 26 warm | es-mangle | 127.5 | 157.9 | 123.8-139.6 | 1 |
| 26 warm | es-nomangle | 131.8 | 213.0 | 124.0-146.3 | 1.033 (0.958-1.085) |
| 26 warm | **td-mangle** | **123.2** | 161.8 | 118.0-129.9 | **0.966 (0.907-0.992)** |
| 26 warm | td-nomangle | 123.1 | 157.1 | 116.6-131.7 | 0.965 (0.903-0.997) |

### 4.2 VS Code 1.140.0 as the host (Windows, Node 24.21.0)

Time from `workbench.mcp.startServer` until VS Code has the 9 tools, in ms.

| Mode | Variant | n | median | IQR | p95 | range | VS Code log median (IQR) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fresh | es-mangle | 20 | 484 | 467-511 | 603 | 456-606 | 459 (445-490) |
| fresh | es-nomangle | 20 | 253 | 240-278 | 305 | 231-307 | 225 (221-238) |
| fresh | **td-mangle** | 20 | **218** | 215-236 | 263 | 204-267 | 199 (194-208) |
| fresh | td-nomangle | 20 | 220 | 216-242 | 299 | 211-320 | 201 (196-217) |
| fresh | ceiling-raw | 20 | 100 | 96-103 | 128 | 90-130 | 80 (78-83) |
| warm | es-mangle | 11 | 169 | 163-184 | 274 | 157-341 | 147 (141-158) |
| warm | es-nomangle | 11 | 168 | 161-189 | 230 | 152-259 | 145 (141-159) |
| warm | **td-mangle** | 10 | **153** | 153-163 | 176 | 144-183 | 136 (131-141) |
| warm | td-nomangle | 10 | 158 | 152-170 | 202 | 144-209 | 136 (131-143) |
| warm | ceiling-raw | 10 | 96 | 93-101 | 102 | 92-102 | 78 (76-78) |

The warm mode has only 10-11 runs per variant. The VS Code window was closed
after run 172 of 220. A repeat with the window in the background was discarded
in full: in most runs VS Code did not pick up the new server definition within
the 1.5 s gap (`newTools: 0`, no `resolveMcpServerDefinition` call). Every run in
the table started the server and listed 9 tools.

### 4.3 Linux containers (40 runs per cell, no antivirus)

| Node / mode | es-mangle | es-nomangle | **td-mangle** | td-nomangle | ceiling-raw |
| --- | --- | --- | --- | --- | --- |
| 24 warm, median (p95) | 115.5 (128.7) | 112.6 (126.1) | **102.1 (117.9)**, ratio 0.885 (0.857-0.929) | 104.9 (117.5) | 33.8 (38.5) |
| 24 fresh, median (p95) | 115.7 (137.4) | 117.2 (131.0) | **105.1 (121.5)**, ratio 0.908 (0.867-0.935) | 105.5 (117.1) | 34.0 (42.5) |
| 26 warm, median (p95) | 118.3 (136.0) | 118.6 (147.1) | **105.4 (135.6)**, ratio 0.891 (0.867-0.935) | 109.5 (124.0) | 34.8 (39.6) |
| 26 fresh, median (p95) | 117.7 (132.9) | 117.5 (134.7) | **103.9 (116.1)**, ratio 0.883 (0.867-0.902) | 107.8 (121.3) | 33.6 (38.7) |

Without an on-access scanner, fresh and warm are equal, and turning off
identifier mangling in esbuild gives nothing. tsdown's 9-12% is a runtime gain.
This report did not establish why rolldown's output starts faster.

### 4.4 Other metrics

| Metric | esbuild (previous) | tsdown (adopted) |
| --- | --- | --- |
| `tools/list` after `initialize` (round 1, Windows) | 3.1-3.3 ms | 3.1-3.3 ms |
| `tools/call session list`, running server (round 1) | 10.0 ms median | 10.3 ms median |
| RSS after `tools/list` (round 1) | 60.0 MiB | 58.2 MiB |
| Bundle raw / gzip | 493084 / 151237 B (with its legal comment) | 493019 / 137599 B (no comments) |
| Source map | 1888372 B | 1962531 B |
| Tarball (`npm pack`) | 729644 B, 71 files | 722.9 kB, 72 files (adds the notices) |
| Build time, whole process, median of 10 (p95) | 251 ms (295) | 448 ms (467) |
| Dev tooling Node floor | 24.0 | 24.11 (`devEngines`) |

## 5. How Defender affects the first launch

Microsoft Defender's real-time protection is a file-system filter. When a process
opens a file that Defender has not cleared since its last change, the open waits
for the scan to finish. Defender caches the verdict for the unchanged file, so
later opens take about 3 ms.

Time for the first open and read of each bundle, with no JavaScript executed
(`open-probe.cjs`, 20 runs, round 1 builds):

| Bundle | Size (B) | first open, median (IQR) | reopen |
| --- | --- | --- | --- |
| esbuild `minify` (previous options) | 493084 | 303.5 (297.1-306.3) | 3.3 |
| esbuild `legalComments: 'none'` | 491142 | 303.6 (295.2-361.5) | 3.3 |
| esbuild `keepNames: false` | 469429 | 289.7 (280.6-301.5) | 3.2 |
| esbuild without minification | 1002635 | 108.7 (106.1-118.1) | 3.4 |
| esbuild whitespace + syntax only | 709791 | 82.1 (80.4-93.6) | 3.4 |
| tsdown (round 1 build) | 515441 | 65.4 (62.1-69.0) | 3.3 |

The cost follows identifier mangling in esbuild's output, not size: the
unminified file is twice as large and scans three times faster. Legal comments
and `keepNames` have no effect. rolldown's mangled output does not trigger the
slow path. That the scanner treats esbuild's short mangled identifiers as
possible obfuscation is an inference; Defender does not report why a scan takes
longer.

**When the scan is paid.** The timing depends on how the file reached the disk
(`write-modes.cjs`, `write-delay.cjs`, `copy-delay.cjs`, medians in ms):

| How the file was written | Delay before first open | esbuild `es-mangle` | tsdown `td-mangle` |
| --- | --- | --- | --- |
| `fs.writeFileSync` (ordinary write, as `npm install`, `npx` and archive extraction do) | 0 ms | 271.7 | 4.9 |
| same | 250 ms | 10.8 | 3.6 |
| same | 500 ms to 5 s | 3.4-4.1 | 3.4-4.6 |
| `fs.copyFileSync` (Windows `CopyFileW`) | 0 ms to 5 s | 309.3-326.1 | 69.7 (0 ms) |

- After an ordinary write, Defender scans in the background as soon as the file
  is closed. A launch waits only if it opens the file before that scan ends,
  which takes about 270 ms for the esbuild bundle. That happens when a package
  is installed and run at once: `npx -y coagent8@<version>`, the launch path the
  README documents, on its first run of each version, and hosts that install or
  update a server and start it immediately.
- After a kernel copy (`CopyFileW`), Defender defers the scan to the first open,
  however long that is after the copy. That happens when a host or tool copies
  an installed package directory, for example a plugin cache.
- When `npm install` runs well before the host starts the server, the scan has
  finished already. The first launch then costs the same as a warm start, and
  the difference is the warm-start gain from sections 4.1-4.3.
- Not verified: whether a Defender signature or engine update invalidates the
  cached verdicts and makes the next launch scan again. `MpCmdRun -SignatureUpdate`
  reported "No updates needed" during the session, so this could not be tested.

The "fresh" rows in sections 4.1 and 4.2 copy with `fs.copyFileSync` and start
immediately, so they show the case in which the scan lands on the launch.

## 6. Where the remaining time goes

CPU profile of one start-up through `tools/list` (3 profiles, mean sampled time
115.7 ms, unminified esbuild bundle, self time):

| Item | ms |
| --- | --- |
| Node internals (module loader, streams, bootstrap) | 37.8 |
| zod (loaded by the MCP SDK) | 24.4 |
| `(program)` (compilation and native work) | 15.9 |
| Bundle top-level code | 10.5 |
| Garbage collector | 4.0 |
| ajv | 3.9 |
| fast-uri, MCP SDK, json-schema-traverse, jsonc-parser | 3.6 |
| CoAgent8 `src/` modules | about 2 |

Ceiling experiment (Appendix B, `ceiling/`): minimal servers with the same
nine-tool payload shape, built with esbuild `minify`, Windows, Node 24.21.0,
30 runs:

| Server | Size (B) | warm median (IQR) | fresh median (IQR) |
| --- | --- | --- | --- |
| CoAgent8 (esbuild) | 493084 | 133.6 (128.6-141.5) | 435.3 (430.1-465.9) |
| SDK `Server` + `StdioServerTransport` only | 292268 | 119.8 (112.7-128.4) | 318.1 (312.9-339.4) |
| same, without constructing Ajv (`jsonSchemaValidator` stub) | 292268 | 117.8 (111.1-123.6) | 316.5 (310.6-331.6) |
| No SDK (`ceiling-raw`) | 918 | 67.5 (63.6-72.7) | 67.1 (65.7-71.6) |

On a warm start the SDK costs about 52 ms and CoAgent8's own code about 14 ms.
CoAgent8 uses only the SDK's low-level `Server`, `StdioServerTransport` and
request schemas. It validates tool arguments with its own validator. The SDK
builds hundreds of zod schemas at import time, including some for features
CoAgent8 does not use. Skipping Ajv construction saves about 2 ms, within noise.
In VS Code the adopted build spends 57 ms (warm) and 118 ms (fresh) above the
no-SDK floor. How that splits between the SDK and CoAgent8's code under tsdown
was not measured.

## 7. Reproducibility

Both bundlers produce a byte-reproducible bundle in every case tested. The
source map is not reproducible across line endings, with either bundler.

| Case | esbuild bundle | tsdown bundle | Source map |
| --- | --- | --- | --- |
| 11 consecutive builds | 1 hash | 1 hash | 1 hash each |
| Separate directory with its own `npm ci` | same | same | same |
| Sources converted from CRLF to LF (58 files) | same | same | **differs**, both bundlers |
| Node 24.21.0 vs 26.10.0 (adopted build) | - | same (`66690a03...`) | - |

`sourcesContent` embeds the sources with the checkout's line endings (Windows
`core.autocrlf=true` gives CRLF). The esbuild map also embedded the whole
`package.json`, because `src/constants.ts` imports its `version`. The
`PACKAGE-001` entry in the roadmap is updated: a reproducible map needs an LF
policy or a map without `sourcesContent`.

## 8. License notices

The bundle inlines nine third-party packages: `@modelcontextprotocol/sdk`,
`ajv`, `ajv-formats`, `fast-deep-equal`, `json-schema-traverse`, `jsonc-parser`
and `zod` (MIT), and `fast-uri` and `smol-toml` (BSD-3-Clause). Both licenses
require the copyright notice to accompany copies, and BSD-3-Clause clause 2
covers binary redistribution explicitly. The previous esbuild bundle kept only
smol-toml's header, and no file carried the other eight notices. rolldown would
have copied smol-toml's header nine times.

The adopted build removes every comment from the bundle. Instead, a rolldown
plugin collects the packages whose modules reach the output
(`renderedLength > 0`) and writes their `package.json` license field and
license file to `dist/THIRD_PARTY_NOTICES.txt`. The file ships in the npm
package and the VSIX. The build fails if a bundled package has no license
file.

## 9. Round 1 (superseded) and what changed

Round 1 measured only warm start-up, from the repository and from the installed
tarball, against Node's compile cache as a control. Three sessions of 40 runs:
tsdown 7-13% faster to `initialize`; esbuild with a warm `NODE_COMPILE_CACHE`
9-12% faster; a cold cache 3-5% slower. Tool calls and `tools/list` were
unchanged, RSS 1.8 MiB lower with tsdown, and there was no difference between
repository and tarball. Against the brief's warm-start criteria, tsdown did not
qualify, and round 1 recommended staying on esbuild.

The owner judged that incomplete: the first launch matters most, a real host
must be measured, and 50-100 ms matters at scale. Round 2 added fresh-file
launches, VS Code, Linux, Node 26 and the Defender analysis. The compile cache
does not help a first launch, because a cold cache is slower than none.

## 10. Decision

| Criterion (brief) | Result |
| --- | --- |
| Median cold start to `initialize` improves at least 10%, outside the spread, on Windows | Met for a first launch of a newly written file: -58% (Node 24), -56% (Node 26), -55% in VS Code; intervals far from 10%. Warm start: -8% (Node 24), -3% (Node 26), -9% in VS Code. |
| No other metric gets worse in a way that matters | Met: tool calls and RSS unchanged or better, gzip size 9% smaller, raw size equal. Build is about 200 ms slower, and the dev tooling needs Node 24.11. |
| The compile-cache control does not deliver the same gain | Met for the first launch: a cold compile cache is 3-5% slower than none. |

**Adopted:** tsdown 0.23.0 for `dist/index.cjs`, with no comments in the bundle
and `dist/THIRD_PARTY_NOTICES.txt` beside it. The VS Code extension entry stays
on esbuild, because it is not on the server start-up path. The runtime minimum
stays Node 24.0, and the build needs Node 24.11 (`devEngines`), as recorded in
`.agents/rules/05-cross-platform.md`.

**Next, separate branch:** measure a thin, in-house MCP protocol layer that
replaces the SDK runtime (Section 6). The SDK would stay as a dev dependency so
that conformance tests can drive the server with the official SDK client. The
estimated gain is 40-50 ms warm and 80-110 ms on a fresh launch in VS Code. Both
figures are estimates from the ceiling experiment and must be measured on a
prototype before any decision.

## 11. Reproduction

Windows, from the repository root, branch `perf/tsdown-bundle-comparison`.
Scripts are in Appendix B. Save them under `.artifacts/bundler/`, which
`.gitignore` excludes. JSON plans list `{ name, file }` variants with absolute
paths.

```bash
# Candidates (tsdown in a scratch tool directory so package.json is untouched)
(mkdir -p .artifacts/bundler/tsdown-tool && cd .artifacts/bundler/tsdown-tool && npm init --yes && npm install --save-exact tsdown@0.23.0)
node .artifacts/bundler/candidates.cjs

# Synthetic start-up, Windows (Node 24 and 26), warm and fresh
node .artifacts/bundler/startbench.cjs .artifacts/bundler/m-win24-warm.json   # {"mode":"warm","runs":40,"warmup":5,...}
node .artifacts/bundler/startbench.cjs .artifacts/bundler/m-win24-fresh.json  # {"mode":"fresh","runs":40,"warmup":0,...}
#   add "node": "C:/Dev/scoop/apps/nodejs/current/node.exe" for Node 26

# Linux
for nv in 24 26; do MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -v "$(pwd -W)/.artifacts/bundler/linux:/out" node:$nv-slim \
  bash -c "mkdir -p /w/cand /w/ceiling/out && cp -r /repo/.artifacts/bundler/cand/* /w/cand/ && cp /repo/.artifacts/bundler/ceiling/out/raw.cjs /w/ceiling/out/ && for m in warm fresh; do node /repo/.artifacts/bundler/startbench.cjs /out/plan-\$m.json; done"; done

# VS Code (opens one isolated window; leave it in the foreground until it closes itself)
node .artifacts/bundler/vscode-bench/launch.cjs .artifacts/bundler/vscode-bench/plan-full.json  # {"modes":["fresh","warm"],"runs":20,"warmup":2,...}

# Defender
node .artifacts/bundler/open-probe.cjs 20 <bundle>...
node .artifacts/bundler/write-modes.cjs .artifacts/bundler/cand/es-mangle/index.cjs 8
node .artifacts/bundler/write-delay.cjs .artifacts/bundler/cand/es-mangle/index.cjs 6
node .artifacts/bundler/copy-delay.cjs .artifacts/bundler/cand/es-mangle/index.cjs 5   # write-delay.cjs with fs.copyFileSync

# Profile and SDK ceiling
node .artifacts/bundler/profile.cjs <unminified bundle> .artifacts/bundler/prof   # three times
node .artifacts/bundler/prof-analyze.cjs <unminified bundle> .artifacts/bundler/prof
#   build ceiling/sdk.ts and ceiling/raw.ts with esbuild (bundle, cjs, node24, minify, legalComments none),
#   then startbench with CEILING_NO_AJV=1 in the env of the "noajv" variant

# Adopted build and gates
npm run typecheck && npm run build && npm test && npm pack --dry-run && npm run test:consumer && npm run build:vscode
```

## Appendix A: adopted build

The adopted build is `scripts/build.cjs` in this repository (commit `5ab841f`).

## Appendix B: measurement scripts

Scratch tooling under `.artifacts/bundler/`, not committed as runtime files. `copy-delay.cjs` is `write-delay.cjs` with `fs.copyFileSync(src, f)` in place of `fs.writeFileSync(f, data)`.

### .artifacts/bundler/candidates.cjs

```js
// Builds every candidate bundle (no legal comments) into .artifacts/bundler/cand/<name>/index.cjs. Scratch tooling.
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isBuiltin } = require('node:module');
const esbuild = require('esbuild');
const out = name => path.join(__dirname, 'cand', name);
const es = { entryPoints: ['src/index.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', sourcemap: true,
  keepNames: true, legalComments: 'none', logLevel: 'warning', mainFields: ['module', 'main'] };
const esbuildVariants = {
  'es-mangle': { minify: true },
  'es-nomangle': { minifyWhitespace: true, minifySyntax: true },
};
const tdMinify = { 'td-mangle': true, 'td-nomangle': { compress: true, mangle: false, codegen: true } };
(async () => {
  for (const [name, o] of Object.entries(esbuildVariants)) {
    const { metafile } = await esbuild.build({ ...es, ...o, metafile: true, outfile: path.join(out(name), 'index.cjs') });
    const ext = Object.values(metafile.outputs).flatMap(x => x.imports).filter(i => i.external && !isBuiltin(i.path));
    if (ext.length) throw new Error(name + ' externals ' + ext.map(i => i.path));
  }
  const { build } = await import(pathToFileURL(path.join(__dirname, 'tsdown-tool/node_modules/tsdown/dist/index.mjs')).href);
  for (const [name, minify] of Object.entries(tdMinify)) {
    const externals = [];
    await build({ config: false, entry: { index: 'src/index.ts' }, outDir: out(name), clean: false,
      format: 'cjs', platform: 'node', target: 'node24', fixedExtension: true, hash: false, sourcemap: true, minify,
      dts: false, report: false, logLevel: 'warn', checks: { legacyCjs: false }, deps: { alwaysBundle: [/.*/], onlyBundle: false },
      inputOptions: { resolve: { mainFields: ['module', 'main'] } },
      outputOptions: { keepNames: true, comments: { legal: false, annotation: false, jsdoc: false } },
      plugins: [{ name: 'externals', generateBundle(_o, bundle) { for (const c of Object.values(bundle)) if (c.type === 'chunk') externals.push(...[...c.imports, ...c.dynamicImports].filter(i => !isBuiltin(i))); } }] });
    if (externals.length) throw new Error(name + ' externals ' + externals);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
```

### .artifacts/bundler/startbench.cjs

```js
// Generic MCP start-up benchmark. Scratch tooling, not committed as runtime code.
// Usage: node startbench.cjs <config.json>
// config: { node?: path, runs, warmup, mode: 'warm'|'fresh', out, variants: [{ name, file, env? }] }
// warm:  the same file every run (OS file cache and antivirus verdict already warm after warm-up).
// fresh: a newly written copy of the file before every run, so the run includes the on-access scan of a new file.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const nodeBin = config.node || process.execPath;
const hermetic = (() => {
  try { return require('../../tests/helpers/environment.cjs').createTestEnvironment(); } catch { return null; }
})();
const baseEnv = { ...(hermetic ? hermetic.env : process.env) };
delete baseEnv.NODE_COMPILE_CACHE; delete baseEnv.NODE_OPTIONS;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-startbench-'));

function target(variant, run) {
  if (config.mode !== 'fresh') return variant.file;
  const dir = path.join(scratch, `${variant.name.replace(/[^\w.-]/g, '_')}-${run}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, path.basename(variant.file));
  fs.copyFileSync(variant.file, file);
  return file;
}

function runOnce(variant, run) {
  const entry = target(variant, run);
  const env = { ...baseEnv, ...(variant.env || {}) };
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const proc = spawn(nodeBin, [entry], { cwd: path.dirname(entry), env, stdio: 'pipe', windowsHide: true });
    let buffer = '', stderr = '', tInit, tList;
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`timeout ${variant.name}: ${stderr}`)); }, 30000);
    const send = m => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdout.on('data', chunk => {
      buffer += chunk; let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === 1) { tInit = ms(); send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} }); }
        else if (m.id === 2) { tList = ms(); if (!Array.isArray(m.result?.tools) || !m.result.tools.length) reject(new Error('bad tools/list')); proc.stdin.end(); }
      }
    });
    proc.once('error', reject);
    proc.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || tList === undefined) return reject(new Error(`${variant.name} exit ${code}: ${stderr}`));
      resolve({ initMs: tInit, listTotalMs: tList });
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startbench', version: '1' } } });
  });
}

const quantile = (s, q) => { const p = (s.length - 1) * q, lo = Math.floor(p); return s[lo] + (s[Math.ceil(p)] - s[lo]) * (p - lo); };
const summarize = a => { const s = [...a].sort((x, y) => x - y); return { n: s.length, median: quantile(s, .5), p25: quantile(s, .25), p75: quantile(s, .75), p95: quantile(s, .95), min: s[0], max: s.at(-1) }; };
function bootstrapRatio(c, b, it = 5000) {
  let seed = 42; const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const med = a => quantile([...a].sort((x, y) => x - y), .5), res = a => a.map(() => a[Math.floor(rand() * a.length)]);
  const r = []; for (let i = 0; i < it; i++) r.push(med(res(c)) / med(res(b))); r.sort((x, y) => x - y);
  return { ratio: med(c) / med(b), ci95: [quantile(r, .025), quantile(r, .975)] };
}

(async () => {
  const vs = config.variants, results = Object.fromEntries(vs.map(v => [v.name, []]));
  let run = 0;
  for (let i = 0; i < (config.warmup ?? 0); i++) for (const v of vs) await runOnce(v, run++);
  for (let i = 0; i < config.runs; i++) {
    for (let k = 0; k < vs.length; k++) { const v = vs[(k + i) % vs.length]; results[v.name].push(await runOnce(v, run++)); }
  }
  const base = results[vs[0].name].map(r => r.initMs);
  const summary = Object.fromEntries(Object.entries(results).map(([n, r]) => [n, {
    sizeBytes: fs.statSync(vs.find(v => v.name === n).file).size,
    initMs: summarize(r.map(x => x.initMs)), listTotalMs: summarize(r.map(x => x.listTotalMs)),
    vsFirst: bootstrapRatio(r.map(x => x.initMs), base),
  }]));
  const meta = { node: nodeBin, platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, mode: config.mode, runs: config.runs, warmup: config.warmup ?? 0, date: new Date().toISOString() };
  if (config.out) fs.writeFileSync(config.out, JSON.stringify({ meta, summary, results }, null, 2));
  const f = x => x.toFixed(1);
  console.log(`# ${meta.platform} ${meta.release} node=${path.basename(path.dirname(nodeBin))} mode=${meta.mode} runs=${meta.runs}`);
  for (const [n, s] of Object.entries(summary)) console.log(`${n.padEnd(26)} ${String(s.sizeBytes).padStart(7)} B  init med ${f(s.initMs.median)} p95 ${f(s.initMs.p95)} IQR ${f(s.initMs.p25)}-${f(s.initMs.p75)} | list total med ${f(s.listTotalMs.median)} | vs ${vs[0].name} ${s.vsFirst.ratio.toFixed(3)} (${s.vsFirst.ci95.map(x => x.toFixed(3)).join('-')})`);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  if (hermetic) fs.rmSync(hermetic.root, { recursive: true, force: true, maxRetries: 5 });
})().catch(e => { console.error(e); process.exitCode = 1; });
```

### .artifacts/bundler/vscode-bench/ext/package.json

```json
{
  "name": "coagent8-startup-bench",
  "displayName": "CoAgent8 start-up bench (scratch)",
  "version": "0.0.1",
  "publisher": "local",
  "engines": { "vscode": "^1.101.0" },
  "main": "./extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": { "mcpServerDefinitionProviders": [{ "id": "bench", "label": "Bench" }] }
}
```

### .artifacts/bundler/vscode-bench/ext/extension.js

```js
// Measures MCP server start-up as VS Code sees it: from workbench.mcp.startServer to live tools.
// Reads bench-config.json next to this file, writes results, then quits VS Code. Scratch tooling.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.activate = async context => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-config.json'), 'utf8'));
  const log = m => fs.appendFileSync(cfg.progress, `${new Date().toISOString()} ${m}\n`);
  const emitter = new vscode.EventEmitter();
  let current = null;
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('bench', {
    onDidChangeMcpServerDefinitions: emitter.event,
    provideMcpServerDefinitions: () => current ? [new vscode.McpStdioServerDefinition(current.label, cfg.node, [current.file], cfg.env, '1.0.0')] : [],
    resolveMcpServerDefinition: server => { if (current) current.resolvedAt = performance.now(); return server; },
  }));
  const results = [];
  try {
    await sleep(cfg.settleMs);
    let run = 0;
    const plan = [];
    for (const mode of cfg.modes) {
      for (let i = -cfg.warmup; i < cfg.runs; i++) {
        for (let k = 0; k < cfg.variants.length; k++) plan.push({ mode, i, v: cfg.variants[(k + Math.max(i, 0)) % cfg.variants.length] });
      }
    }
    for (const { mode, i, v } of plan) {
      run++;
      let file = v.file;
      if (mode === 'fresh') {
        const dir = path.join(cfg.scratch, `${v.name}-${run}`);
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, 'index.cjs');
        fs.copyFileSync(v.file, file);
      }
      current = { label: `bench-${v.name}-${run}`, file };
      emitter.fire();
      await sleep(cfg.gapMs);
      const before = new Set(vscode.lm.tools.map(t => t.name));
      const t0 = performance.now();
      await vscode.commands.executeCommand('workbench.mcp.startServer', '*', { waitForLiveTools: true, autoTrustChanges: true });
      const t1 = performance.now();
      const added = vscode.lm.tools.filter(t => !before.has(t.name)).length;
      const r = { mode, variant: v.name, run, warmup: i < 0, startToLiveToolsMs: t1 - t0, startToSpawnMs: current.resolvedAt ? current.resolvedAt - t0 : null, newTools: added };
      results.push(r);
      log(JSON.stringify(r));
      current = null;
      emitter.fire();
      await sleep(cfg.gapMs);
    }
  } catch (error) {
    log('ERROR ' + (error && error.stack || error));
  } finally {
    fs.writeFileSync(cfg.out, JSON.stringify({ meta: { vscode: vscode.version, date: new Date().toISOString() }, results }, null, 2));
    await sleep(500);
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
exports.deactivate = () => {};
```

### .artifacts/bundler/vscode-bench/launch.cjs

```js
// Launches an isolated VS Code instance with the bench extension and waits for its results. Scratch tooling.
// Usage: node launch.cjs <plan.json>   plan: { modes, runs, warmup, variants: [{name, file}], out }
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createTestEnvironment } = require('../../../tests/helpers/environment.cjs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-vscode-bench-'));
const dirs = Object.fromEntries(['ud', 'ext', 'ws', 'scratch'].map(d => [d, path.join(root, d)]));
Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
const { env, root: envRoot } = createTestEnvironment();
// Settings for the isolated profile: no workspace trust prompt, no telemetry, no update checks.
fs.mkdirSync(path.join(dirs.ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(dirs.ud, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none', 'chat.mcp.autostart': 'never' }, null, 2));
const ext = path.join(__dirname, 'ext');
const out = path.resolve(plan.out), progress = out + '.progress.log';
fs.rmSync(out, { force: true }); fs.rmSync(progress, { force: true });
fs.writeFileSync(path.join(ext, 'bench-config.json'), JSON.stringify({
  node: plan.node || process.execPath, env: Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')),
  modes: plan.modes, runs: plan.runs, warmup: plan.warmup, variants: plan.variants, scratch: dirs.scratch,
  settleMs: plan.settleMs ?? 8000, gapMs: plan.gapMs ?? 1500, out, progress,
}, null, 2));
const codeExe = plan.codeExe || 'C:/Program Files/Microsoft VS Code/Code.exe';
const args = ['--user-data-dir', dirs.ud, '--extensions-dir', dirs.ext, '--extensionDevelopmentPath=' + ext, '--disable-extensions',
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', dirs.ws];
const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE; delete childEnv.VSCODE_IPC_HOOK_CLI;
for (const k of Object.keys(childEnv)) if (k.startsWith('VSCODE_')) delete childEnv[k];
const t0 = Date.now();
const proc = spawn(codeExe, args, { env: childEnv, stdio: 'ignore', detached: false });
const timer = setInterval(() => {
  if (fs.existsSync(out)) { clearInterval(timer); finish(); }
  else if (Date.now() - t0 > (plan.timeoutMs ?? 1800000)) { clearInterval(timer); console.error('timeout'); finish(); }
}, 1000);
function finish() {
  setTimeout(() => {
    // Collect VS Code's own MCP server logs for the timestamp cross-check before removing the profile.
    const logs = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/mcpServer.*bench/i.test(e.name)) logs.push(p); } };
    try { walk(path.join(dirs.ud, 'logs')); } catch {}
    const logDir = out + '.mcplogs'; fs.rmSync(logDir, { recursive: true, force: true }); fs.mkdirSync(logDir);
    for (const l of logs) fs.copyFileSync(l, path.join(logDir, path.basename(l)));
    console.log(fs.existsSync(out) ? fs.readFileSync(progress, 'utf8') : 'no results');
    try { proc.kill(); } catch {}
    setTimeout(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      fs.rmSync(envRoot, { recursive: true, force: true, maxRetries: 5 });
    }, 3000);
  }, 4000);
}
```

### .artifacts/bundler/open-probe.cjs

```js
// Times the first open+read of a freshly written copy of each given file in a new hidden process, without executing it.
// Usage: node open-probe.cjs RUNS file...   (labels are the parent directory names)
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const RUNS = Number(process.argv[2]);
const files = process.argv.slice(3).map(f => path.resolve(f));
const label = f => path.basename(path.dirname(f)) === 'dist' ? path.basename(path.dirname(path.dirname(f))) : path.basename(path.dirname(f));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-open-probe-'));
const probe = 'const t=process.hrtime.bigint();require("fs").readFileSync(process.argv[1]);process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6))';
const out = new Map(files.map(f => [f, { first: [], reopen: [] }]));
for (let i = 0; i < RUNS; i++) for (let k = 0; k < files.length; k++) {
  const f = files[(k + i) % files.length];
  const file = path.join(fs.mkdtempSync(path.join(root, 'x-')), 'index.cjs');
  fs.copyFileSync(f, file);
  const read = () => Number(spawnSync(process.execPath, ['-e', probe, file], { encoding: 'utf8', windowsHide: true }).stdout);
  out.get(f).first.push(read()); out.get(f).reopen.push(read());
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
for (const [f, r] of out) console.log(label(f).padEnd(20), String(fs.statSync(f).size).padStart(8), 'B  first-open median', q(r.first, .5).toFixed(1), 'p95', q(r.first, .95).toFixed(1), 'IQR', q(r.first, .25).toFixed(1) + '-' + q(r.first, .75).toFixed(1), '| reopen median', q(r.reopen, .5).toFixed(1));
fs.rmSync(root, { recursive: true, force: true });
```

### .artifacts/bundler/write-modes.cjs

```js
// Which write path defers Defender's scan to the first open? Times the write and the first open per mode. Scratch tooling.
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const src = process.argv[2], RUNS = Number(process.argv[3] || 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-writemodes-'));
const probe = 'const t=process.hrtime.bigint();require("fs").readFileSync(process.argv[1]);process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6))';
const data = fs.readFileSync(src);
const modes = {
  copyFileSync: f => fs.copyFileSync(src, f),
  writeFileSync: f => fs.writeFileSync(f, data),
  streamChunks: f => { const fd = fs.openSync(f, 'w'); for (let i = 0; i < data.length; i += 65536) fs.writeSync(fd, data, i, Math.min(65536, data.length - i)); fs.closeSync(fd); },
};
const res = Object.fromEntries(Object.keys(modes).map(m => [m, { write: [], open: [] }]));
for (let i = 0; i < RUNS; i++) for (const [m, w] of Object.entries(modes)) {
  const f = path.join(fs.mkdtempSync(path.join(root, m + '-')), 'index.cjs');
  const t = process.hrtime.bigint(); w(f); res[m].write.push(Number(process.hrtime.bigint() - t) / 1e6);
  res[m].open.push(Number(spawnSync(process.execPath, ['-e', probe, f], { encoding: 'utf8', windowsHide: true }).stdout));
}
const med = a => { const s = [...a].sort((x, y) => x - y); return ((s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2).toFixed(1); };
for (const [m, r] of Object.entries(res)) console.log(path.basename(path.dirname(src)).padEnd(12), m.padEnd(14), 'write median', med(r.write).padStart(6), 'ms | first open median', med(r.open).padStart(6), 'ms');
fs.rmSync(root, { recursive: true, force: true });
```

### .artifacts/bundler/write-delay.cjs

```js
// First-open time as a function of the delay between writing a file and opening it. Scratch tooling.
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const [src, runsArg] = process.argv.slice(2); const RUNS = Number(runsArg || 6);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-writedelay-'));
const probe = 'const t=process.hrtime.bigint();require("fs").readFileSync(process.argv[1]);process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6))';
const data = fs.readFileSync(src);
const delays = [0, 250, 500, 1000, 2000, 5000];
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const res = Object.fromEntries(delays.map(d => [d, []]));
  for (let i = 0; i < RUNS; i++) for (const d of delays) {
    const f = path.join(fs.mkdtempSync(path.join(root, 'd-')), 'index.cjs');
    fs.writeFileSync(f, data); await sleep(d);
    res[d].push(Number(spawnSync(process.execPath, ['-e', probe, f], { encoding: 'utf8', windowsHide: true }).stdout));
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return ((s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2).toFixed(1); };
  console.log(path.basename(path.dirname(src)).padEnd(12), delays.map(d => `${d}ms->${med(res[d])}`).join('  '));
  fs.rmSync(root, { recursive: true, force: true });
})();
```

### .artifacts/bundler/profile.cjs

```js
// CPU profile of one server start-up through initialize and tools/list. Usage: node profile.cjs <bundle> <outdir>
const { spawn } = require('node:child_process'); const path = require('node:path');
const { createTestEnvironment } = require('../../tests/helpers/environment.cjs');
const { env, root } = createTestEnvironment();
const [bundle, out] = process.argv.slice(2);
const p = spawn(process.execPath, ['--cpu-prof', '--cpu-prof-interval', '100', '--cpu-prof-dir', path.resolve(out), bundle], { env, stdio: 'pipe', windowsHide: true });
let buf = '';
p.stdout.on('data', d => { buf += d; if (buf.includes('"id":1') && !buf.includes('"id":2')) { p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n'); } if (buf.includes('"id":2')) p.stdin.end(); });
p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"prof","version":"1"}}}\n');
p.on('exit', c => { console.log('exit', c); require('fs').rmSync(root, { recursive: true, force: true }); });
```

### .artifacts/bundler/prof-analyze.cjs

```js
// Aggregates .cpuprofile self time by original module, using esbuild's "// path" module headers in an unminified bundle.
const fs = require('node:fs'), path = require('node:path');
const [bundle, dir] = process.argv.slice(2);
const lines = fs.readFileSync(bundle, 'utf8').split('\n');
const owner = []; let cur = '(bundle prelude)';
lines.forEach((l, i) => { const m = /^\/\/ ((?:node_modules|src)\/\S+)$/.exec(l); if (m) cur = m[1].replace(/^node_modules\//, 'nm/'); owner[i] = cur; });
const group = m => m.startsWith('nm/') ? m.split('/').slice(0, m.startsWith('nm/@') ? 3 : 2).join('/') : m;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.cpuprofile'));
const totals = {}; let all = 0;
for (const f of files) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, f)));
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  const dt = {}; p.samples.forEach((id, i) => { dt[id] = (dt[id] || 0) + (p.timeDeltas[i] || 0); });
  for (const [id, us] of Object.entries(dt)) {
    const n = byId.get(Number(id)), cf = n.callFrame; let key;
    if (cf.url && cf.url.endsWith(path.basename(bundle))) key = group(owner[cf.lineNumber] || '?');
    else if (cf.url.startsWith('node:')) key = 'node-internal:' + cf.url.slice(5).split('/')[0];
    else key = cf.functionName || cf.url || '(unknown)';
    totals[key] = (totals[key] || 0) + us / 1000; all += us / 1000;
  }
}
const n = files.length;
console.log('profiles', n, 'avg sampled ms', (all / n).toFixed(1));
Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log((v / n).toFixed(1).padStart(7), k));
```

### .artifacts/bundler/ceiling/tools.ts

```ts
// Nine representative tool definitions so every ceiling server returns the same tools/list payload.
export const tools = Array.from({ length: 9 }, (_, i) => ({
  name: `tool${i}`, description: 'Ceiling benchmark tool '.repeat(8),
  inputSchema: { type: 'object' as const, properties: { task: { type: 'string', description: 'x'.repeat(200) }, workspace_path: { type: 'string' } }, required: ['task'], additionalProperties: false },
}));
```

### .artifacts/bundler/ceiling/sdk.ts

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools';
const noAjv = process.env.CEILING_NO_AJV === '1';
const server = new Server({ name: 'ceiling', version: '1.0.0' }, { capabilities: { tools: {} },
  ...(noAjv ? { jsonSchemaValidator: { getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }) } } : {}) } as never);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
void server.connect(new StdioServerTransport());
process.stdin.once('end', () => process.exit(0));
```

### .artifacts/bundler/ceiling/raw.ts

```ts
// Minimal newline-delimited JSON-RPC MCP responder without the SDK, same payloads as sdk.ts.
import { tools } from './tools';
let buffer = '';
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk; let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ceiling', version: '1.0.0' } } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
    else if (m.id != null) send({ id: m.id, result: {} });
  }
});
process.stdin.once('end', () => process.exit(0));
```

### .artifacts/bundler/usage.cjs (round 1 tool-call latency)

```js
// Steady-state usage benchmark: tool-call latency inside a running server. Scratch tooling, not committed.
// Per process: initialize, initialized, CALLS x tools/call session{list} (no subprocess), then one consult turn
// against the Gemini test fixture CLI (a Node script from tests/fixtures, never a real backend).
// Usage: node .artifacts/bundler/usage.cjs [--procs N] [--calls N] [--variants a,b] [--out file.json]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createTestEnvironment } = require('../../tests/helpers/environment.cjs');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PROCS = Number(opt('--procs', 30));
const CALLS = Number(opt('--calls', 20));
const VARIANTS = opt('--variants', 'esbuild,tsdown,esbuild-noident').split(',');
const OUT = path.resolve(opt('--out', path.join(__dirname, 'usage.json')));
const installDir = v => fs.readFileSync(path.join(__dirname, 'pack', v, 'installdir.txt'), 'utf8').trim();

const { env, root: envRoot } = createTestEnvironment();
delete env.NODE_COMPILE_CACHE; delete env.NODE_OPTIONS;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-usage-ws-'));

function session(variant) {
  const dir = installDir(variant);
  const proc = spawn(process.execPath, [path.join(dir, 'node_modules', 'coagent8', 'dist', 'index.cjs')], { cwd: dir, env, stdio: 'pipe', windowsHide: true });
  const pending = new Map(); let buffer = '', next = 1, stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  proc.stdout.on('data', chunk => {
    buffer += chunk; let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++, t0 = process.hrtime.bigint();
    const timer = setTimeout(() => reject(new Error(`timeout ${method}: ${stderr}`)), 30000);
    pending.set(id, m => { clearTimeout(timer); resolve({ m, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = method => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { request, notify, close: async () => { proc.stdin.end(); const code = await exited; if (code !== 0) throw new Error(`exit ${code}: ${stderr}`); } };
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const summarize = a => ({ n: a.length, median: q(a, 0.5), p25: q(a, 0.25), p75: q(a, 0.75), p95: q(a, 0.95), min: Math.min(...a), max: Math.max(...a) });

(async () => {
  const results = Object.fromEntries(VARIANTS.map(v => [v, { sessionList: [], consult: [] }]));
  for (let i = -2; i < PROCS; i++) { // two discarded warm-up rounds
    for (let k = 0; k < VARIANTS.length; k++) {
      const v = VARIANTS[(k + Math.max(i, 0)) % VARIANTS.length];
      const s = session(v);
      await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'usage-bench', version: '1' } });
      s.notify('notifications/initialized');
      await s.request('tools/list', {});
      const lists = [];
      for (let c = 0; c < CALLS; c++) {
        const { m, ms } = await s.request('tools/call', { name: 'session', arguments: { action: 'list', workspace_path: workspace } });
        if (m.result?.isError) throw new Error(JSON.stringify(m));
        lists.push(ms);
      }
      const { m, ms } = await s.request('tools/call', { name: 'consult', arguments: { proposal: 'usage benchmark turn', backend: 'gemini', workspace_path: workspace } });
      if (m.result?.isError !== false) throw new Error(JSON.stringify(m).slice(0, 500));
      await s.close();
      if (i >= 0) { results[v].sessionList.push(q(lists, 0.5)); results[v].consult.push(ms); }
    }
  }
  const summary = Object.fromEntries(Object.entries(results).map(([v, r]) => [v, { sessionListMedianPerProcessMs: summarize(r.sessionList), consultFixtureTurnMs: summarize(r.consult) }]));
  fs.writeFileSync(OUT, JSON.stringify({ meta: { node: process.version, procs: PROCS, calls: CALLS, date: new Date().toISOString() }, summary, results }, null, 2));
  const f = x => x.toFixed(2);
  for (const [v, s] of Object.entries(summary)) console.log(`${v.padEnd(16)} session list med ${f(s.sessionListMedianPerProcessMs.median)} p95 ${f(s.sessionListMedianPerProcessMs.p95)} IQR ${f(s.sessionListMedianPerProcessMs.p25)}-${f(s.sessionListMedianPerProcessMs.p75)} | consult(fixture) med ${f(s.consultFixtureTurnMs.median)} p95 ${f(s.consultFixtureTurnMs.p95)} IQR ${f(s.consultFixtureTurnMs.p25)}-${f(s.consultFixtureTurnMs.p75)}`);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  fs.rmSync(envRoot, { recursive: true, force: true, maxRetries: 5 });
})().catch(error => { console.error(error); process.exitCode = 1; });
```
