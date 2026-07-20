import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const applyPoints = vi.fn();
vi.mock('./pointsLedger.service.js', () => ({ applyPoints: (...args) => applyPoints(...args) }));

const { dailyMaxSteps, computeEventSteps, evaluateActivityAward, evaluateActivityAwardsForDate } =
  await import('./activityAward.service.js');

const day = (s) => new Date(`${s}T00:00:00.000Z`);

describe('activityAward.service — ADR-001 step-gated points (BUILD_PLAN Phase 6A LOW priority)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('dailyMaxSteps — multi-source baseline', () => {
    it('takes the MAX across sources for a day, never the sum (no double-counting)', async () => {
      mockPrisma.healthRecord.findMany.mockResolvedValue([
        { steps: 3000 }, // e.g. GOOGLE_HEALTH
        { steps: 5000 }, // e.g. APPLE_HEALTH (same day, different source)
        { steps: 1000 }, // e.g. MANUAL
      ]);
      const result = await dailyMaxSteps(mockPrisma, 'u1', day('2026-07-10'));
      expect(result).toBe(5000); // not 9000
    });

    it('returns 0 when there is no record at all for that day', async () => {
      mockPrisma.healthRecord.findMany.mockResolvedValue([]);
      const result = await dailyMaxSteps(mockPrisma, 'u1', day('2026-07-10'));
      expect(result).toBe(0);
    });
  });

  describe('computeEventSteps — baseline-delta (D4)', () => {
    it('multi-day: check-in-day delta plus full totals for every later day', async () => {
      // Checked in on day 1 with a baseline of 2000 steps already walked.
      // Day 1 ends at 6000 (max across sources) -> delta = 4000.
      // Day 2 and Day 3 are AFTER check-in, so they count in full (maxed
      // across sources per day, not summed).
      mockPrisma.healthRecord.findMany.mockResolvedValue([
        { recordDate: day('2026-07-10'), steps: 6000 }, // GOOGLE_HEALTH, check-in day
        { recordDate: day('2026-07-10'), steps: 5500 }, // APPLE_HEALTH, same day — must not double count
        { recordDate: day('2026-07-11'), steps: 3000 },
        { recordDate: day('2026-07-12'), steps: 4000 },
      ]);

      const checkIn = { userId: 'u1', checkedInAt: new Date('2026-07-10T09:00:00.000Z'), stepsAtCheckIn: 2000 };
      const activity = { endDate: new Date('2026-07-15T00:00:00.000Z') };

      // Freeze "today" to 2026-07-12 so the window resolves deterministically
      // regardless of when the suite actually runs.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));

      const total = await computeEventSteps(mockPrisma, checkIn, activity);
      vi.useRealTimers();

      // (6000 - 2000) + 3000 + 4000 = 11000
      expect(total).toBe(11000);
    });

    it('no record at all on the check-in day still yields a sane (non-negative) result', async () => {
      mockPrisma.healthRecord.findMany.mockResolvedValue([
        { recordDate: day('2026-07-11'), steps: 1000 }, // only a later day has data
      ]);
      const checkIn = { userId: 'u1', checkedInAt: new Date('2026-07-10T09:00:00.000Z'), stepsAtCheckIn: 2000 };
      const activity = { endDate: new Date('2026-07-15T00:00:00.000Z') };

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
      const total = await computeEventSteps(mockPrisma, checkIn, activity);
      vi.useRealTimers();

      // checkInDayMax (0) - baseline (2000) clamped to 0, plus day-2's 1000.
      expect(total).toBe(1000);
    });

    it('a null stepsAtCheckIn baseline is treated as 0, not a crash', async () => {
      mockPrisma.healthRecord.findMany.mockResolvedValue([{ recordDate: day('2026-07-10'), steps: 500 }]);
      const checkIn = { userId: 'u1', checkedInAt: new Date('2026-07-10T09:00:00.000Z'), stepsAtCheckIn: null };
      const activity = { endDate: new Date('2026-07-15T00:00:00.000Z') };

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
      const total = await computeEventSteps(mockPrisma, checkIn, activity);
      vi.useRealTimers();

      expect(total).toBe(500);
    });

    it('stops counting at the activity end date, not "today", when the activity has already ended', async () => {
      // A real DB query would never return the 07-12 row given the gte/lte
      // window asserted below — the mock mirrors that (Postgres, not this
      // function, does the actual filtering); the row is a canary proving
      // the window bound is correct, not something the function must
      // defensively filter out of an already-correct result set itself.
      mockPrisma.healthRecord.findMany.mockResolvedValue([
        { recordDate: day('2026-07-10'), steps: 1000 },
        { recordDate: day('2026-07-11'), steps: 2000 }, // activity's last day
      ]);
      const checkIn = { userId: 'u1', checkedInAt: new Date('2026-07-10T09:00:00.000Z'), stepsAtCheckIn: 0 };
      // 09:00 UTC is well before the 17:00 UTC Thai-midnight rollover, so
      // thaiDayTag(endDate) stays July 11, not July 12.
      const activity = { endDate: new Date('2026-07-11T09:00:00.000Z') };

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z')); // "today" is after the activity ended
      const total = await computeEventSteps(mockPrisma, checkIn, activity);
      vi.useRealTimers();

      // The query window itself (gte/lte passed to findMany) should have
      // stopped at the activity's end day, not today.
      const queryArg = mockPrisma.healthRecord.findMany.mock.calls[0][0].where.recordDate;
      expect(queryArg.lte.getTime()).toBe(day('2026-07-11').getTime());
      expect(total).toBe(3000); // 1000 + 2000
    });
  });

  describe('evaluateActivityAward — idempotency & award-once', () => {
    const unpaidCheckIn = { id: 'ci1', pointsAwardedAt: null, stepsAtCheckIn: 0, checkedInAt: day('2026-07-10') };
    const activity = { id: 'act1', expectedSteps: 5000, points: 100, endDate: day('2026-07-20') };

    it('awards once when the goal is met and the concurrency gate wins', async () => {
      mockPrisma.checkIn.findUnique.mockResolvedValue(unpaidCheckIn);
      mockPrisma.activity.findUnique.mockResolvedValue(activity);
      mockPrisma.healthRecord.findMany.mockResolvedValue([{ recordDate: day('2026-07-10'), steps: 6000 }]);
      mockPrisma.checkIn.updateMany.mockResolvedValue({ count: 1 }); // this caller wins the race

      // Pass a non-root client (no $transaction) to exercise the direct path.
      const client = { ...mockPrisma };
      delete client.$transaction;
      const result = await evaluateActivityAward('u1', 'act1', client);

      expect(result).toEqual({ awarded: true });
      expect(applyPoints).toHaveBeenCalledTimes(1);
      expect(applyPoints).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ userId: 'u1', amount: 100, reason: 'ACTIVITY_CHECKIN', refId: 'act1' })
      );
    });

    it('does not double-pay when a concurrent evaluator already won the gate (updateMany count 0)', async () => {
      mockPrisma.checkIn.findUnique.mockResolvedValue(unpaidCheckIn);
      mockPrisma.activity.findUnique.mockResolvedValue(activity);
      mockPrisma.healthRecord.findMany.mockResolvedValue([{ recordDate: day('2026-07-10'), steps: 6000 }]);
      mockPrisma.checkIn.updateMany.mockResolvedValue({ count: 0 }); // a concurrent caller won instead

      const client = { ...mockPrisma };
      delete client.$transaction;
      const result = await evaluateActivityAward('u1', 'act1', client);

      expect(result).toEqual({ awarded: false });
      expect(applyPoints).not.toHaveBeenCalled();
    });

    it('no-ops if the check-in is already paid (pointsAwardedAt already set)', async () => {
      mockPrisma.checkIn.findUnique.mockResolvedValue({ ...unpaidCheckIn, pointsAwardedAt: new Date() });
      const client = { ...mockPrisma };
      delete client.$transaction;

      const result = await evaluateActivityAward('u1', 'act1', client);
      expect(result).toEqual({ awarded: false });
      expect(mockPrisma.activity.findUnique).not.toHaveBeenCalled();
      expect(applyPoints).not.toHaveBeenCalled();
    });

    it('no-ops if the step delta has not reached expectedSteps yet', async () => {
      mockPrisma.checkIn.findUnique.mockResolvedValue(unpaidCheckIn);
      mockPrisma.activity.findUnique.mockResolvedValue(activity); // needs 5000
      mockPrisma.healthRecord.findMany.mockResolvedValue([{ recordDate: day('2026-07-10'), steps: 1000 }]); // only 1000

      const client = { ...mockPrisma };
      delete client.$transaction;
      const result = await evaluateActivityAward('u1', 'act1', client);

      expect(result).toEqual({ awarded: false });
      expect(mockPrisma.checkIn.updateMany).not.toHaveBeenCalled();
      expect(applyPoints).not.toHaveBeenCalled();
    });

    it('no-ops for an attendance-only activity (expectedSteps null) — this module is never involved for that path', async () => {
      mockPrisma.checkIn.findUnique.mockResolvedValue(unpaidCheckIn);
      mockPrisma.activity.findUnique.mockResolvedValue({ ...activity, expectedSteps: null });

      const client = { ...mockPrisma };
      delete client.$transaction;
      const result = await evaluateActivityAward('u1', 'act1', client);

      expect(result).toEqual({ awarded: false });
      expect(applyPoints).not.toHaveBeenCalled();
    });
  });

  describe('evaluateActivityAwardsForDate', () => {
    it('only evaluates unpaid step-gated check-ins whose activity window contains the given date', async () => {
      mockPrisma.checkIn.findMany.mockResolvedValue([
        {
          activityId: 'in-window',
          activity: { startDate: day('2026-07-01'), endDate: day('2026-07-31') },
        },
        {
          activityId: 'out-of-window',
          activity: { startDate: day('2026-08-01'), endDate: day('2026-08-31') },
        },
      ]);
      // Only 'in-window' should trigger a checkIn.findUnique lookup inside evaluateActivityAward.
      mockPrisma.checkIn.findUnique.mockResolvedValue(null); // short-circuits evaluateActivityAward cheaply

      const client = { ...mockPrisma };
      delete client.$transaction;
      await evaluateActivityAwardsForDate('u1', day('2026-07-15'), client);

      expect(mockPrisma.checkIn.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.checkIn.findUnique).toHaveBeenCalledWith({
        where: { userId_activityId: { userId: 'u1', activityId: 'in-window' } },
      });
    });

    it('returns the ids that were actually newly awarded', async () => {
      mockPrisma.checkIn.findMany.mockResolvedValue([
        { activityId: 'act1', activity: { startDate: day('2026-07-01'), endDate: day('2026-07-31') } },
      ]);
      mockPrisma.checkIn.findUnique.mockResolvedValue({
        id: 'ci1',
        pointsAwardedAt: null,
        stepsAtCheckIn: 0,
        checkedInAt: day('2026-07-10'),
      });
      mockPrisma.activity.findUnique.mockResolvedValue({
        id: 'act1',
        expectedSteps: 100,
        points: 50,
        endDate: day('2026-07-31'),
      });
      mockPrisma.healthRecord.findMany.mockResolvedValue([{ recordDate: day('2026-07-10'), steps: 500 }]);
      mockPrisma.checkIn.updateMany.mockResolvedValue({ count: 1 });

      const client = { ...mockPrisma };
      delete client.$transaction;
      const awardedIds = await evaluateActivityAwardsForDate('u1', day('2026-07-15'), client);

      expect(awardedIds).toEqual(['act1']);
    });
  });
});
