# Context7 and CoAgent8 MCP comparison

Date: 2026-10-07 (Europe/Warsaw).

This is an observation report, not a new implementation plan. [ROADMAP.md](ROADMAP.md)
remains the active plan. The local checkout was on `feat/dark-theme-branding`,
HEAD `271152a0950bd1d5421bf63fd85f53233e33a59f`, with uncommitted branding changes.
The running MCP server's bundle hash was not obtained; this report does not
establish that the live server loaded those changes.

## Experiment and result

The requested sequence completed: retrieve documentation through Context7, ask
Gemini through CoAgent8 whether the retrieved claims are true, and compare the
observable MCP interactions. The topic was the light/dark server icons added in
the preceding task.

1. Called `mcp__context7__resolve_library_id` for Model Context Protocol,
   specifically icon metadata in protocol revision `2025-11-25`.
2. Selected `/websites/modelcontextprotocol_io_specification_2025-11-25`:
   exact revision, official specification, High reputation, 744 snippets,
   benchmark score 88.82 as reported by the resolver in this call.
3. Called `mcp__context7__query_docs` for the meaning of `Icon.theme`, Base64 PNG
   data URIs, `sizes: ['64x64']`, and theme-dependent `serverInfo.icons`.
4. Called `mcp__coagent8__consult` with `backend: 'gemini'`. Model, effort,
   workspace, timeout and session handle were omitted. The prompt supplied
   paraphrased Context7 evidence and its three source URLs. Gemini was asked to
   classify four claims and explicitly disclose its verification scope, without
   reading workspace files or invoking tools.

| Claim | Context7 evidence | Gemini assessment | Report assessment |
| --- | --- | --- | --- |
| Light artwork on a dark background should declare `theme: 'dark'` | `theme` describes the intended background | Supported | Supported by the retrieved specification |
| A Base64 PNG data URI with `mimeType: 'image/png'` and `sizes: ['64x64']` is valid | Data URIs and WxH size entries are allowed | Supported | Supported by the retrieved specification |
| A server may provide one icon for each background theme | `serverInfo.icons` is an array; multiple contexts are supported | Supported | Supported by the retrieved specification |
| Declaring both variants guarantees correct display in every host | Icon rendering is conditional on client support and UI policy | Contradicted | The claimed universal guarantee is unsupported |

Sources returned by Context7:

- [Icon schema](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- [Icon metadata and client requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- [Initialization and serverInfo](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

Gemini explicitly said it checked only the supplied excerpts and did not perform
independent retrieval or inspect the workspace. Agreement is therefore a second
interpretation of the same evidence, not independent confirmation of source
freshness or actual host behavior. URLs in its answer were also supplied in its
prompt. The specification is the evidence for the icon claims.

## Observable differences

Durations below measure elapsed time around each awaited tool call in the calling
agent. They include tool overhead; this single sample is not a performance benchmark.
Character counts cover returned text, not tokens or UTF-8 byte counts.

| Property | Context7 | CoAgent8 / Gemini |
| --- | --- | --- |
| Purpose in this workflow | Retrieve indexed documentation | Interpret the supplied evidence using another model |
| Calls | Resolve library, then query documentation | One `consult` call |
| Caller-measured duration | Resolve 2.036 s; query 2.393 s; total 4.429 s | 23.974 s; footer reports 23.8 s |
| Returned text length | Resolve 2,089 characters; query 10,205 characters | 1,604 characters including footer |
| MCP content | One `text` block per response | One `text` block |
| `structuredContent` | Absent in both observed responses | Absent; deliberate execution-result design |
| Error indication | No `isError` property in observed responses | Explicit `isError: false` |
| Provenance presented | Source URLs and documentation excerpts; resolver selection metadata | Model-authored explanation and URLs supplied by the caller |
| Execution metadata | No model, backend, duration or session footer | Backend, effective model, duration, session and workspace fallback footer |
| Continuation | Selected library ID is passed into the next lookup | Session handle supports subsequent model turns |
| Workspace dependence | No workspace argument was supplied | Selected the server-directory fallback and disclosed it |

The CoAgent8 footer identified `gemini-3.8-flash-high` and session
`syn_sess_051f0ef6855db69608ab69cc` as ready for continuation. A prior arithmetic
smoke call returned `4` and reported 7.5 s; it was a separate session, not a
continuation of this experiment.

Both services used ordinary MCP text results here. Their different output formats
come from their tools' purposes, not different MCP transport requirements. An
absent `structuredContent` is not by itself a missing feature. CoAgent8's
[result formatter](../src/tools/result.ts) intentionally keeps the answer in
`content` to accommodate client result-channel behavior documented in the
[runtime contract](RUNTIME_CONTRACT.md).

## What CoAgent8 lacks for this workflow

These observations suggest product improvements; they are not newly implemented
features or a replacement priority list.

| Gap | Evidence and practical effect | Current boundary |
| --- | --- | --- |
| Explicit evidence provenance and verification scope | We manually embedded excerpts, source URLs and a request to disclose whether retrieval occurred. `consult` has no dedicated evidence/provenance contract. | A successful call means execution succeeded, not that its factual claims were independently verified. Useful source links and scope can already be requested in the plain prompt. |
| A convenient independent fact-check workflow | Gemini evaluated the text we supplied. This experiment did not independently retrieve the specification through Gemini. | CoAgent8 is a CLI bridge, not a documentation index. Independent retrieval must be separately authorized and supported by the backend's isolated capabilities; it should not silently inherit MCP tools. |
| A session-free mode for small one-off questions | Both simple questions returned a session handle. Source contract says execution always acquires a disk session and turn lease. | History-off configuration exists, but does not remove session storage; ephemeral/per-call behavior is planned in the roadmap. |
| Verified icon display and live artifact identity | This chat exposed consult results, not the live initialization payload, server bundle hash, or host icon rendering. | Source/package tests from the preceding task passed, but this call cannot prove the running server uses the new artwork or that a host renders it. |
| Optional machine-readable provenance without splitting the answer channel | Backend/model/session/workspace information arrived in a human-readable footer. The inspected formatter does not expose these as separate result fields. | Any future metadata design must preserve the plain answer and existing client compatibility; restoring a competing structured answer channel is not implied. |

The inspected [consult implementation](../src/tools/consult.tool.ts) accepts a
proposal, optional analysis focus/questions, file paths and execution parameters.
It does not enforce source retrieval, citation validity or independent verification.
Its result uses `requireEnvelope: false`; a consult is not a bound review approval.

Existing correctness and security gaps remain more urgent than presentation
features. The [runtime contract](RUNTIME_CONTRACT.md) and [roadmap](ROADMAP.md)
already record incomplete isolation of inherited MCP tools for Codex/agy
(`CUR-002`), review-gate completeness/snapshot/check verification (`CUR-001`), and
remaining output-budget, cache and execution-budget work. Those are documented
limitations, not defects reproduced by this experiment. Neither successful
consultation establishes sandbox isolation, approval correctness or release readiness.

## Verification and limits

- Context7 resolution and documentation lookup completed and returned evidence.
- Native CoAgent8 MCP consultation completed with `isError: false`.
- Compared actual response keys, text blocks, character counts and timings.
- Inspected consult/result source and the current runtime contract for gap claims.
- Reviewed report links and ran `git diff --check` for the documentation change.
- No host icon UI acceptance, live bundle hash, independent Gemini retrieval,
  continuation/cancellation test, privacy test or security audit was performed.
- Runtime tests/build were not repeated solely to write this report.

This sample demonstrates a working documentation-to-consultation handoff. It
does not compare the two tools as interchangeable services or establish a general
latency distribution. Implementation and acceptance priorities remain in the roadmap.
