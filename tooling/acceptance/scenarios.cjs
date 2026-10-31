/**
 * Live acceptance scenarios N2-N4 through the installed runtime (ACCEPT-001a2, row 2.17).
 *
 * @remarks
 * Every scenario talks MCP to `node <installed entry> mcp`, so it exercises the packaged
 * runtime and the real backend CLIs the way a client does. Assertions check structure and
 * server behavior, never the wording of a model's answer beyond a nonce it is asked to
 * repeat. A review's verdict is recorded, not asserted: transport smoke does not prove
 * detection of the seeded defect, and the gate semantics have their own fixture tests.
 * A scenario whose precondition was not observed (a turn that finished before it could be
 * cancelled, a deadline the turn beat) is NOT_RUN, never PASS.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { runCommand } = require('../../src/execution/process.ts');
const { connectMcp, resultText } = require('./mcp-client.cjs');

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Files a cancellable turn is asked to read one by one, so it is still working when cancelled. */
const READING_FILES = 40;
/** Progress messages that come from the backend's own event stream, not from preparation. */
const BACKEND_PROGRESS = /^(Running: |Completed: |Formulating response)/;

/** A scenario whose precondition did not occur; recorded as NOT_RUN. */
class NotRun extends Error {}

/** The start and the end of a long result, where the envelope and the server footer are. */
function excerpt(text) {
  return text.length <= 900
    ? text
    : `${text.slice(0, 400)}
[...]
${text.slice(-500)}`;
}

function footer(text) {
  const handle = /session_handle=(\S+)/.exec(text);
  // Model names contain hyphens, so the model ends at the separator before the duration.
  const line = /CoAgent8: ([a-z]+) - (.+?) - \d+\.\ds\b/.exec(text);
  const verdict = /^Verdict: (READY|BLOCKED)/m.exec(text);
  return {
    handle: handle ? handle[1] : null,
    backend: line ? line[1] : null,
    model: line ? line[2].trim() : null,
    verdict: verdict ? verdict[1] : null,
  };
}

async function git(cwd, args, env) {
  const result = await runCommand('git', args, { cwd, env, timeoutMs: 30_000 });
  if (result.status !== 'completed' || result.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

/**
 * Creates a throwaway repository with one committed note, files to read and, when asked,
 * an uncommitted prose change with a seeded contradiction.
 */
async function createWorkspace(dir, env, withChange) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q'], env);
  await git(dir, ['config', 'user.email', 'acceptance@example.invalid'], env);
  await git(dir, ['config', 'user.name', 'CoAgent8 acceptance'], env);
  await git(dir, ['config', 'core.autocrlf', 'false'], env);
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nThe build runs on Node 24 and Node 26.\n');
  fs.mkdirSync(path.join(dir, 'reading'));
  for (let i = 1; i <= READING_FILES; i++) {
    fs.writeFileSync(path.join(dir, 'reading', `part-${String(i).padStart(2, '0')}.md`), `Part ${i}: line ${i} of the reading list.\n`);
  }
  await git(dir, ['add', '.'], env);
  await git(dir, ['commit', '-qm', 'Initial notes'], env);
  if (withChange) fs.appendFileSync(path.join(dir, 'notes.md'), '\nThe build supports only Node 18, as stated above.\n');
  return dir;
}

/**
 * Picks the model a backend's scenarios use.
 *
 * @remarks
 * By default the backend's default model, which is what a user gets with `auto`: the
 * scenarios then omit `model`, so the server resolves it as it would for the user. The
 * operator's `--model` names one; `--cheapest` takes the lowest-priced model with a verified
 * price, which follows the envelope format less reliably and does not represent daily use.
 * @returns The choice, or `{ error }` when no usable model exists.
 */
function chooseModel(id, models, health, override, cheapest = false) {
  const known = health?.backends?.[id]?.models || [];
  const requiresEffort = name => known.find(model => model.id === name)?.effortRequired === true;
  const lowestEffort = efforts => EFFORT_ORDER.find(effort => (efforts || []).includes(effort));
  const entries = (models?.selection || []).filter(item => item.backend === id);
  if (override) {
    const entry = entries.find(item => item.model === override);
    return { model: override, effort: requiresEffort(override) ? lowestEffort(entry?.efforts) : undefined, source: 'operator' };
  }
  if (cheapest) {
    const candidates = entries
      .filter(item => typeof item.price?.outputUsdPerMTok === 'number' && !item.approval?.required && !item.approval?.denied)
      .sort((a, b) => a.price.outputUsdPerMTok - b.price.outputUsdPerMTok);
    if (!candidates.length) return { error: `no ${id} model with a verified price that needs no approval; pass --model ${id}=<name>.` };
    const pick = candidates[0];
    return {
      model: pick.model,
      effort: requiresEffort(pick.model) ? lowestEffort(pick.efforts) : undefined,
      source: `lowest verified output price (${pick.price.outputUsdPerMTok} USD/M)`,
    };
  }
  const fallback = entries.find(item => item.defaultSource);
  if (!fallback) return { error: `doctor names no ${id} default model; pass --model ${id}=<name>.` };
  if (fallback.approval?.required || fallback.approval?.denied) {
    return { error: `the ${id} default ${fallback.model} needs approval, which the runner never grants; pass --model ${id}=<name>.` };
  }
  return { model: fallback.model, serverDefault: true, source: `backend default (${fallback.defaultSource})` };
}

/**
 * Runs the scenarios.
 *
 * @param options - `entry` is the installed runtime; `env` the scenario server environment;
 * `slowEnv` (fixture lane only) additions for the cancellation server; `workRoot` a
 * directory under the isolated root; `backends` and `models` the selection; `record`
 * records one step; `signal` aborts.
 */
async function runScenarios(options) {
  const { entry, env, workRoot, record } = options;
  const timeoutProbeMs = options.timeoutProbeMs || 1000;
  const turnMs = options.turnTimeoutMs || 300_000;
  const workspaceA = await createWorkspace(path.join(workRoot, 'workspace-a'), env, true);
  const workspaceB = await createWorkspace(path.join(workRoot, 'workspace-b'), env, false);
  const start = (extraEnv = {}) =>
    connectMcp({
      command: process.execPath,
      args: [entry, 'mcp'],
      cwd: workspaceA,
      env: { ...env, ...extraEnv },
      abortSignal: options.signal,
    });
  const call = (client, name, args, callOptions = {}) =>
    client.callTool(name, { workspace_path: workspaceA, ...args }, { timeoutMs: turnMs + 60_000, ...callOptions });

  const main = await start();
  let deleteHistoryChecked = false;
  try {
    let health = null,
      models = null;
    await record('n2_doctor', 'N2: doctor health and models', null, async () => {
      // doctor takes no workspace_path.
      const healthResult = await main.callTool('doctor', { scope: 'health', detail: 'full' }, { timeoutMs: turnMs });
      const modelsResult = await main.callTool('doctor', { scope: 'models', detail: 'full' }, { timeoutMs: turnMs });
      health = healthResult.structuredContent;
      models = modelsResult.structuredContent;
      if (!health?.backends) throw new Error(`doctor health returned no backends: ${resultText(healthResult).slice(0, 300)}`);
      if (!models?.selection) throw new Error(`doctor models returned no selection: ${resultText(modelsResult).slice(0, 300)}`);
      return { details: `server ${health.server_version}; ready: ${(health.ready_backends || []).join(', ') || 'none'}` };
    });

    for (const id of options.backends) {
      const skip = reason => async () => {
        throw new NotRun(reason);
      };
      const info = health?.backends?.[id];
      let usable = false,
        choice = null;
      await record(`n2_health_${id}`, `N2: ${id} health`, id, async () => {
        if (!info) throw new Error(`doctor lists no ${id} backend.`);
        if (!info.installed || !info.executionSupported)
          throw new Error(`${id} is not installed or cannot execute: ${(info.authEvidence || []).join('; ')}`);
        choice = chooseModel(id, models, health, options.models?.[id], options.cheapest);
        if (choice.error) throw new Error(choice.error);
        usable = true;
        // agy reports `unknown` by design; only an execution proves sign-in.
        return {
          details: `${info.version}; auth ${info.authStatus}; model ${choice.model}${choice.effort ? ` (${choice.effort})` : ''} by ${choice.source}`,
        };
      });
      const modelArgs =
        !choice || choice.error
          ? {}
          : choice.serverDefault
            ? { backend: id }
            : { backend: id, model: choice.model, ...(choice.effort ? { reasoning_effort: choice.effort } : {}) };
      const nonce = randomBytes(4).toString('hex').toUpperCase();
      let consultHandle = null;

      await record(
        `n2_consult_${id}`,
        `N2: ${id} consult`,
        id,
        !usable
          ? skip(`${id} health did not pass.`)
          : async () => {
              const result = await call(main, 'consult', {
                ...modelArgs,
                proposal: `Remember the token ${nonce}. Reply with the token only.`,
              });
              const text = resultText(result),
                meta = footer(text);
              if (result.isError) throw new Error(`consult failed: ${text.slice(0, 400)}`);
              if (meta.backend !== id) throw new Error(`footer names backend ${meta.backend}, expected ${id}.`);
              if (!text.includes(nonce)) throw new Error('the answer does not repeat the token.');
              consultHandle = meta.handle;
              return { details: `model ${meta.model}; session ${meta.handle}` };
            },
      );

      await record(
        `n3_continuation_${id}`,
        `N3: ${id} continuation`,
        id,
        !consultHandle
          ? skip('no consult session.')
          : async () => {
              const result = await call(main, 'consult', {
                ...modelArgs,
                session_handle: consultHandle,
                proposal: 'Which token did I ask you to remember? Reply with the token only.',
              });
              const text = resultText(result);
              if (result.isError) throw new Error(`follow-up failed: ${text.slice(0, 400)}`);
              if (footer(text).handle !== consultHandle) throw new Error('the follow-up continued another session.');
              if (!text.includes(nonce)) throw new Error('the follow-up does not recall the token.');
              return { details: 'the second turn recalled the token' };
            },
      );

      await record(
        `n3_history_${id}`,
        `N3: ${id} history paging`,
        id,
        !consultHandle
          ? skip('no consult session.')
          : async () => {
              let cursor,
                pages = 0,
                last = 0,
                turns = 0;
              do {
                const page = (
                  await call(main, 'session', { action: 'history', session_handle: consultHandle, limit: 2, ...(cursor ? { cursor } : {}) })
                ).structuredContent;
                if (!page || !Array.isArray(page.events)) throw new Error('history page has no events.');
                for (const event of page.events) {
                  if (!(event.sequence > last)) throw new Error(`sequence ${event.sequence} does not follow ${last}.`);
                  last = event.sequence;
                  if (event.type === 'turn_started') turns++;
                }
                if (page.nextCursor && page.nextCursor === cursor) throw new Error('the cursor did not advance.');
                cursor = page.nextCursor;
                pages++;
              } while (cursor && pages < 100);
              if (cursor) throw new Error('history did not end within 100 pages.');
              if (turns < 2) throw new Error(`history shows ${turns} turns, expected 2.`);
              return { details: `${pages} pages, last sequence ${last}, ${turns} turns` };
            },
      );

      await record(
        `n3_isolation_${id}`,
        `N3: ${id} workspace isolation`,
        id,
        !consultHandle
          ? skip('no consult session.')
          : async () => {
              const listed = (await call(main, 'session', { action: 'list', workspace_path: workspaceB })).structuredContent;
              if ((listed?.sessions || []).some(item => item.sessionHandle === consultHandle))
                throw new Error('another workspace lists the session.');
              const foreign = await call(main, 'session', { action: 'history', session_handle: consultHandle, workspace_path: workspaceB });
              // Only the documented workspace refusal proves isolation; any other error does not.
              if (!foreign.isError || !resultText(foreign).includes('History not found in this workspace'))
                throw new Error(
                  `another workspace's history read did not end in the workspace refusal: ${resultText(foreign).slice(0, 300)}`,
                );
              return { details: 'not listed and not readable from another workspace' };
            },
      );

      let reviewHandle = null,
        reviewComplete = false;
      await record(
        `n2_review_${id}`,
        `N2: ${id} review`,
        id,
        !usable
          ? skip(`${id} health did not pass.`)
          : async () => {
              const result = await call(main, 'review', {
                ...modelArgs,
                scope: 'uncommitted',
                instructions: 'Check notes.md for statements that contradict each other.',
              });
              const text = resultText(result),
                meta = footer(text);
              if (result.isError) throw new Error(`review failed: ${text.slice(0, 400)}`);
              if (!/^SNAPSHOT: \S+/m.test(text) || !/^END_REVIEW\s*$/m.test(text))
                throw new Error(`no review envelope in the result: ${excerpt(text)}`);
              if (!meta.verdict) throw new Error('no server verdict in the footer.');
              reviewHandle = meta.handle;
              reviewComplete = /^COVERAGE: COMPLETE\s*$/m.test(text);
              if (!reviewComplete) throw new Error(`coverage is not complete (server verdict ${meta.verdict}).`);
              return { details: `server verdict ${meta.verdict} (recorded, not asserted); session ${meta.handle}` };
            },
      );

      await record(
        `n3_repeat_${id}`,
        `N3: ${id} unchanged repeat review`,
        id,
        !reviewComplete
          ? skip('no complete review to repeat.')
          : async () => {
              const before = (await call(main, 'session', { action: 'list' })).structuredContent.sessions.find(
                item => item.sessionHandle === reviewHandle,
              );
              const result = await call(main, 'review', {
                ...modelArgs,
                scope: 'uncommitted',
                session_handle: reviewHandle,
                instructions: 'Check notes.md for statements that contradict each other.',
              });
              const text = resultText(result);
              const after = (await call(main, 'session', { action: 'list' })).structuredContent.sessions.find(
                item => item.sessionHandle === reviewHandle,
              );
              if (result.isError || !/^No model turn: this request matches a completed review/m.test(text))
                throw new Error(`the unchanged repeat was not deduplicated: ${text.slice(0, 300)}`);
              if (footer(text).handle !== reviewHandle) throw new Error('the repeat returned another session handle.');
              if (!before || !after || after.turnCount !== before.turnCount) throw new Error('the turn count changed.');
              return { details: `no new turn; turn count ${after.turnCount}` };
            },
      );

      await record(
        `n2_timeout_${id}`,
        `N2: ${id} timeout reporting`,
        id,
        !usable
          ? skip(`${id} health did not pass.`)
          : async () => {
              const result = await call(main, 'consult', { ...modelArgs, proposal: 'Reply with OK.', timeout_ms: timeoutProbeMs });
              const text = resultText(result);
              if (!result.isError) throw new NotRun(`the turn finished within ${timeoutProbeMs} ms.`);
              if (!/\[TIMEOUT\b/.test(text)) throw new Error(`expected a TIMEOUT error: ${text.slice(0, 300)}`);
              if (!text.includes(`${timeoutProbeMs} ms`)) throw new Error('the timeout error does not name the budget.');
              return { details: `TIMEOUT naming the ${timeoutProbeMs} ms budget` };
            },
      );

      await record(
        `n4_cancel_${id}`,
        `N4: ${id} cancel a running turn`,
        id,
        !usable
          ? skip(`${id} health did not pass.`)
          : async () => {
              const runner = await start(options.slowEnv);
              try {
                let backendStarted,
                  started = null,
                  progress = [];
                const startedPromise = new Promise(resolve => {
                  backendStarted = resolve;
                });
                const turn = call(
                  runner,
                  'consult',
                  {
                    ...modelArgs,
                    proposal: `Read each of the ${READING_FILES} files in reading/ with a separate tool call, in order, then list their first lines.`,
                  },
                  {
                    onProgress: params => {
                      progress.push(params.message);
                      if (BACKEND_PROGRESS.test(params.message || '')) backendStarted(params.message);
                    },
                  },
                );
                const raced = await Promise.race([startedPromise.then(message => ({ message })), turn.then(result => ({ result }))]);
                if (raced.result)
                  throw new NotRun(`the turn ended before the backend reported work (${progress.length} progress messages).`);
                started = raced.message;
                const running = (await call(main, 'session', { action: 'list' })).structuredContent.sessions.find(
                  item => item.state === 'running',
                );
                if (!running) throw new Error('no running session is listed while the backend works.');
                const handle = running.sessionHandle;
                // Another server process may not end this process's turn (cancelSession owner check).
                const foreign = resultText(await call(main, 'cancel', { session_handle: handle }));
                if (!/another CoAgent8 server process/.test(foreign))
                  throw new Error(`another server's cancel was not refused: ${foreign.slice(0, 300)}`);
                const cancelled = await call(runner, 'cancel', { session_handle: handle });
                const result = await turn;
                if (!cancelled.structuredContent?.cancelled)
                  throw new Error(`cancel did not report a cancelled turn: ${resultText(cancelled).slice(0, 300)}`);
                if (!result.isError) throw new Error('the cancelled turn returned an answer.');
                const after = (await call(main, 'session', { action: 'list' })).structuredContent.sessions.find(
                  item => item.sessionHandle === handle,
                );
                if (!after || after.state !== 'idle' || after.activePid) throw new Error('the session lease was not released.');
                await runner.close();
                const reuse = await call(main, 'consult', { ...modelArgs, session_handle: handle, proposal: 'Reply with OK.' });
                if (reuse.isError) throw new Error(`the session could not be reused: ${resultText(reuse).slice(0, 300)}`);
                return { details: `cancelled after "${started}"; other server refused; lease released; reused from another server` };
              } finally {
                await runner.close();
              }
            },
      );

      if (!deleteHistoryChecked && usable) {
        deleteHistoryChecked = true;
        await record(
          'n3_close',
          `N3: close, closed-session refusal and delete_history (${id})`,
          id,
          !consultHandle
            ? skip('no consult session.')
            : async () => {
                const closeResult = async handle => {
                  const result = await call(main, 'session', {
                    action: 'close',
                    session_handle: handle,
                    ...(handle === consultHandle ? {} : { delete_history: true }),
                  });
                  if (result.isError || !resultText(result).includes('closed successfully'))
                    throw new Error(`close failed: ${resultText(result).slice(0, 300)}`);
                };
                const historyEvents = async handle => {
                  const page = await call(main, 'session', { action: 'history', session_handle: handle, limit: 1 });
                  return page.isError ? { error: resultText(page) } : { events: page.structuredContent?.events || [] };
                };
                await closeResult(consultHandle);
                const closed = await call(main, 'consult', { ...modelArgs, session_handle: consultHandle, proposal: 'Reply with OK.' });
                if (!closed.isError || !resultText(closed).includes('SESSION_INVALID'))
                  throw new Error('a closed session accepted a turn.');
                const kept = await historyEvents(consultHandle);
                if (kept.error || !kept.events.length) throw new Error(`the closed session lost its history: ${kept.error || 'no events'}`);
                const disposable = await call(main, 'consult', { ...modelArgs, proposal: 'Reply with OK.' });
                const handle = footer(resultText(disposable)).handle;
                if (disposable.isError || !handle) throw new Error('could not create a disposable session.');
                const before = await historyEvents(handle);
                if (before.error || !before.events.length)
                  throw new Error(`the disposable session has no readable history: ${before.error || 'no events'}`);
                await closeResult(handle);
                // Only the documented missing-history answer proves the deletion; any other error does not.
                const gone = await historyEvents(handle);
                if (!gone.error || !gone.error.includes('History not found'))
                  throw new Error(`delete_history kept the history: ${gone.error || `${gone.events.length} events`}`);
                return { details: 'closed session refused with SESSION_INVALID and kept history; delete_history removed it' };
              },
        );
      }
    }

    await record('n2_quiet', 'N2: quiet execution (no console window)', null, async () => {
      throw new NotRun('a console window cannot be observed headless; the owner checks it in the UI steps.');
    });
  } finally {
    await main.close();
  }
}

module.exports = { runScenarios, chooseModel, NotRun };
