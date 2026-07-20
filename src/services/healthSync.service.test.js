import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const calculatePointsDelta = vi.fn();
vi.mock('./points.service.js', () => ({
  default: { calculatePointsDelta: (...a) => calculatePointsDelta(...a) },
  calculatePointsDelta: (...a) => calculatePointsDelta(...a),
}));

const calculateCheckInStreak = vi.fn();
vi.mock('./streak.service.js', () => ({
  calculateCheckInStreak: (...a) => calculateCheckInStreak(...a),
  default: { calculateCheckInStreak: (...a) => calculateCheckInStreak(...a) },
}));

const applyPoints = vi.fn();
vi.mock('./pointsLedger.service.js', () => ({
  applyPoints: (...a) => applyPoints(...a),
  default: { applyPoints: (...a) => applyPoints(...a) },
}));

const evaluateActivityAwardsForDate = vi.fn();
vi.mock('./activityAward.service.js', () => ({
  evaluateActivityAwardsForDate: (...a) => evaluateActivityAwardsForDate(...a),
  default: { evaluateActivityAwardsForDate: (...a) => evaluateActivityAwardsForDate(...a) },
}));

const { syncHealthRecord, aggregateByDate, parseHealthNumber } = await import('./healthSync.service.js');

/**
 * Coverage for the health sync write path.
 *
 * This file performs the actual `HealthRecord` upsert and is on the
 * "do not touch without discussion" list in CLAUDE.md — it had zero tests;
 * `health.controller.test.js` only exercised the wrapper around it and mocked
 * the service itself.
 *
 * The case that matters most is the first one: a repeat sync for the same day
 * must REPLACE the day's figures, not add to them. That is the double-counting
 * question left unverified after the Android sync fix on 2026-07-19, and it
 * is now pinned.
 */

const DAY = new Date('2026-07-20T00:00:00.000Z');
// One row per [user, day] — `source` is deliberately NOT part of the key.
const KEY = () => ({ userId_recordDate: { userId: 'u1', recordDate: DAY } });

beforeEach(() => {
  vi.clearAllMocks();
  calculateCheckInStreak.mockResolvedValue(3);
  calculatePointsDelta.mockReturnValue(7);
  applyPoints.mockResolvedValue(undefined);
  evaluateActivityAwardsForDate.mockResolvedValue([]);
  mockPrisma.healthRecord.findUnique.mockResolvedValue(null);
  mockPrisma.healthRecord.upsert.mockImplementation(async (args) => ({ id: 'hr-1', ...args.create }));
  mockPrisma.$transaction.mockImplementation(async (arg) =>
    typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg),
  );
});

describe('syncHealthRecord — repeat sync for the same day', () => {
  it('REPLACES the day\'s steps rather than accumulating them (double-count guard)', async () => {
    // The device already reported 8,000 steps today; it now reports 9,500.
    // The stored value must become 9,500, not 17,500.
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 8000, calories: 300, distanceKm: 6 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 9500 });

    const args = mockPrisma.healthRecord.upsert.mock.calls[0][0];
    expect(args.update.steps).toBe(9500);
    expect(args.update.steps).not.toBe(17500);
  });

  it('accepts a downward correction from the device', async () => {
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 9000, calories: 0, distanceKm: 0 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 4000 });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].update.steps).toBe(4000);
  });

  it('is keyed on [user, day] ONLY — a day can never hold one row per source', async () => {
    // The step-inflation fix: when `source` was part of the key, a day could
    // hold a GOOGLE_HEALTH row and a MANUAL row, and the leaderboard summed
    // them while the award engine took the max.
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 100 });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].where).toEqual(KEY());
    expect(mockPrisma.healthRecord.findUnique).toHaveBeenCalledWith({ where: KEY() });
  });

  it('a second source on the same day UPDATES the existing row instead of adding one', async () => {
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 8000, calories: 0, distanceKm: 0 });

    await syncHealthRecord('u1', DAY, 'MANUAL', { steps: 8200 });

    const args = mockPrisma.healthRecord.upsert.mock.calls[0][0];
    expect(args.where).toEqual(KEY());
    expect(args.update.steps).toBe(8200);
    // Not 16,200 — the two sources are the same walking, reported twice.
    expect(args.update.steps).not.toBe(16200);
  });

  it('records which device last reported the day (last writer wins)', async () => {
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 8000, calories: 0, distanceKm: 0 });

    await syncHealthRecord('u1', DAY, 'MANUAL', { steps: 8200 });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].update.source).toBe('MANUAL');
  });

  it('leaves an omitted metric untouched instead of zeroing it', async () => {
    // A steps-only sync must not wipe the calories the same day already has.
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 100, calories: 250, distanceKm: 2 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 500 });

    const update = mockPrisma.healthRecord.upsert.mock.calls[0][0].update;
    expect(update.steps).toBe(500);
    expect(update.calories).toBeUndefined();
    expect(update.distanceKm).toBeUndefined();
  });

  it('writes explicit zeros on first sync of a day rather than leaving fields undefined', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 1200 });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].create).toMatchObject({
      userId: 'u1',
      recordDate: DAY,
      source: 'GOOGLE_HEALTH',
      steps: 1200,
      calories: 0,
      distanceKm: 0,
      activeMinutes: 0,
    });
  });

  it('treats a genuine 0 as a value, not as "absent"', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 0 });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].update.steps).toBe(0);
  });
});

describe('syncHealthRecord — points delta', () => {
  it('computes the delta from the OLD stored figures to the new ones', async () => {
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 2000, calories: 90, distanceKm: 1.5 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 5000, calories: 200, distanceKm: 4 });

    expect(calculatePointsDelta).toHaveBeenCalledWith(
      { steps: 2000, calories: 90, distanceKm: 1.5 },
      { steps: 5000, calories: 200, distanceKm: 4 },
      3,
    );
  });

  it('treats a first-ever sync as a delta from zero', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 5000 });

    expect(calculatePointsDelta).toHaveBeenCalledWith(
      { steps: 0, calories: 0, distanceKm: 0 },
      expect.objectContaining({ steps: 5000 }),
      3,
    );
  });

  it('carries an omitted metric forward as the old value so it contributes no delta', async () => {
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 100, calories: 250, distanceKm: 2 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 500 });

    const [oldMetrics, newMetrics] = calculatePointsDelta.mock.calls[0];
    expect(oldMetrics.calories).toBe(250);
    expect(newMetrics.calories).toBe(250);
  });

  it('writes the delta to the ledger dated to the record\'s own day, not today', async () => {
    // Backfilling last Tuesday must not credit points to this Tuesday.
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 5000 });

    expect(applyPoints).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({
        userId: 'u1',
        amount: 7,
        reason: 'HEALTH_SYNC',
        effectiveDate: DAY,
        refId: 'GOOGLE_HEALTH',
      }),
    );
  });

  it('reads the streak once, outside the transaction', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 1 });

    expect(calculateCheckInStreak).toHaveBeenCalledTimes(1);
    expect(calculateCheckInStreak).toHaveBeenCalledWith('u1');
  });
});

describe('syncHealthRecord — transaction and award hook', () => {
  it('does the read, the upsert and the ledger write in ONE transaction', async () => {
    // Two concurrent syncs must not both read the same "old" record and
    // double-award the delta.
    const order = [];
    mockPrisma.$transaction.mockImplementation(async (fn) => {
      order.push('tx-open');
      const out = await fn(mockPrisma);
      order.push('tx-commit');
      return out;
    });
    mockPrisma.healthRecord.findUnique.mockImplementation(async () => {
      order.push('read');
      return null;
    });
    mockPrisma.healthRecord.upsert.mockImplementation(async () => {
      order.push('upsert');
      return { id: 'hr-1' };
    });
    applyPoints.mockImplementation(async () => {
      order.push('applyPoints');
    });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 1 });

    expect(order).toEqual(['tx-open', 'read', 'upsert', 'applyPoints', 'tx-commit']);
  });

  it('re-evaluates step-gated activity awards for that day inside the same transaction', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 9000 });

    expect(evaluateActivityAwardsForDate).toHaveBeenCalledWith('u1', DAY, mockPrisma);
  });

  it('returns the newly-awarded activity ids so the client can celebrate without a second request', async () => {
    evaluateActivityAwardsForDate.mockResolvedValue(['act-1', 'act-2']);

    const result = await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 9000 });

    expect(result.awardedActivityIds).toEqual(['act-1', 'act-2']);
  });

  it('returns the upserted record', async () => {
    mockPrisma.healthRecord.upsert.mockResolvedValue({ id: 'hr-9', steps: 9000 });

    const result = await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 9000 });

    expect(result.record).toEqual({ id: 'hr-9', steps: 9000 });
  });

  it('propagates a failure rather than reporting a sync that did not happen', async () => {
    mockPrisma.healthRecord.upsert.mockRejectedValue(new Error('db down'));

    await expect(syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 1 })).rejects.toThrow('db down');
  });
});

describe('aggregateByDate', () => {
  const record = (date, over = {}) => ({
    recordDate: new Date(date),
    steps: 0,
    calories: 0,
    distanceKm: 0,
    activeMinutes: 0,
    ...over,
  });

  it('groups records by calendar day', () => {
    const out = aggregateByDate([
      record('2026-07-20T00:00:00.000Z', { steps: 1000 }),
      record('2026-07-21T00:00:00.000Z', { steps: 2000 }),
    ]);

    expect(Object.keys(out)).toEqual(['2026-07-20', '2026-07-21']);
    expect(out['2026-07-20'].steps).toBe(1000);
  });

  it('no longer has multiple sources to combine — the [user, day] key prevents it', () => {
    // This function used to be handed one row per source per day and summed
    // them, inflating the figure. The unique key now guarantees a single row
    // per day, so the summing below can only ever see one row per date.
    const out = aggregateByDate([
      record('2026-07-20T00:00:00.000Z', { steps: 5000 }),
      record('2026-07-21T00:00:00.000Z', { steps: 6000 }),
    ]);

    expect(out['2026-07-20'].steps).toBe(5000);
    expect(out['2026-07-21'].steps).toBe(6000);
  });

  it('still folds a stray pre-migration duplicate rather than dropping it silently', () => {
    // Defensive only: rows written before the dedupe migration could still
    // exist in a stale environment. Better a visibly-high number than a
    // silently-missing day.
    const out = aggregateByDate([
      record('2026-07-20T00:00:00.000Z', { steps: 5000 }),
      record('2026-07-20T00:00:00.000Z', { steps: 5000 }),
    ]);

    expect(out['2026-07-20'].steps).toBe(10000);
  });

  it('sums every metric, not just steps', () => {
    const out = aggregateByDate([
      record('2026-07-20T00:00:00.000Z', { steps: 1, calories: 10, distanceKm: 0.5, activeMinutes: 4 }),
      record('2026-07-20T00:00:00.000Z', { steps: 2, calories: 20, distanceKm: 1.5, activeMinutes: 6 }),
    ]);

    expect(out['2026-07-20']).toEqual({ steps: 3, calories: 30, distanceKm: 2, activeMinutes: 10 });
  });

  it('treats null metrics as 0 instead of producing NaN', () => {
    const out = aggregateByDate([
      record('2026-07-20T00:00:00.000Z', { steps: null, calories: null, distanceKm: null, activeMinutes: null }),
    ]);

    expect(out['2026-07-20']).toEqual({ steps: 0, calories: 0, distanceKm: 0, activeMinutes: 0 });
  });

  it('returns an empty map for no records', () => {
    expect(aggregateByDate([])).toEqual({});
  });
});

describe('parseHealthNumber', () => {
  it('parses a plain number', () => {
    expect(parseHealthNumber(1234)).toBe(1234);
  });

  it('strips thousands separators from iOS Shortcuts strings', () => {
    expect(parseHealthNumber('12,345')).toBe(12345);
  });

  it('parses a decimal string', () => {
    expect(parseHealthNumber('4.5')).toBe(4.5);
  });

  it('returns undefined for undefined and null, so callers can tell "absent" from 0', () => {
    expect(parseHealthNumber(undefined)).toBeUndefined();
    expect(parseHealthNumber(null)).toBeUndefined();
  });

  it('keeps a genuine 0 as 0, not undefined', () => {
    expect(parseHealthNumber(0)).toBe(0);
  });

  it('returns undefined for junk rather than NaN', () => {
    // This used to return NaN. The `create` branch of the upsert coerced it
    // via `steps || 0`, which made it look harmless — but the `update`
    // branch (every repeat sync of the same day) had no coercion, so NaN
    // reached the HealthRecord write AND the points ledger through
    // calculatePointsDelta.
    expect(parseHealthNumber('abc')).toBeUndefined();
    expect(parseHealthNumber({})).toBeUndefined();
    expect(parseHealthNumber('12abc')).toBeUndefined();
  });

  it('rejects Infinity', () => {
    expect(parseHealthNumber('Infinity')).toBeUndefined();
    expect(parseHealthNumber(-Infinity)).toBeUndefined();
  });

  it('rejects a negative metric — a device reporting one is malfunctioning', () => {
    expect(parseHealthNumber('-500')).toBeUndefined();
    expect(parseHealthNumber(-1)).toBeUndefined();
  });

  it('returns undefined (not 0) for junk, so the stored value is left alone', () => {
    // The distinction matters: undefined means "not reported" and preserves
    // whatever the day already had. Coercing to 0 would WIPE a real figure.
    expect(parseHealthNumber('abc')).toBeUndefined();
    expect(parseHealthNumber('abc')).not.toBe(0);
  });
});

describe('write-path metric sanitising (defence in depth)', () => {
  it('never writes NaN to the database, even on a repeat sync of the same day', async () => {
    // The exact path that used to corrupt data: the day already exists, so
    // the upsert takes its `update` branch, which had no coercion.
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 8000, calories: 0, distanceKm: 0 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: NaN });

    const update = mockPrisma.healthRecord.upsert.mock.calls[0][0].update;
    expect(update.steps).toBeUndefined();
    expect(Number.isNaN(update.steps)).toBe(false);
  });

  it('never feeds NaN into the points delta, which would corrupt the ledger', async () => {
    mockPrisma.healthRecord.findUnique.mockResolvedValue({ steps: 8000, calories: 0, distanceKm: 0 });

    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: NaN });

    const [, newMetrics] = calculatePointsDelta.mock.calls[0];
    expect(Number.isNaN(newMetrics.steps)).toBe(false);
    expect(newMetrics.steps).toBe(8000); // carried forward, unchanged
  });

  it('drops a negative metric instead of writing it', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: -500, calories: 100 });

    const update = mockPrisma.healthRecord.upsert.mock.calls[0][0].update;
    expect(update.steps).toBeUndefined();
    expect(update.calories).toBe(100); // the valid metric still lands
  });

  it('guards the direct sync path too, not just the webhook helper', async () => {
    // POST /health/sync passes its body through after express-validator; the
    // write path does not trust any call site.
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 'not-a-number' });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].update.steps).toBeUndefined();
  });

  it('still accepts a genuine 0', async () => {
    await syncHealthRecord('u1', DAY, 'GOOGLE_HEALTH', { steps: 0 });

    expect(mockPrisma.healthRecord.upsert.mock.calls[0][0].update.steps).toBe(0);
  });
});
