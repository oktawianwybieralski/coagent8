const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// WINDOWS-001a: with the server alive, cancel a fixture agy turn whose owned tree includes a
// native descendant, and observe only that tree. The descendant reports through a heartbeat
// file; nothing is selected or signalled by PID. It exits on its own when asked to or after 20 s.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-descendant-'));
process.env.coagent8_DIR = tempDir;
process.env.GEMINI_CLI_HOME = path.join(tempDir, 'agy-home');
process.env.AGY_PATH = path.resolve(__dirname, '../fixtures/agy-cli/agy.cjs');
const { execute } = require('../../src/backends/agy/adapter.ts');
const { activeProcesses } = require('../../src/execution/process.ts');
const MODEL = 'gemini-3.8-flash-high';

const heartbeat = marker => {
  try {
    return Number(fs.readFileSync(marker, 'utf8')) || 0;
  } catch {
    return 0;
  }
};

/** Whether the descendant still advances its heartbeat after the cancelled turn returned. */
async function observeDescendant(marker) {
  const before = heartbeat(marker);
  await delay(500);
  return heartbeat(marker) > before;
}

/** Asks a surviving descendant to exit and waits for its own exit record (at most 20 s). */
async function stopDescendant(marker) {
  fs.writeFileSync(`${marker}.stop`, '1');
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(`${marker}.exited`) && Date.now() < deadline) {
    const before = heartbeat(marker);
    await delay(200);
    if (!fs.existsSync(`${marker}.exited`) && heartbeat(marker) === before) break; // terminated with its tree
  }
}

const cases = [
  // A descendant inside the root's own kill-on-close job (Windows) or process group (POSIX).
  { name: 'in the root job or group', descendant: 'job-member', todo: false },
  // Windows only: a native, non-libuv root has no such job, so its child is outside any job.
  {
    name: 'outside any job (native root model)',
    descendant: 'outside-job',
    win32Only: true,
    todo: 'WINDOWS-001a REPRODUCED: proc.kill() ends only the owned root; containment is WINDOWS-001b-e',
  },
];

for (const scenario of cases) {
  test(
    `cancelling an agy turn ends its native descendant ${scenario.name} (WINDOWS-001a)`,
    {
      skip: scenario.win32Only && process.platform !== 'win32' ? 'Windows job model only' : false,
      todo: process.platform === 'win32' ? scenario.todo : false,
    },
    async t => {
      const marker = path.join(tempDir, `heartbeat-${scenario.descendant}`);
      process.env.coagent8_FIXTURE_MODE = 'native-descendant';
      process.env.coagent8_FIXTURE_MARKER = marker;
      process.env.coagent8_FIXTURE_DESCENDANT = scenario.descendant;
      t.after(async () => {
        delete process.env.coagent8_FIXTURE_MODE;
        delete process.env.coagent8_FIXTURE_MARKER;
        delete process.env.coagent8_FIXTURE_DESCENDANT;
        await stopDescendant(marker);
      });
      const controller = new AbortController();
      const result = await execute('request', {
        model: MODEL,
        cwd: tempDir,
        timeoutMs: 15000,
        abortSignal: controller.signal,
        onEvent: event => {
          if (event.type === 'assistant_delta' && /descendant running/.test(event.text)) controller.abort();
        },
      });
      assert.equal(result.status, 'cancelled', JSON.stringify(result));
      assert.equal(activeProcesses.size, 0, 'the owned root was released');
      assert.ok(heartbeat(marker) > 0, 'the descendant was running before the cancellation');
      const survived = await observeDescendant(marker);
      t.diagnostic(
        `WINDOWS-001a observation: platform=${process.platform} node=${process.version} descendant=${scenario.descendant} survivedCancel=${survived}`,
      );
      assert.equal(survived, false, 'the native descendant of a cancelled turn must not keep running');
    },
  );
}

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
