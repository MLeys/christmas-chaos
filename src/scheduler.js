'use strict';
/**
 * Cancellable, keyed timers with generation tokens.
 *
 *   const s = createScheduler();
 *   s.after('spin', 5000, () => land());   // re-using a key cancels the previous timer with that key
 *   s.cancel('spin');
 *   s.bump();                               // cancel EVERYTHING and invalidate callbacks already queued
 *
 * A callback only runs if the scheduler generation is unchanged since it was scheduled, so a stale
 * timer can never fire into a new game / turn even if clearTimeout raced with the event loop.
 *
 * createFakeClock() gives tests a deterministic clock: now(), setTimeout/clearTimeout and advance(ms).
 */

function createScheduler(opts = {}) {
  const st = opts.setTimeout || setTimeout;
  const ct = opts.clearTimeout || clearTimeout;
  let generation = 0;
  const handles = new Map(); // key -> { h, gen }

  function cancel(key) {
    const e = handles.get(key);
    if (e) { ct(e.h); handles.delete(key); }
  }
  function cancelAll() {
    for (const e of handles.values()) ct(e.h);
    handles.clear();
  }
  function after(key, ms, fn) {
    cancel(key);
    const gen = generation;
    const entry = { gen, h: null };
    entry.h = st(() => {
      if (handles.get(key) === entry) handles.delete(key);
      if (gen !== generation) return; // stale
      try { fn(); } catch (err) { if (opts.onError) opts.onError(err); else console.error('[scheduler]', err); }
    }, Math.max(0, Number(ms) || 0));
    if (entry.h && typeof entry.h.unref === 'function' && opts.unref) entry.h.unref();
    handles.set(key, entry);
    return key;
  }
  function bump() { generation++; cancelAll(); return generation; }
  return {
    after, cancel, cancelAll, bump,
    has: (key) => handles.has(key),
    pending: () => [...handles.keys()],
    get generation() { return generation; },
  };
}

/** Deterministic clock for tests. */
function createFakeClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map(); // id -> {at, fn, seq}
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms | 0), fn, seq: id }); return id; },
    clearTimeout(id) { timers.delete(id); },
    /** Advance time, firing due timers in time order (timers scheduled while advancing also fire if due). */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= target && (!next || x.at < next.x.at || (x.at === next.x.at && x.seq < next.x.seq))) next = { id, x };
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.x.at);
        next.x.fn();
      }
      t = target;
    },
    pendingCount: () => timers.size,
  };
}

module.exports = { createScheduler, createFakeClock };
