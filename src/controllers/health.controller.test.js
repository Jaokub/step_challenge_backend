import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const syncHealthRecord = vi.fn();
// Only the write path is stubbed. `parseHealthNumber` and `aggregateByDate`
// come through REAL — this used to hand-roll a `parseHealthNumber` stub that
// coerced junk to 0, which is not what the real function does (it returns
// undefined) and meant these tests asserted against a fiction. A stub that
// disagrees with production is worse than no test.
vi.mock('../services/healthSync.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, syncHealthRecord: (...a) => syncHealthRecord(...a) };
});

const { syncHealthData, syncFromWebhook } = await import('./health.controller.js');

const makeRes = () => {
  const res = { statusCode: undefined, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

/**
 * `POST /health/sync` writes `HealthRecord.steps` — the ranking source of
 * truth that every leaderboard in the product aggregates. It was the largest
 * untested surface in the API (flagged as priority #1 in BUILD_PLAN's
 * coverage audit), which matters because its failure modes are silent: a
 * misfiled date puts a day's steps on the wrong leaderboard rather than
 * raising an error.
 *
 * The heavy lifting (upsert, baseline-delta award evaluation) lives in
 * `healthSync.service.js`, which is a "do not touch without discussion" file
 * and is mocked here. What's pinned down is the controller's own contract:
 * date normalisation to the Thai day tag, source validation, and — for the
 * webhook — token authentication.
 */
describe('syncHealthData (POST /health/sync)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncHealthRecord.mockResolvedValue({
      record: { id: 'hr-1', steps: 8421 },
      awardedActivityIds: [],
    });
  });

  const run = async (body) => {
    const res = makeRes();
    await syncHealthData({ body, user: { id: 'user-1' } }, res);
    return res;
  };

  it('400s on an unparseable recordDate instead of writing a bad row', async () => {
    const res = await run({ recordDate: 'not-a-date', source: 'GOOGLE_HEALTH', steps: 100 });

    expect(res.statusCode).toBe(400);
    expect(syncHealthRecord).not.toHaveBeenCalled();
  });

  it('400s on a source outside the enum', async () => {
    // Reaching Prisma with an off-enum value would surface as a 500.
    const res = await run({ recordDate: '2026-07-19', source: 'FITBIT', steps: 100 });

    expect(res.statusCode).toBe(400);
    expect(syncHealthRecord).not.toHaveBeenCalled();
  });

  it('accepts each valid source', async () => {
    for (const source of ['GOOGLE_HEALTH', 'APPLE_HEALTH', 'MANUAL']) {
      vi.clearAllMocks();
      syncHealthRecord.mockResolvedValue({ record: {}, awardedActivityIds: [] });
      const res = await run({ recordDate: '2026-07-19', source, steps: 1 });
      expect(res.statusCode, source).toBe(200);
    }
  });

  it('writes against the authenticated user, never a client-supplied id', async () => {
    // Trusting a body-supplied userId here would let anyone write steps onto
    // someone else's leaderboard entry.
    const res = makeRes();
    await syncHealthData(
      { body: { recordDate: '2026-07-19', source: 'GOOGLE_HEALTH', steps: 500, userId: 'victim' }, user: { id: 'user-1' } },
      res
    );

    expect(syncHealthRecord).toHaveBeenCalledWith('user-1', expect.anything(), 'GOOGLE_HEALTH', expect.anything());
  });

  it('normalises recordDate to a UTC-midnight Thai day tag', async () => {
    await run({ recordDate: '2026-07-19', source: 'GOOGLE_HEALTH', steps: 100 });

    const [, normalizedDate] = syncHealthRecord.mock.calls[0];
    expect(normalizedDate).toBeInstanceOf(Date);
    expect(normalizedDate.getUTCHours()).toBe(0);
    expect(normalizedDate.getUTCMinutes()).toBe(0);
    expect(normalizedDate.getUTCSeconds()).toBe(0);
  });

  it('files a late-evening Bangkok timestamp under that same Thai day', async () => {
    // 2026-07-19T23:30+07:00 is 16:30 UTC on the 19th. A naive UTC-date
    // conversion keeps the 19th here, but the boundary that actually bites is
    // just after midnight — covered next.
    await run({ recordDate: '2026-07-19T23:30:00+07:00', source: 'GOOGLE_HEALTH', steps: 100 });

    const [, normalizedDate] = syncHealthRecord.mock.calls[0];
    expect(normalizedDate.toISOString().slice(0, 10)).toBe('2026-07-19');
  });

  it('files a just-after-midnight Bangkok timestamp under the NEW Thai day', async () => {
    // 2026-07-20T00:30+07:00 is 2026-07-19T17:30 UTC — the previous day in
    // UTC. Tagging by UTC date would file a user's first morning steps under
    // yesterday, quietly corrupting daily leaderboards.
    await run({ recordDate: '2026-07-20T00:30:00+07:00', source: 'GOOGLE_HEALTH', steps: 100 });

    const [, normalizedDate] = syncHealthRecord.mock.calls[0];
    expect(normalizedDate.toISOString().slice(0, 10)).toBe('2026-07-20');
  });

  it('passes awardedActivityIds through to the client', async () => {
    syncHealthRecord.mockResolvedValue({
      record: { id: 'hr-1' },
      awardedActivityIds: ['act-7'],
    });

    const res = await run({ recordDate: '2026-07-19', source: 'GOOGLE_HEALTH', steps: 9000 });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.awardedActivityIds).toEqual(['act-7']);
  });

  it('500s (not a crash) when the sync service throws', async () => {
    syncHealthRecord.mockRejectedValue(new Error('db down'));

    const res = await run({ recordDate: '2026-07-19', source: 'GOOGLE_HEALTH', steps: 100 });

    expect(res.statusCode).toBe(500);
  });
});

/**
 * `POST /health/webhook` is the only PUBLIC write endpoint in the API — no
 * JWT, authenticated solely by a per-user `syncToken` (rate-limited at the
 * route). It writes the same ranking-critical column, so its auth path is
 * worth pinning down explicitly.
 */
describe('syncFromWebhook (public, syncToken-authenticated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncHealthRecord.mockResolvedValue({ record: { id: 'hr-1' }, awardedActivityIds: [] });
  });

  const run = async (body) => {
    const res = makeRes();
    await syncFromWebhook({ body }, res);
    return res;
  };

  it('401s when no syncToken is supplied', async () => {
    const res = await run({ steps: 5000 });

    expect(res.statusCode).toBe(401);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(syncHealthRecord).not.toHaveBeenCalled();
  });

  it('401s on an unrecognised syncToken', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await run({ syncToken: 'guessed', steps: 5000 });

    expect(res.statusCode).toBe(401);
    expect(syncHealthRecord).not.toHaveBeenCalled();
  });

  it('writes for the user the token resolves to', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-42' });

    const res = await run({ syncToken: 'valid-token', steps: 5000 });

    expect(res.statusCode).toBe(200);
    expect(syncHealthRecord).toHaveBeenCalledWith(
      'user-42',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ steps: 5000 })
    );
  });

  it('drops junk and negative metrics instead of writing them', async () => {
    // undefined, NOT 0. `undefined` means "not reported" and leaves whatever
    // the day already had; 0 would overwrite a real figure with zero. This
    // test previously asserted 0 against a hand-rolled stub — the real
    // function has never behaved that way.
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-42' });

    await run({ syncToken: 'valid-token', steps: 'abc', calories: -5 });

    const metrics = syncHealthRecord.mock.calls[0][3];
    expect(metrics.steps).toBeUndefined();
    expect(metrics.calories).toBeUndefined();
  });

  it('passes valid metrics through untouched alongside dropped ones', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-42' });

    await run({ syncToken: 'valid-token', steps: '12,345', calories: 'abc' });

    const metrics = syncHealthRecord.mock.calls[0][3];
    expect(metrics.steps).toBe(12345); // comma-separated iOS Shortcuts value
    expect(metrics.calories).toBeUndefined();
  });

  it('defaults an omitted source to APPLE_HEALTH (the iOS Shortcuts caller)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-42' });

    await run({ syncToken: 'valid-token', steps: 100 });

    expect(syncHealthRecord.mock.calls[0][2]).toBe('APPLE_HEALTH');
  });

  it('KNOWN GAP: does not validate `source` against the enum', async () => {
    // Unlike POST /health/sync, the webhook passes `source` straight through.
    // An off-enum value reaches Prisma and surfaces as a 500 rather than a
    // 400. Documented rather than silently fixed — the endpoint is called by
    // the user's own iOS Shortcut, so the blast radius is small, but it
    // should get the same VALID_SOURCES check. See BUILD_PLAN coverage notes.
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-42' });

    await run({ syncToken: 'valid-token', steps: 100, source: 'FITBIT' });

    expect(syncHealthRecord.mock.calls[0][2]).toBe('FITBIT');
  });
});
