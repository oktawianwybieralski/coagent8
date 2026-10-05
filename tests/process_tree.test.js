const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWindowsFileTime,
  parseProcessSnapshot,
  selectOwnedTree,
} = require('../src/execution/process-tree.ts');

test('WINDOWS-001: parseWindowsFileTime correctly converts 64-bit FILETIME strings without rounding', () => {
  // Epoch test: 1970-01-01 00:00:00 UTC = 116444736000000000 FILETIME ticks
  assert.equal(parseWindowsFileTime('116444736000000000'), 0);

  // 1 second after Unix epoch = 1,000,000 microseconds
  assert.equal(parseWindowsFileTime('116444736010000000'), 1_000_000);

  // Realistic modern Windows FILETIME (~1.34e17)
  // 133728000000000000 ticks = (133728000000000000 - 116444736000000000) / 10 = 1728326400000000 µs
  const modernFileTime = '133728000000000000';
  const expectedUs = 1728326400000000;
  assert.equal(parseWindowsFileTime(modernFileTime), expectedUs);

  // Invalid inputs return null
  assert.equal(parseWindowsFileTime(''), null);
  assert.equal(parseWindowsFileTime('abc'), null);
  assert.equal(parseWindowsFileTime('1000'), null); // Before Unix epoch
  assert.equal(parseWindowsFileTime('   '), null);
});

test('WINDOWS-001: parseProcessSnapshot extracts snapshotAt and valid ProcessRows', () => {
  const output = [
    '# SNAPSHOT_AT 133728000000000000',
    '4 0 116444736000000000', // System idle (PID <= 4) - should be skipped
    '1000 500 133728000000000000',
    '2000 1000 133728000001000000',
    'invalid row here',
    '3000 2000 not-a-number',
  ].join('\r\n');

  const { snapshotAt, rows } = parseProcessSnapshot(output);
  assert.equal(snapshotAt, 1728326400000000);
  assert.equal(rows.length, 2);

  assert.deepEqual(rows[0], {
    pid: 1000,
    ppid: 500,
    created: 1728326400000000,
  });

  assert.deepEqual(rows[1], {
    pid: 2000,
    ppid: 1000,
    created: 1728326400100000,
  });
});

test('WINDOWS-001: selectOwnedTree correctly selects multi-tier descendant hierarchy', () => {
  const snapshotAt = 5000;
  const known = [{ pid: 100, created: 1000 }];

  const rows = [
    { pid: 100, ppid: 50, created: 1000 },  // Root
    { pid: 200, ppid: 100, created: 1100 }, // Child of root
    { pid: 300, ppid: 200, created: 1200 }, // Grandchild of root
    { pid: 400, ppid: 999, created: 1050 }, // Unrelated process
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  const pids = selected.map(r => r.pid).sort();
  assert.deepEqual(pids, [100, 200, 300]);
});

test('WINDOWS-001: selectOwnedTree accepts parent and child with equal creation timestamps', () => {
  const snapshotAt = 5000;
  const known = [{ pid: 100, created: 1000 }];

  // Parent and child created in the exact same kernel clock tick
  const rows = [
    { pid: 100, ppid: 50, created: 1000 },
    { pid: 200, ppid: 100, created: 1000 },
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  assert.equal(selected.length, 2);
  assert.ok(selected.some(r => r.pid === 200));
});

test('WINDOWS-001: selectOwnedTree rejects child created strictly before parent (stale PPID reuse)', () => {
  const snapshotAt = 5000;
  const known = [{ pid: 100, created: 1000 }];

  // Child claims PPID 100, but was created before parent 100 existed
  const rows = [
    { pid: 100, ppid: 50, created: 1000 },
    { pid: 200, ppid: 100, created: 900 },
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].pid, 100);
});

test('WINDOWS-001: selectOwnedTree selects orphaned grandchild when intermediate process already exited', () => {
  const snapshotAt = 5000;
  // Intermediate child (PID 200, created 1100) exited before this snapshot; recorded with goneBy = 3000
  const known = [
    { pid: 100, created: 1000 },
    { pid: 200, created: 1100, goneBy: 3000 },
  ];

  const rows = [
    { pid: 100, ppid: 50, created: 1000 },  // Root alive
    // PID 200 is dead (not in rows)
    { pid: 300, ppid: 200, created: 1500 }, // Grandchild spawned by PID 200 before its death
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  const pids = selected.map(r => r.pid).sort();
  assert.deepEqual(pids, [100, 300]);
});

test('WINDOWS-001: selectOwnedTree rejects child attributed to recycled PID of a dead ancestor', () => {
  const snapshotAt = 6000;
  // Intermediate child (PID 200, created 1100) exited at goneBy = 2000
  const known = [
    { pid: 100, created: 1000 },
    { pid: 200, created: 1100, goneBy: 2000 },
  ];

  // PID 200 was recycled by an unrelated process X (created 3000), which then spawned Y (created 3500)
  const rows = [
    { pid: 100, ppid: 50, created: 1000 },
    { pid: 200, ppid: 888, created: 3000 }, // Unrelated process X
    { pid: 300, ppid: 200, created: 3500 }, // Child Y of unrelated process X
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  // Only root 100 should be selected. Process 200 (created 3000) and 300 must not be selected!
  assert.equal(selected.length, 1);
  assert.equal(selected[0].pid, 100);
});

test('WINDOWS-001: selectOwnedTree rejects child created after dead ancestor goneBy', () => {
  const snapshotAt = 5000;
  const known = [
    { pid: 100, created: 1000 },
    { pid: 200, created: 1100, goneBy: 2000 },
  ];

  // Process claims PPID 200 created at 2500, which is after goneBy (2000)
  const rows = [
    { pid: 100, ppid: 50, created: 1000 },
    { pid: 300, ppid: 200, created: 2500 },
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].pid, 100);
});

test('WINDOWS-001: selectOwnedTree terminates safely on cyclical PPID graphs', () => {
  const snapshotAt = 5000;
  const known = [{ pid: 10, created: 1000 }];

  // Cycle: 10 -> 20 -> 10
  const rows = [
    { pid: 10, ppid: 20, created: 1000 },
    { pid: 20, ppid: 10, created: 1100 },
  ];

  const selected = selectOwnedTree(rows, known, snapshotAt);
  assert.equal(selected.length, 2);
});
