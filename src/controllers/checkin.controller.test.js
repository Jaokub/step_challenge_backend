import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const applyPoints = vi.fn();
vi.mock('../services/pointsLedger.service.js', () => ({ applyPoints: (...args) => applyPoints(...args) }));

const { cancelCheckIn } = await import('./checkin.controller.js');

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const FUTURE_ACTIVITY = { id: 'act1', title: 'Morning Walk', startDate: new Date('2099-01-01'), points: 100, status: 'UPCOMING' };

describe('checkin.controller.cancelCheckIn — cancel-before-award vs cancel-after-award (ADR-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.checkIn.delete.mockResolvedValue({});
  });

  it('cancel-before-award (step-gated, unpaid): deletes the check-in but reverses NO points', async () => {
    mockPrisma.checkIn.findUnique.mockResolvedValue({
      id: 'ci1',
      userId: 'user-1',
      pointsAwardedAt: null, // never paid — goal wasn't reached yet
      activity: FUTURE_ACTIVITY,
    });

    const req = { params: { id: 'ci1' }, user: { id: 'user-1', role: 'STAFF' } };
    const res = mockRes();
    await cancelCheckIn(req, res);

    expect(applyPoints).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('cancel-after-award (points already paid): reverses points dated to the AWARD day, not the check-in day', async () => {
    const awardDay = new Date('2026-07-15T00:00:00.000Z'); // fired days after check-in
    mockPrisma.checkIn.findUnique.mockResolvedValue({
      id: 'ci1',
      userId: 'user-1',
      pointsAwardedAt: awardDay,
      activity: FUTURE_ACTIVITY,
    });

    const req = { params: { id: 'ci1' }, user: { id: 'user-1', role: 'STAFF' } };
    const res = mockRes();
    await cancelCheckIn(req, res);

    expect(applyPoints).toHaveBeenCalledTimes(1);
    const [, entry] = applyPoints.mock.calls[0];
    expect(entry.amount).toBe(-100);
    expect(entry.reason).toBe('CHECKIN_CANCELLED');
    // The regression this guards: a blind reversal dated to checkedInAt
    // instead of pointsAwardedAt would leave a step-gated cancel's ledger
    // entry on the wrong day, so period-windowed leaderboards wouldn't net
    // to zero. thaiDayTag(awardDay) is what actually gets passed.
    expect(entry.effectiveDate.getTime()).not.toBe(new Date('2099-01-01').getTime());
  });

  it('attendance-only unchanged: pointsAwardedAt ≈ checkedInAt, so cancelling still reverses the full amount', async () => {
    const checkedInAt = new Date('2026-07-10T08:00:00.000Z');
    mockPrisma.checkIn.findUnique.mockResolvedValue({
      id: 'ci1',
      userId: 'user-1',
      pointsAwardedAt: checkedInAt, // attendance-only: paid immediately at check-in
      activity: { ...FUTURE_ACTIVITY, points: 50 },
    });

    const req = { params: { id: 'ci1' }, user: { id: 'user-1', role: 'STAFF' } };
    const res = mockRes();
    await cancelCheckIn(req, res);

    expect(applyPoints).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({ amount: -50, reason: 'CHECKIN_CANCELLED' })
    );
  });

  it('rejects a self-cancel once the activity has already started (time-window guard, unrelated to award state)', async () => {
    mockPrisma.checkIn.findUnique.mockResolvedValue({
      id: 'ci1',
      userId: 'user-1',
      pointsAwardedAt: null,
      activity: { ...FUTURE_ACTIVITY, startDate: new Date('2020-01-01') }, // already started
    });

    const req = { params: { id: 'ci1' }, user: { id: 'user-1', role: 'STAFF' } };
    const res = mockRes();
    await cancelCheckIn(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(applyPoints).not.toHaveBeenCalled();
  });

  it('an admin can cancel someone else\'s check-in and points are reversed on the OWNER, not the admin', async () => {
    mockPrisma.checkIn.findUnique.mockResolvedValue({
      id: 'ci1',
      userId: 'owner-user',
      pointsAwardedAt: new Date('2026-07-10T08:00:00.000Z'),
      activity: { ...FUTURE_ACTIVITY, startDate: new Date('2020-01-01'), points: 75 }, // already started, admin override
    });

    const req = { params: { id: 'ci1' }, user: { id: 'admin-user', role: 'ADMIN' } };
    const res = mockRes();
    await cancelCheckIn(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(applyPoints).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({ userId: 'owner-user', amount: -75 })
    );
  });
});
