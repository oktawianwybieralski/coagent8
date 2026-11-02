const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseAcl, aclReachesFolder, unreachableWriteFolder } = require('../../../src/backends/codex/windows-acl.ts');

// #127: icacls output of a workspace that works and of a folder that stays closed, both observed.
const WORKSPACE = `C:\\repo S-1-5-21-1-2-3-4:(OI)(CI)(M)
        HOST\\CodexSandboxUsers:(OI)(CI)(RX)
        NT AUTHORITY\\SYSTEM:(OI)(CI)(F)
        HOST\\Owner:(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files`;
const CLOSED = `C:\\repo\\docs\\.local HOST\\CodexSandboxUsers:(OI)(CI)(RX)
        NT AUTHORITY\\SYSTEM:(OI)(CI)(F)
        HOST\\Owner:(OI)(CI)(F)`;
const INHERITING = `C:\\repo\\src S-1-5-21-1-2-3-4:(I)(OI)(CI)(M)
        HOST\\Owner:(I)(OI)(CI)(F)`;
const OWN_ENTRY = `C:\\repo\\own S-1-5-21-1-2-3-4:(OI)(CI)(M)
        HOST\\Owner:(OI)(CI)(F)`;

test('icacls entries are read with their inheritance and write rights', () => {
  const entries = parseAcl(WORKSPACE, 'C:\\repo');
  assert.deepEqual(
    entries.map(e => [e.name, e.inherited, e.writes]),
    [
      ['S-1-5-21-1-2-3-4', false, true],
      ['CodexSandboxUsers', false, false],
      ['SYSTEM', false, true],
      ['Owner', false, true],
    ],
  );
  assert.equal(parseAcl(INHERITING, 'C:\\repo\\src')[0].inherited, true);
});

test('a folder is reached by inheritance or its own sandbox entry, not by the owner having rights', () => {
  const workspace = parseAcl(WORKSPACE, 'C:\\repo');
  assert.equal(aclReachesFolder(workspace, parseAcl(CLOSED, 'C:\\repo\\docs\\.local')), false);
  assert.equal(aclReachesFolder(workspace, parseAcl(INHERITING, 'C:\\repo\\src')), true);
  assert.equal(aclReachesFolder(workspace, parseAcl(OWN_ENTRY, 'C:\\repo\\own')), true);
});

test(
  'a real folder that does not inherit is found on the way to a scope',
  { skip: process.platform === 'win32' ? false : 'Windows ACLs' },
  async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-acl-'));
    const closed = path.join(cwd, 'open', 'closed');
    fs.mkdirSync(path.join(closed, 'deep'), { recursive: true });
    try {
      assert.equal(await unreachableWriteFolder(cwd, []), undefined, 'no scope, nothing to walk');
      assert.equal(await unreachableWriteFolder(cwd, ['open/closed/deep']), undefined, 'all inherited');
      assert.equal(await unreachableWriteFolder(cwd, ['missing/folder']), undefined);
      assert.deepEqual(parseAcl('Unrecognized output', 'x'), [], 'read by the caller as inconclusive');
      assert.deepEqual(parseAcl('x HOST\\A:(OI)(M)\n  HOST\\B:(I)(???)', 'x'), [], 'a line it cannot read makes the whole answer unclear');
      assert.equal(parseAcl('x HOST\\A:(I)(Rc,S,X,RA)', 'x')[0].inherited, true, 'mixed-case special rights');
      const user = process.env.USERNAME;
      const ran = spawnSync('icacls', [closed, '/inheritance:r', '/grant', `${user}:(OI)(CI)F`], { windowsHide: true });
      assert.equal(ran.status, 0);
      assert.equal(await unreachableWriteFolder(cwd, ['open/closed/deep']), closed);
      spawnSync('icacls', [closed, '/inheritance:e'], { windowsHide: true });
      assert.equal(await unreachableWriteFolder(cwd, ['open/closed/deep']), undefined, 'the command the refusal names restores it');
    } finally {
      spawnSync('icacls', [cwd, '/reset', '/T', '/C'], { windowsHide: true });
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);
