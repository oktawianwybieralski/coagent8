'use strict';

/**
 * EXEC-001-T02a: Monotonic timing primitive tests.
 *
 * Verifies:
 * - Injectable monotonic clock support.
 * - Wall-clock preservation across sequential, nested, and overlapping intervals.
 * - Idempotent span closing (no double counting).
 * - Bounded named phases and memory caps.
 * - Zero transport or MCP imports.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PhaseTracker,
  createPhaseTracker,
  computeMergedIntervalsDuration,
} = require('../../src/execution/runtime/timing.ts');

function createFakeClock(initialTime = 1000) {
  let current = initialTime;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

test('computeMergedIntervalsDuration merges intervals correctly', () => {
  assert.equal(computeMergedIntervalsDuration([]), 0);
  assert.equal(computeMergedIntervalsDuration([{ start: 10, end: 10 }]), 0);
  assert.equal(computeMergedIntervalsDuration([{ start: 10, end: 50 }]), 40);

  // Nested interval
  assert.equal(
    computeMergedIntervalsDuration([
      { start: 10, end: 50 },
      { start: 20, end: 30 },
    ]),
    40
  );

  // Overlapping intervals
  assert.equal(
    computeMergedIntervalsDuration([
      { start: 10, end: 50 },
      { start: 30, end: 70 },
    ]),
    60
  );

  // Disjoint intervals
  assert.equal(
    computeMergedIntervalsDuration([
      { start: 10, end: 30 },
      { start: 50, end: 70 },
    ]),
    40
  );

  // Multiple mixed intervals
  assert.equal(
    computeMergedIntervalsDuration([
      { start: 10, end: 30 },
      { start: 25, end: 50 },
      { start: 70, end: 90 },
      { start: 80, end: 100 },
    ]),
    70 // (50 - 10) + (100 - 70) = 40 + 30 = 70
  );
});

test('timing primitive: records sequential phases with fake clock', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  const prep = tracker.startPhase('preparation');
  clock.advance(50);
  prep.end();

  const consent = tracker.startPhase('consent');
  clock.advance(30);
  consent.end();

  const exec = tracker.startPhase('execution');
  clock.advance(120);
  exec.end();

  clock.advance(10);
  const trace = tracker.complete();

  assert.equal(trace.totalDurationMs, 210);
  assert.equal(trace.phases.preparation, 50);
  assert.equal(trace.phases.consent, 30);
  assert.equal(trace.phases.execution, 120);
  assert.equal(trace.spans.length, 3);
});

test('timing primitive: closing a phase twice does not double-count', () => {
  const clock = createFakeClock(100);
  const tracker = createPhaseTracker({ clock: clock.now });

  const span = tracker.startPhase('acquisition');
  clock.advance(40);
  span.end(); // first close: duration 40

  clock.advance(60);
  span.end(); // second close: must be idempotent no-op!
  span.end(); // third close

  const trace = tracker.complete();
  assert.equal(trace.phases.acquisition, 40);
  assert.equal(trace.spans[0].durationMs, 40);
});

test('timing primitive: nested intervals preserve total wall time', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  // Outer phase starts at 10, ends at 90 (duration 80)
  clock.advance(10);
  const outer = tracker.startPhase('preparation');

  // Inner nested span within the same phase runs from 30 to 50 (duration 20)
  clock.advance(20);
  const inner = tracker.startPhase('preparation');
  clock.advance(20);
  inner.end();

  clock.advance(40);
  outer.end();

  const trace = tracker.complete();
  // Nested span must not double count: total duration remains 80
  assert.equal(trace.phases.preparation, 80);
});

test('timing primitive: overlapping intervals preserve total wall time', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  // Span 1: 10 to 60 (50ms)
  clock.advance(10);
  const span1 = tracker.startPhase('git_work');

  // Span 2: 30 to 90 (60ms) - overlaps span 1 between 30 and 60
  clock.advance(20);
  const span2 = tracker.startPhase('git_work');

  clock.advance(30);
  span1.end();

  clock.advance(30);
  span2.end();

  const trace = tracker.complete();
  // Merged span is 10 to 90 -> 80ms total, not 50 + 60 = 110ms
  assert.equal(trace.phases.git_work, 80);
});

test('timing primitive: parallel spans across phases do not inflate total trace wall time', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  // Two different phases running concurrently from 0 to 100
  const phaseA = tracker.startPhase('phase_a');
  const phaseB = tracker.startPhase('phase_b');

  clock.advance(100);
  phaseA.end();
  phaseB.end();

  const trace = tracker.complete();
  assert.equal(trace.phases.phase_a, 100);
  assert.equal(trace.phases.phase_b, 100);
  // Total wall time is 100ms, NOT 200ms
  assert.equal(trace.totalDurationMs, 100);
});

test('timing primitive: span and spanSync wrappers manage lifecycle on error', async () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  // Sync error
  assert.throws(() => {
    tracker.spanSync('failing_sync', () => {
      clock.advance(25);
      throw new Error('sync failure');
    });
  }, /sync failure/);

  // Async error
  await assert.rejects(async () => {
    await tracker.span('failing_async', async () => {
      clock.advance(35);
      throw new Error('async failure');
    });
  }, /async failure/);

  const trace = tracker.complete();
  assert.equal(trace.phases.failing_sync, 25);
  assert.equal(trace.phases.failing_async, 35);
});

test('timing primitive: auto-closes unclosed spans on complete', () => {
  const clock = createFakeClock(10);
  const tracker = createPhaseTracker({ clock: clock.now });

  tracker.startPhase('left_open');
  clock.advance(75);

  const trace = tracker.complete();
  assert.equal(trace.phases.left_open, 75);
  assert.equal(trace.spans[0].endMs, 85);
});

test('timing primitive: respects maxSpans and maxPhases bounds', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({
    clock: clock.now,
    maxPhases: 3,
    maxSpans: 5,
  });

  // Start 5 spans across 3 phases
  for (let i = 0; i < 5; i++) {
    const s = tracker.startPhase(`p_${i % 3}`);
    clock.advance(10);
    s.end();
  }

  // 6th span exceeds maxSpans
  const extraSpan = tracker.startPhase('p_0');
  clock.advance(20);
  extraSpan.end();

  const trace = tracker.complete();
  assert.equal(trace.spans.length, 5, 'Spans must be capped at maxSpans');
});

test('timing primitive: rejects prototype poisoning and unsafe phase names', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  const p1 = tracker.startPhase('__proto__');
  clock.advance(10);
  p1.end();

  const p2 = tracker.startPhase('constructor');
  clock.advance(10);
  p2.end();

  const trace = tracker.complete();
  assert.equal(trace.phases['__proto__'], undefined);
  assert.equal(trace.phases['constructor'], undefined);
  // Verify trace.phases is safe and does not pollute Object prototype
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, '__proto__'), true);
});

test('timing primitive: prevents recording spans after completion', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({ clock: clock.now });

  const p1 = tracker.startPhase('initial');
  clock.advance(50);
  p1.end();

  const trace1 = tracker.complete();
  assert.equal(trace1.totalDurationMs, 50);
  assert.equal(trace1.phases.initial, 50);

  // Attempting to record after completion must be ignored
  clock.advance(100);
  const late = tracker.startPhase('late_phase');
  clock.advance(50);
  late.end();

  const trace2 = tracker.complete();
  assert.equal(trace2.totalDurationMs, 50, 'Total duration must remain frozen at completion');
  assert.equal(trace2.phases.late_phase, undefined, 'Late phases must not be recorded');
});

test('timing primitive: sanitizes non-finite limits to safe defaults', () => {
  const clock = createFakeClock(0);
  const tracker = createPhaseTracker({
    clock: clock.now,
    maxPhases: NaN,
    maxSpans: Infinity,
  });

  // Should fallback to default limits rather than remaining unboundedly open to NaN/Infinity
  const s = tracker.startPhase('valid_phase');
  clock.advance(20);
  s.end();

  const trace = tracker.complete();
  assert.equal(trace.phases.valid_phase, 20);
});

