# Bundler Comparison: esbuild vs tsdown for the MCP Server

Date: 2026-10-06. Branch: `perf/tsdown-bundle-comparison`, based on
`fix/hermetic-test-environment` (`076b59d`). Candidates: esbuild 0.25.12 (current
`scripts/build.cjs`) and tsdown 0.23.0 (rolldown 1.2.12).

**Question.** Does building the MCP server with tsdown make the server noticeably
faster for a user (start-up and use as a host sees them), and is the gain worth a
new dev dependency?

**Answer.** No. Keep esbuild and do not add tsdown. tsdown starts the server 7-13%
faster to `initialize` with warm files, but this is below the 10% adoption bar in
two of three sessions on the installed tarball. Node's compile cache alone gives
the same gain (9-12%) with esbuild. Tool calls in a running server are unchanged.
The one large difference in this report does not come from the bundler: Microsoft
Defender scans esbuild's mangled identifiers slowly on the first open of a newly
written bundle. esbuild with `minifyIdentifiers: false` removes most of that delay
without a new dependency (section 5).

## 1. Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 Pro 10.0.26200 (build 26200) |
| CPU | AMD Ryzen 5 7235HS, 8 logical cores |
| Memory | 31.7 GiB |
| Power | AC power (battery status 2, 95%), Windows power plan "Balanced" |
| Node.js | 24.21.0 (Scoop `nodejs-lts`) |
| npm | bundled with Node 24.21.0 |
| Antivirus | Microsoft Defender, real-time and on-access protection on; engine 4.18.26080.4, signatures 1.459.576.0 |
| esbuild | 0.25.12 |
| tsdown / rolldown | 0.23.0 / 1.2.12 |
| Linux | **Not measured.** The only Linux on this machine is Docker Desktop's WSL distribution. It is stopped, and starting it opens the Docker Desktop window, which the no-window requirement forbids. |
| Node 26 | **Not measured.** It is not installed on this machine. |

Every process the benchmarks spawned used `windowsHide: true`. The server ran in
the hermetic test environment from `tests/helpers/environment.cjs`: disposable
profile directories, backend CLI paths pointing at `tests/fixtures`, and `PATH`
reduced to Node, Git and the OS. No real backend CLI was started. The handshake
(`initialize`, `notifications/initialized`, `tools/list`) calls no backend.

## 2. tsdown variant and equivalence

The variant used tsdown's programmatic `build()` API with options checked against
the installed type declarations (`tsdown/dist/types-*.d.mts`, rolldown
`define-config-*.d.mts`). The script is reproduced in Appendix A.

| Requirement | tsdown 0.23.0 setting |
| --- | --- |
| One self-contained `dist/index.cjs` | `entry: { index: 'src/index.ts' }`, `format: 'cjs'`, `fixedExtension: true`, `hash: false`, `clean: false` |
| Inline every dependency | `deps: { alwaysBundle: [/.*/], onlyBundle: false }`. By default tsdown externalizes `dependencies`. |
| Node 24, minified, source map | `platform: 'node'`, `target: 'node24'`, `minify: true`, `sourcemap: true` |
| Keep names | `outputOptions: { keepNames: true }` (rolldown `OutputOptions.keepNames`) |
| Same resolution as esbuild | `inputOptions: { resolve: { mainFields: ['module', 'main'] } }` |
| No declarations | `dts: false` |
| Branding, chmod | `prepareBranding()` before the build, `chmodSync(0o755)` after it |
| No non-builtin external imports | rolldown plugin on `generateBundle` that rejects any chunk import or dynamic import for which `isBuiltin()` is false |

The external-import check was tested negatively. When the `deps` override is
removed, the build fails with `Bundle requires external packages:
@modelcontextprotocol/sdk/server/stdio.js, ..., smol-toml, jsonc-parser`.

Gate results with `npm run build` temporarily pointing at the tsdown script
(Windows, Node 24.21.0):

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` (`tests/run.cjs`) | PASS: 199 tests, 197 pass, 0 fail, 2 skipped, 42.7 s |
| `npm pack --dry-run` | PASS: 71 files, `dist/index.cjs` 515.4 kB |
| `npm run test:consumer` | PASS: bundled SDK, both bin aliases, initialize/list, Codex and Gemini fixture turns and history, EOF |

The `require("ajv/dist/runtime/...")` strings in both bundles are code-generation
string literals inside ajv. They are not module imports, and they are identical in
both outputs.

## 3. Method

- **Bundles.** esbuild: the current `npm run build`. Its output is byte-identical
  to the committed `dist/index.cjs` (`b299ce68...`). tsdown: Appendix A
  (`af2cc77c...`). esbuild-noident: esbuild with
  `minify: false, minifyWhitespace: true, minifySyntax: true` (`669272c8...`).
  This variant is a diagnostic; it is not proposed in this branch (section 5).
- **Locations.** *repo*: copies of each `dist/` under `.artifacts/bundler/repo/`
  with `cwd` set to the repository. *tarball*: `npm pack` of each variant,
  installed with `npm install --omit=dev` into its own directory under `%TEMP%`,
  and run from `node_modules/coagent8/dist/index.cjs`. The esbuild-noident install
  is a copy of the esbuild install with only `dist/` replaced.
- **Start-up runs.** One process per run. The `initialize` request is written
  right after `spawn`. The clock starts before `spawn` and stops when the
  `initialize` response line arrives. Then the client sends `initialized` and
  `tools/list`, and the clock measures from sending `tools/list` to its response.
  RSS is the Windows working set from a hidden `tasklist` call taken after
  `tools/list` (Node also reports the working set as RSS on Windows). Variants
  run round-robin with a rotating start (A, B, C, ... then B, C, ..., A).
  Five warm-up rounds are discarded, then 40 rounds are measured per variant and
  location. Warm-up also primes the OS file cache, so "cold start" means a new
  process with warm files.
- **Compile cache.** Set through `NODE_COMPILE_CACHE`. *cold*: a new empty
  directory for every run. *warm*: one persistent directory per bundle and
  location, primed by the warm-up runs. After each run the cache directory held
  one file, so the cache is written on the server's `process.exit(0)` path.
- **Fresh file.** Before each run the installed bundle is copied to a new
  directory. No warm-up. 30 runs per variant.
- **Comparison.** The ratio of median `initialize` time to esbuild's in the same
  session, with a 95% percentile-bootstrap interval (5000 resamples).
- **Sessions.** Three independent start-up sessions, run at different times.

## 4. Results

### 4.1 Start-up to `initialize`, `tools/list` and RSS

Times are in milliseconds and RSS in MiB. "list" is the time from sending
`tools/list` to its response. "total" is the time from `spawn` to the `tools/list`
response. Ratio is median `initialize` relative to esbuild in the same session and
location.

Session 1 (40 runs, 5 warm-up)

| Location / variant | init median | init p95 | init IQR | init range | list median | list p95 | total median | RSS median | ratio (95% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| repo / esbuild | 125.7 | 152.7 | 123.3-134.5 | 118.4-211.2 | 3.3 | 5.0 | 129.6 | 60.0 | 1 |
| repo / tsdown | 117.4 | 139.6 | 114.0-120.4 | 109.6-272.9 | 3.2 | 4.3 | 120.5 | 58.2 | 0.934 (0.899-0.957) |
| repo / esbuild + cache cold | 132.3 | 174.4 | 128.1-138.5 | 124.2-217.7 | 3.2 | 4.5 | 136.4 | 60.3 | 1.053 (1.019-1.083) |
| repo / esbuild + cache warm | 114.4 | 139.1 | 111.2-122.6 | 107.0-262.2 | 3.3 | 4.7 | 118.8 | 60.5 | 0.910 (0.884-0.939) |
| repo / tsdown + cache warm | 103.7 | 116.1 | 101.2-109.3 | 94.2-125.7 | 3.4 | 4.6 | 107.1 | 58.6 | 0.825 (0.800-0.852) |
| tarball / esbuild | 125.0 | 147.5 | 122.7-129.9 | 118.1-277.8 | 3.2 | 4.3 | 128.1 | 60.0 | 1 |
| tarball / tsdown | 113.8 | 131.8 | 112.2-117.1 | 108.1-215.3 | 3.1 | 3.8 | 117.0 | 58.2 | 0.911 (0.897-0.926) |
| tarball / esbuild + cache cold | 129.4 | 149.9 | 125.9-132.3 | 122.4-153.1 | 3.2 | 4.6 | 132.5 | 60.3 | 1.035 (1.016-1.051) |
| tarball / esbuild + cache warm | 113.4 | 129.0 | 111.5-118.3 | 108.2-183.8 | 3.1 | 4.7 | 116.5 | 60.6 | 0.907 (0.893-0.932) |
| tarball / tsdown + cache warm | 102.9 | 119.9 | 100.5-106.2 | 96.3-130.6 | 3.1 | 3.9 | 106.3 | 58.7 | 0.823 (0.809-0.836) |

Session 2 (40 runs, 5 warm-up)

| Location / variant | init median | init p95 | init IQR | init range | list median | list p95 | total median | RSS median | ratio (95% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| repo / esbuild | 126.3 | 139.1 | 124.3-129.6 | 120.7-188.4 | 3.2 | 4.1 | 129.8 | 59.9 | 1 |
| repo / tsdown | 114.5 | 133.4 | 112.2-120.8 | 106.1-142.0 | 3.2 | 4.1 | 117.8 | 58.1 | 0.907 (0.887-0.928) |
| repo / esbuild + cache cold | 130.5 | 151.8 | 126.8-139.4 | 122.4-283.6 | 3.3 | 3.8 | 133.9 | 60.3 | 1.034 (1.005-1.067) |
| repo / esbuild + cache warm | 114.6 | 130.9 | 111.9-119.8 | 108.4-145.1 | 3.1 | 5.6 | 117.8 | 60.5 | 0.908 (0.887-0.919) |
| repo / tsdown + cache warm | 103.4 | 119.0 | 100.4-109.5 | 96.6-123.8 | 3.4 | 4.7 | 106.8 | 58.7 | 0.818 (0.799-0.854) |
| tarball / esbuild | 125.8 | 171.5 | 122.5-132.9 | 118.4-195.3 | 3.1 | 4.5 | 129.5 | 60.0 | 1 |
| tarball / tsdown | 115.9 | 137.4 | 112.8-122.1 | 108.4-156.5 | 3.2 | 4.2 | 118.9 | 58.3 | 0.922 (0.888-0.957) |
| tarball / esbuild + cache cold | 129.4 | 142.0 | 124.8-136.9 | 118.8-149.2 | 3.2 | 4.1 | 132.4 | 60.4 | 1.029 (0.992-1.072) |
| tarball / esbuild + cache warm | 114.1 | 134.7 | 109.8-121.5 | 105.1-195.7 | 3.3 | 3.9 | 117.7 | 60.6 | 0.907 (0.871-0.939) |
| tarball / tsdown + cache warm | 103.8 | 131.4 | 100.2-109.1 | 95.8-153.5 | 3.2 | 5.0 | 106.9 | 58.8 | 0.826 (0.796-0.850) |

Session 3 (40 runs, 5 warm-up; adds esbuild-noident)

| Location / variant | init median | init p95 | init IQR | init range | list median | list p95 | total median | RSS median | ratio (95% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| repo / esbuild | 127.7 | 180.4 | 121.6-140.2 | 117.9-201.2 | 3.2 | 5.3 | 130.9 | 59.9 | 1 |
| repo / tsdown | 116.0 | 144.6 | 112.4-123.4 | 106.1-164.7 | 3.2 | 4.3 | 119.1 | 58.1 | 0.909 (0.872-0.958) |
| repo / esbuild-noident | 125.2 | 159.5 | 120.3-130.3 | 115.0-192.1 | 3.2 | 4.2 | 128.4 | 60.5 | 0.980 (0.933-1.021) |
| repo / esbuild + cache warm | 112.7 | 150.1 | 109.0-121.1 | 104.7-375.6 | 3.4 | 5.2 | 116.2 | 60.5 | 0.882 (0.842-0.917) |
| tarball / esbuild | 129.2 | 188.2 | 121.6-144.3 | 114.4-209.6 | 3.2 | 4.8 | 132.5 | 60.0 | 1 |
| tarball / tsdown | 112.4 | 152.1 | 108.0-123.5 | 104.0-249.2 | 3.3 | 4.1 | 115.7 | 58.2 | 0.870 (0.850-0.921) |
| tarball / esbuild-noident | 125.0 | 210.0 | 116.0-139.0 | 112.0-386.8 | 3.3 | 6.4 | 128.5 | 60.5 | 0.968 (0.913-1.042) |
| tarball / esbuild + cache warm | 114.1 | 174.2 | 110.4-123.2 | 103.1-277.3 | 3.3 | 5.6 | 117.7 | 60.6 | 0.883 (0.861-0.950) |

Floor for reference: an empty Node 24.21.0 process with piped stdin takes 63.5 ms
median (IQR 61.7-65.0, p95 69.0, 40 runs) to its first stdout byte. The server
therefore spends about 62 ms (esbuild) or 50-54 ms (tsdown) above the bare Node
start. This is computed from the medians above, not measured directly.

### 4.2 First launch of a newly written bundle

Each run starts a newly written copy of the installed bundle, so the run also
includes Defender's on-access scan of the new file. These numbers are not
comparable with section 4.1.

| Session / variant | init median | init p95 | init IQR | init range | RSS median | ratio (95% CI) |
| --- | --- | --- | --- | --- | --- | --- |
| A / esbuild | 442.8 | 606.6 | 415.5-516.3 | 407.6-717.1 | 60.0 | 1 |
| A / tsdown | 186.6 | 262.6 | 177.2-206.3 | 165.5-288.7 | 58.0 | 0.421 (0.388-0.453) |
| B / esbuild | 488.4 | 731.0 | 427.2-554.2 | 407.7-788.5 | 59.9 | 1 |
| B / tsdown | 203.8 | 251.6 | 191.0-221.6 | 172.7-269.0 | 58.1 | 0.417 (0.370-0.469) |
| B / esbuild-noident | 232.8 | 265.0 | 213.4-241.4 | 202.8-430.9 | 60.5 | 0.477 (0.424-0.527) |

Isolation: a hidden Node process that only opens and reads a newly written copy
of the bundle, with no JavaScript executed from it (Appendix B, `open-probe.cjs`).
20 runs per row, and every second read of the same file is shown as "reopen".

| Bundle | Size (B) | first-open median | p95 | IQR | reopen median |
| --- | --- | --- | --- | --- | --- |
| esbuild (current options) | 493084 | 303.5 | 400.3 | 297.1-306.3 | 3.3 |
| esbuild, `legalComments: 'none'` | 491142 | 303.6 | 418.7 | 295.2-361.5 | 3.3 |
| esbuild, `keepNames: false` | 469429 | 289.7 | 391.2 | 280.6-301.5 | 3.2 |
| esbuild, no minification | 1002635 | 108.7 | 136.1 | 106.1-118.1 | 3.4 |
| esbuild, whitespace only | 735756 | 86.9 | 121.0 | 84.4-108.0 | 3.5 |
| esbuild, whitespace + syntax (noident) | 709791 | 82.1 | 112.8 | 80.4-93.6 | 3.4 |
| tsdown | 515441 | 65.4 | 79.7 | 62.1-69.0 | 3.3 |

The difference is in the file read, before any JavaScript runs, and it disappears
when the same file is opened again. It follows identifier mangling: legal comments
and `keepNames` have no measurable effect, and turning off esbuild's identifier
minification alone removes about 220 ms. That Defender's scanner is the component
doing the work is an inference from on-access protection being on and from the
first-open/reopen pattern. Defender was not disabled to confirm it, and nothing
was measured for other antivirus products. How often Defender scans the same file
again (for example after a signature update) was not measured.

### 4.3 Tool use in a running server

Installed tarball, 30 processes per variant after 2 discarded rounds. Each
process ran 20 `tools/call session {action: "list"}` calls (local file system
only; the per-process median is taken) and one `consult` turn against the Gemini
test fixture CLI, a Node script from `tests/fixtures`.

| Variant | `session list` median | p95 | IQR | `consult` (fixture) median | p95 | IQR |
| --- | --- | --- | --- | --- | --- | --- |
| esbuild | 10.01 | 17.45 | 6.65-14.51 | 737.5 | 1348.3 | 588.3-1016.1 |
| tsdown | 10.34 | 16.62 | 6.86-13.43 | 784.8 | 1157.1 | 587.8-913.3 |
| esbuild-noident | 10.20 | 19.04 | 6.69-13.25 | 739.9 | 1196.6 | 595.6-930.4 |

The IQRs overlap almost completely. The `consult` time is dominated by starting
the fixture backend process.

### 4.4 Size

| Artifact | esbuild raw | esbuild gzip -9 | tsdown raw | tsdown gzip -9 | noident raw | noident gzip -9 |
| --- | --- | --- | --- | --- | --- | --- |
| `dist/index.cjs` | 493084 | 151237 | 515441 | 139595 | 709791 | 173107 |
| `dist/index.cjs.map` | 1888372 | 451615 | 1965247 | 455335 | 1745118 | 395382 |
| npm tarball (`npm pack`) | 729644 | - | 723191 | - | not packed | - |
| Unpacked package | 2822288 | - | 2921527 | - | not packed | - |

Of tsdown's extra 22357 bytes, 14310 come from legal comments. rolldown 1.2.12
copies the smol-toml BSD-3-Clause header inline nine times (once per source
module). esbuild keeps one deduplicated copy at the end of the file. rolldown only
offers `comments.legal` / `legalComments` `none` or `inline`. It has no
end-of-file or external mode.

### 4.5 Build time

Wall time of the whole `node scripts/<build>.cjs` process, including
`prepareBranding()`. Variants alternated, with one discarded warm-up each.

| Location | esbuild median (p95, range) | tsdown median (p95, range) | Runs |
| --- | --- | --- | --- |
| repository | 280 ms (377, 244-425) | 451 ms (488, 415-489) | 10 each |
| separate copy with its own `npm ci` | 275 ms (290, 257-292) | 429 ms (432, 425-432) | 2 each |

### 4.6 Reproducibility

Both bundles are byte-reproducible in every case tested. The source maps are not
reproducible across line-ending conventions, with either bundler.

| Case | esbuild `index.cjs` | esbuild map | tsdown `index.cjs` | tsdown map |
| --- | --- | --- | --- | --- |
| 11 consecutive builds, repository | 1 hash `b299ce685560` | 1 hash | 1 hash `af2cc77c4a0f` | 1 hash |
| Separate directory with its own `npm ci` (different absolute path) | `b299ce685560` (same) | same as repository | `af2cc77c4a0f` (same) | same as repository |
| Working copy with CRLF (Windows `core.autocrlf=true`) | `b299ce685560` | `2728bbe35f65` | `af2cc77c4a0f` | `394dbd188e94` |
| Same sources converted to LF (58 files), as on Linux/macOS | `b299ce685560` (same) | `5d1b8a36300b` (differs) | `af2cc77c4a0f` (same) | `6f3bf67a7074` (differs) |
| Committed `dist/index.cjs` at `076b59d` | `b299ce685560` (same) | - | - | - |

Notes on `PACKAGE-001`:
- The roadmap's statement that minified identifiers change between esbuild builds
  was **not reproduced** on this machine. Repeated builds, a different checkout
  path and CRLF/LF sources all produced the same bundle. tsdown therefore does not
  fix anything here, because nothing needed fixing for the bundle itself. Linux
  and macOS builds were not run.
- The source map is what varies. `sourcesContent` embeds the sources with the
  checkout's line endings, so a Windows build and a Linux build of the same commit
  give different maps with both bundlers. The esbuild map also embeds the whole
  `package.json`, because `src/constants.ts` imports `version` from it: any
  `package.json` edit (scripts, devDependencies) changes the map even when the
  bundle does not change. Only `version` reaches the bundle. The tsdown map did
  not change when `package.json` changed. If `PACKAGE-001` needs a reproducible
  map, the fix is an LF policy in `.gitattributes`, or not embedding
  `sourcesContent`. Changing the bundler does not fix it.

### 4.7 License notices (observation)

The bundles inline nine third-party packages: `@modelcontextprotocol/sdk`, `ajv`,
`ajv-formats`, `fast-deep-equal`, `json-schema-traverse`, `jsonc-parser` and
`zod` (MIT), and `fast-uri` and `smol-toml` (BSD-3-Clause). Only smol-toml carries
a `/*!` header, so it is the only notice that reaches either bundle. Neither bundle
nor the npm package contains the MIT notices or the fast-uri notice. Both licenses
require the copyright notice to accompany copies, and BSD-3-Clause clause 2 covers
binary redistribution explicitly. Removing the remaining smol-toml header without
shipping the notice elsewhere would therefore break its license. This applies to
both bundlers and is unrelated to performance. It should be tracked as a separate
packaging fix: a generated third-party notices file in the package, after which
inline legal comments can be dropped.

## 5. Decision

Adoption criteria and results for tsdown:

| Criterion | Result |
| --- | --- |
| Median cold start to `initialize` improves by at least 10%, outside the measurement spread, on Windows and on the installed tarball | **Not met.** Tarball: 8.9% (CI 7.4-10.3%), 7.8% (CI 4.3-11.2%) and 13.0% (CI 7.9-15.0%). Two of three sessions are below 10%, and every interval includes values below 10%. Repository: 6.6%, 9.3% and 9.1%. |
| No other metric gets worse in a way that matters | Met with reservations: tool calls unchanged, RSS 1.8 MiB lower, gzip size 8% smaller. Raw bundle is 4.5% larger, of which 14.3 kB is duplicated license text that rolldown cannot deduplicate. Build time is 60% longer (about 170 ms; build time only). The dev-tooling Node floor would rise to 24.11. |
| The compile-cache control does not deliver the same gain on its own | **Not met.** esbuild with a warm compile cache gives 9.0-11.8% in the same sessions, the same as tsdown. A cold cache costs 2.9-5.3% on the run that fills it. |

**Recommendation: keep esbuild unchanged. Do not add tsdown.** The bundler
branch is not merged. This branch commits only this report.

Supporting points and follow-ups for the owner. None of them is implemented here.
1. **Compile cache: not recommended now.** The warm gain is about 11-15 ms on a
   start that happens once per host session, and the run that fills the cache is
   4-7 ms slower. To get the gain in production, a small wrapper entry must call
   `module.enableCompileCache()` before it requires the bundle, because a bundle
   cannot cache its own compilation after it has started. That wrapper writes
   cache files to the user's temp directory by default. For a "quiet Windows"
   product this is a visible side effect for a gain users will not notice. Every
   figure in this point is derived from the tables above (estimate); none was
   measured as such.
2. **Identifier minification: worth a separate, gated change.** On this machine,
   the first launch of a newly written esbuild bundle (a fresh install or update)
   costs 443-488 ms instead of about 125 ms, almost all of it in the first file
   read. `minifyIdentifiers: false` (esbuild 0.25.12, with whitespace and syntax
   minification kept) cuts this to 233 ms. The cost is +217 kB raw / +22 kB gzip
   for the bundle and +0.5 MiB RSS, with no measurable change to warm start
   (ratio 0.968-0.980, CI includes 1) or tool calls. This needs the full
   dependency/build gate, measurement on a second Windows machine, and a decision
   on whether the result is specific to Defender's heuristics, before it is
   adopted.
3. **License notices** (section 4.7): separate packaging fix.
4. **`PACKAGE-001` reproducibility** (section 4.6): the bundle is reproducible
   here. Only the map depends on line endings and on `package.json`.

## 6. Reproduction

From the repository root, on branch `perf/tsdown-bundle-comparison`, Windows,
Node 24.21.0. Scripts are in Appendix B. Save them under `.artifacts/bundler/`,
which `.gitignore` excludes.

```bash
# Baseline (esbuild) and its copy outside dist/
npm run build
mkdir -p .artifacts/bundler/repo/esbuild/dist && cp dist/index.cjs dist/index.cjs.map .artifacts/bundler/repo/esbuild/dist/

# tsdown variant (Appendix A saved as scripts/build-tsdown.cjs)
npm install --save-dev --save-exact tsdown@0.23.0
node scripts/build-tsdown.cjs
mkdir -p .artifacts/bundler/repo/tsdown/dist && cp dist/index.cjs dist/index.cjs.map .artifacts/bundler/repo/tsdown/dist/

# Equivalence gate with the tsdown bundle
#   set "build": "node scripts/build-tsdown.cjs" in package.json, then:
npm run typecheck && npm run build && npm test && npm pack --dry-run && npm run test:consumer

# Tarballs: for v in esbuild tsdown, set the build script accordingly, then
npm pack --json --pack-destination .artifacts/bundler/pack/$v > .artifacts/bundler/pack/$v/pack.json
#   install each into its own %TEMP% directory and record the path:
#   (cd "$DIR" && npm init --yes && npm install --omit=dev --no-audit --no-fund <tarball>)
#   echo "$DIR" > .artifacts/bundler/pack/$v/installdir.txt

# esbuild-noident diagnostic variant
node .artifacts/bundler/variants.cjs
#   copy variants/es-minify-no-ident/* to repo/esbuild-noident/dist/ and into a copy of the esbuild install

# Measurements
node .artifacts/bundler/bench.cjs --runs 40 --warmup 5 --out .artifacts/bundler/results-1.json
node .artifacts/bundler/bench.cjs --runs 40 --warmup 5 --variants 'esbuild,tsdown,esbuild-noident,esbuild+cache(warm)' --out .artifacts/bundler/results-3.json
node .artifacts/bundler/bench.cjs --fresh --runs 30 --warmup 0 --variants 'esbuild,tsdown,esbuild-noident' --out .artifacts/bundler/results-fresh-2.json
node .artifacts/bundler/open-probe.cjs 20 .artifacts/bundler/variants/*/index.cjs .artifacts/bundler/repo/tsdown/dist/index.cjs
node .artifacts/bundler/usage.cjs --procs 30 --calls 20 --out .artifacts/bundler/usage-1.json
node .artifacts/bundler/bare-node.cjs
node .artifacts/bundler/build-bench.cjs . 10          # build time and reproducibility
node .artifacts/bundler/build-bench.cjs <copy-dir> 2  # copy with its own npm ci at another path

# Restore
git checkout -- package.json package-lock.json dist/ && npm ci
```

Sizes were computed with `zlib.gzipSync(buffer, { level: 9 })`. Tarball sizes are
from the `npm pack --json` output.

## Appendix A: tsdown build script

Saved as `scripts/build-tsdown.cjs` during the measurements, then removed from the branch.

### scripts/build-tsdown.cjs

```js
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { prepareBranding } = require('./branding.cjs');
const start = performance.now();
prepareBranding();
// Mirrors scripts/build.cjs: one self-contained CJS bundle whose only imports are Node builtins.
const externalPackages = [];
const rejectExternalPackages = {
  name: 'coagent8:reject-external-packages',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'chunk') continue;
      externalPackages.push(...[...output.imports, ...output.dynamicImports].filter(imported => !isBuiltin(imported)));
    }
  },
};
import('tsdown').then(({ build }) => build({
  config: false, entry: { index: 'src/index.ts' }, outDir: 'dist', clean: false,
  format: 'cjs', platform: 'node', target: 'node24', fixedExtension: true, hash: false,
  sourcemap: true, minify: true, dts: false, report: false, logLevel: 'warn',
  checks: { legacyCjs: false },
  // tsdown externalizes package.json dependencies by default; the bundle must inline them.
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  inputOptions: { resolve: { mainFields: ['module', 'main'] } },
  outputOptions: { keepNames: true },
  plugins: [rejectExternalPackages],
})).then(() => {
  if (externalPackages.length) {
    throw new Error(`Bundle requires external packages: ${externalPackages.join(', ')}`);
  }
  fs.chmodSync(path.resolve('dist/index.cjs'), 0o755);
  console.error(`Build complete in ${Math.round(performance.now()-start)} ms (minified bundle includes SDK dependencies).`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
```

## Appendix B: measurement scripts

Scratch tooling under `.artifacts/bundler/`, not committed as runtime files.

### .artifacts/bundler/bench.cjs

```js
// Startup benchmark for the CoAgent8 MCP server bundles. Scratch tooling, not committed as runtime code.
// Usage: node .artifacts/bundler/bench.cjs [--runs N] [--warmup N] [--out file.json]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createTestEnvironment } = require('../../tests/helpers/environment.cjs');

const repo = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const RUNS = Number(opt('--runs', 40));
const WARMUP = Number(opt('--warmup', 5));
const OUT = path.resolve(opt('--out', path.join(__dirname, 'results.json')));

const installDir = v => fs.readFileSync(path.join(__dirname, 'pack', v, 'installdir.txt'), 'utf8').trim();
const FRESH = args.includes('--fresh');
const freshRoot = FRESH ? fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-bench-fresh-')) : null;
const locations = FRESH ? {
  // A newly written copy of the installed bundle per run: the first launch also pays the antivirus scan of a new file.
  fresh: v => {
    const dir = fs.mkdtempSync(path.join(freshRoot, v + '-'));
    fs.copyFileSync(path.join(installDir(v), 'node_modules', 'coagent8', 'dist', 'index.cjs'), path.join(dir, 'index.cjs'));
    return { entry: path.join(dir, 'index.cjs'), cwd: installDir(v) };
  },
} : {
  repo: v => ({ entry: path.join(__dirname, 'repo', v, 'dist', 'index.cjs'), cwd: repo }),
  tarball: v => ({ entry: path.join(installDir(v), 'node_modules', 'coagent8', 'dist', 'index.cjs'), cwd: installDir(v) }),
};
// cache: null = no compile cache, 'cold' = fresh empty NODE_COMPILE_CACHE per run, 'warm' = persistent primed directory.
const allVariants = [
  { name: 'esbuild', bundle: 'esbuild', cache: null },
  { name: 'tsdown', bundle: 'tsdown', cache: null },
  { name: 'esbuild+cache(cold)', bundle: 'esbuild', cache: 'cold' },
  { name: 'esbuild+cache(warm)', bundle: 'esbuild', cache: 'warm' },
  { name: 'tsdown+cache(warm)', bundle: 'tsdown', cache: 'warm' },
  // esbuild with whitespace and syntax minification but no identifier mangling.
  { name: 'esbuild-noident', bundle: 'esbuild-noident', cache: null },
];
const selected = opt('--variants', FRESH ? 'esbuild,tsdown' : 'esbuild,tsdown,esbuild+cache(cold),esbuild+cache(warm),tsdown+cache(warm)').split(',');
const variants = selected.map(name => allVariants.find(v => v.name === name) ?? (() => { throw new Error('unknown variant ' + name); })());

const { env: baseEnv, root: envRoot } = createTestEnvironment();
delete baseEnv.NODE_COMPILE_CACHE; delete baseEnv.NODE_OPTIONS; delete baseEnv.NODE_DISABLE_COMPILE_CACHE;
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-bench-cache-'));
const warmCache = {};

function workingSetBytes(pid) {
  // Windows working set equals what Node reports as RSS there; tasklist is hidden and runs after timing.
  if (process.platform !== 'win32') {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return Number(/VmRSS:\s+(\d+)/.exec(status)[1]) * 1024;
  }
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const field = r.stdout.trim().split('","').pop().replace(/[^\d]/g, '');
  return Number(field) * 1024;
}

function runOnce(variant, location) {
  const { entry, cwd } = locations[location](variant.bundle);
  const env = { ...baseEnv };
  let coldDir;
  if (variant.cache === 'cold') { coldDir = fs.mkdtempSync(path.join(cacheRoot, 'cold-')); env.NODE_COMPILE_CACHE = coldDir; }
  if (variant.cache === 'warm') {
    const key = `${variant.bundle}-${location}`;
    warmCache[key] ||= fs.mkdtempSync(path.join(cacheRoot, `warm-${key}-`));
    env.NODE_COMPILE_CACHE = warmCache[key];
  }
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const proc = spawn(process.execPath, [entry], { cwd, env, stdio: 'pipe', windowsHide: true });
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    let buffer = '', stderr = '', tInit, tListSent, tList, rss;
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`timeout: ${stderr}`)); }, 20000);
    const send = message => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    proc.stderr.on('data', d => { stderr += d; });
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          tInit = ms();
          if (!message.result?.serverInfo) return reject(new Error(`bad initialize: ${line.slice(0, 200)}`));
          send({ method: 'notifications/initialized' });
          tListSent = ms();
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          tList = ms();
          if (message.result?.tools?.length !== 9) return reject(new Error('bad tools/list'));
          rss = workingSetBytes(proc.pid);
          proc.stdin.end();
        }
      }
    });
    proc.once('error', reject);
    proc.once('exit', code => {
      clearTimeout(timer);
      const cacheFiles = env.NODE_COMPILE_CACHE ? countFiles(env.NODE_COMPILE_CACHE) : null;
      if (coldDir) fs.rmSync(coldDir, { recursive: true, force: true });
      if (code !== 0 || tList === undefined) return reject(new Error(`exit ${code}: ${stderr}`));
      resolve({ initMs: tInit, listMs: tList - tListSent, listTotalMs: tList, rssBytes: rss, exitMs: ms(), cacheFiles });
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bench', version: '1' } } });
  });
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n++;
  return n;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), p95: quantile(s, 0.95), min: s[0], max: s.at(-1) };
}
// Percentile bootstrap of the ratio median(candidate)/median(baseline), deterministic seed.
function bootstrapRatio(candidate, baseline, iterations = 5000) {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const med = a => { const s = [...a].sort((x, y) => x - y); return quantile(s, 0.5); };
  const sample = a => a.map(() => a[Math.floor(rand() * a.length)]);
  const ratios = [];
  for (let i = 0; i < iterations; i++) ratios.push(med(sample(candidate)) / med(sample(baseline)));
  ratios.sort((a, b) => a - b);
  return { ratio: med(candidate) / med(baseline), ci95: [quantile(ratios, 0.025), quantile(ratios, 0.975)] };
}

(async () => {
  const results = {};
  for (const location of Object.keys(locations)) {
    for (const v of variants) results[`${location}/${v.name}`] = [];
    // Warm-up runs prime the OS file cache and the persistent compile caches; they are discarded.
    for (let i = 0; i < WARMUP; i++) for (const v of variants) await runOnce(v, location);
    for (let i = 0; i < RUNS; i++) {
      // Round-robin with a rotating start: A, B, C, ... then B, C, ..., A.
      const order = variants.map((_, k) => variants[(k + i) % variants.length]);
      for (const v of order) results[`${location}/${v.name}`].push(await runOnce(v, location));
    }
    process.stderr.write(`${location} done\n`);
  }
  const summary = {};
  for (const [key, runs] of Object.entries(results)) {
    summary[key] = {
      initMs: summarize(runs.map(r => r.initMs)),
      listMs: summarize(runs.map(r => r.listMs)),
      listTotalMs: summarize(runs.map(r => r.listTotalMs)),
      rssMiB: summarize(runs.map(r => r.rssBytes / 1048576)),
      cacheFiles: summarize(runs.map(r => r.cacheFiles ?? 0)),
    };
  }
  const comparisons = {};
  for (const location of Object.keys(locations)) {
    const base = results[`${location}/esbuild`].map(r => r.initMs);
    for (const v of variants.slice(1)) comparisons[`${location}/${v.name} vs esbuild (initialize)`] = bootstrapRatio(results[`${location}/${v.name}`].map(r => r.initMs), base);
  }
  const meta = { node: process.version, platform: process.platform, release: os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length, memGiB: os.totalmem() / 2 ** 30, runs: RUNS, warmup: WARMUP, date: new Date().toISOString() };
  fs.writeFileSync(OUT, JSON.stringify({ meta, summary, comparisons, results }, null, 2));
  const f = x => x.toFixed(1);
  for (const [key, s] of Object.entries(summary)) {
    console.log(`${key.padEnd(30)} init med ${f(s.initMs.median)} p95 ${f(s.initMs.p95)} IQR ${f(s.initMs.p25)}-${f(s.initMs.p75)} range ${f(s.initMs.min)}-${f(s.initMs.max)} | list med ${f(s.listMs.median)} p95 ${f(s.listMs.p95)} | rss med ${f(s.rssMiB.median)} MiB | cache files ${s.cacheFiles.median}`);
  }
  for (const [key, c] of Object.entries(comparisons)) console.log(`${key}: ratio ${c.ratio.toFixed(3)} CI95 ${c.ci95.map(x => x.toFixed(3)).join('-')}`);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  if (freshRoot) fs.rmSync(freshRoot, { recursive: true, force: true });
  fs.rmSync(envRoot, { recursive: true, force: true, maxRetries: 5 });
})().catch(error => { console.error(error); process.exitCode = 1; });
```

### .artifacts/bundler/usage.cjs

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

### .artifacts/bundler/variants.cjs

```js
// Builds esbuild output variants into .artifacts/bundler/variants/ to isolate what slows the first antivirus scan.
const esbuild = require('esbuild'); const path = require('node:path');
const base = { entryPoints: ['src/index.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', sourcemap: true,
  minify: true, keepNames: true, logLevel: 'warning', mainFields: ['module', 'main'] };
const variants = {
  'es-baseline': {}, 'es-legal-none': { legalComments: 'none' }, 'es-no-keepnames': { keepNames: false },
  'es-no-minify': { minify: false }, 'es-minify-ws-only': { minify: false, minifyWhitespace: true },
  'es-minify-no-ident': { minify: false, minifyWhitespace: true, minifySyntax: true },
};
(async () => { for (const [name, o] of Object.entries(variants)) await esbuild.build({ ...base, ...o, outfile: path.join(__dirname, 'variants', name, 'index.cjs') }); })();
```

### .artifacts/bundler/build-bench.cjs

```js
// Build time (whole process wall time, alternating) and reproducibility of both build scripts. Scratch tooling.
'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process'), { createHash } = require('node:crypto');
const cwd = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const RUNS = Number(process.argv[3] || 10);
const scripts = { esbuild: 'scripts/build.cjs', tsdown: 'scripts/build-tsdown.cjs' };
const sha = f => createHash('sha256').update(fs.readFileSync(path.join(cwd, f))).digest('hex');
const times = { esbuild: [], tsdown: [] }, hashes = { esbuild: new Set(), tsdown: new Set() }, mapHashes = { esbuild: new Set(), tsdown: new Set() };
for (let i = -1; i < RUNS; i++) for (const v of i % 2 ? ['tsdown', 'esbuild'] : ['esbuild', 'tsdown']) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [scripts[v]], { cwd, encoding: 'utf8', windowsHide: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(v + ': ' + r.stderr);
  hashes[v].add(sha('dist/index.cjs')); mapHashes[v].add(sha('dist/index.cjs.map'));
  if (i >= 0) times[v].push(ms);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
for (const v of Object.keys(scripts)) console.log(v.padEnd(8), 'build ms median', q(times[v], .5).toFixed(0), 'p95', q(times[v], .95).toFixed(0), 'min', Math.min(...times[v]).toFixed(0), 'max', Math.max(...times[v]).toFixed(0), '| distinct bundle hashes', hashes[v].size, [...hashes[v]].map(h => h.slice(0, 12)).join(','), '| distinct map hashes', mapHashes[v].size, [...mapHashes[v]].map(h => h.slice(0, 12)).join(','));
```

### .artifacts/bundler/bare-node.cjs

```js
// Floor: spawn-to-first-stdout-line of an empty Node process with stdin piped, same harness shape as bench.cjs.
const { spawn } = require('node:child_process');
const child = 'process.stdout.write("x"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';
const r = [];
(async () => {
  for (let i = 0; i < 45; i++) {
    const t = process.hrtime.bigint();
    await new Promise((res, rej) => {
      const p = spawn(process.execPath, ['-e', child], { stdio: 'pipe', windowsHide: true });
      p.stdout.once('data', () => { r.push(Number(process.hrtime.bigint() - t) / 1e6); p.stdin.end(); });
      p.once('error', rej); p.once('exit', res);
    });
  }
  const s = r.slice(5).sort((a, b) => a - b), q = p => s[Math.round((s.length - 1) * p)];
  console.log('bare node first line: n', s.length, 'median', q(.5).toFixed(1), 'p25', q(.25).toFixed(1), 'p75', q(.75).toFixed(1), 'p95', q(.95).toFixed(1));
})();
```
