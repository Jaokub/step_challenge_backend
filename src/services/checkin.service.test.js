import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const applyPoints = vi.fn();
vi.mock('./pointsLedger.service.js', () => ({
  applyPoints: (...args) => applyPoints(...args),
  default: { applyPoints: (...args) => applyPoints(...args) },
}));

const dailyMaxSteps = vi.fn();
const evaluateActivityAward = vi.fn();
vi.mock('./activityAward.service.js', () => ({
  dailyMaxSteps: (...args) => dailyMaxSteps(...args),
  evaluateActivityAward: (...args) => evaluateActivityAward(...args),
  default: {
    dailyMaxSteps: (...args) => dailyMaxSteps(...args),
    evaluateActivityAward: (...args) => evaluateActivityAward(...args),
  },
}));

const { createCheckIn, CheckInError } = await import('./checkin.service.js');

/**
 * Coverage for `createCheckIn` — the single shared write path that BOTH the
 * QR entry point and the admin manual entry point go through.
 *
 * Why this file matters: it is the most error-prone code in the backend
 * (status guard, duplicate guard, capacity guard, a Serializable transaction,
 * conflict/retry mapping, and the ADR-001 step-gated-vs-attendance-only award
 * branch) and until now it had no tests at all — every controller test that
 * touched check-in mocked it out. The suite's greenness said nothing about
 * any of the guards below.
 */

const ATTENDANCE_ACTIVITY = {
  id: 'act-1',
  status: 'ONGOING',
  points: 50,
  maxParticipants: null,
  expectedSteps: null, // attendance-only (ADR-001 D2)
};

const STEP_GATED_ACTIVITY = {
  ...ATTENDANCE_ACTIVITY,
  id: 'act-2',
  expectedSteps: 5000,
};

const createdRow = (overrides = {}) => ({ id: 'chk-1', userId: 'u1', ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.checkIn.findUnique.mockResolvedValue(null);
  mockPrisma.checkIn.count.mockResolvedValue(0);
  mockPrisma.checkIn.create.mockResolvedValue(createdRow());
  mockPrisma.$transaction.mockImplementation(async (arg) =>
    typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg),
  );
  dailyMaxSteps.mockResolvedValue(1200);
  evaluateActivityAward.mockResolvedValue({ awarded: false });
  applyPoints.mockResolvedValue(undefined);
});

describe('activity status guard', () => {
  it.each(['UPCOMING', 'ONGOING'])('allows check-in while the activity is %s', async (status) => {
    const result = await createCheckIn({
      activity: { ...ATTENDANCE_ACTIVITY, status },
      userId: 'u1',
      method: 'QR',
    });

    expect(result.checkIn).toEqual(createdRow());
  });

  it.each(['COMPLETED', 'CANCELLED'])('refuses check-in once the activity is %s', async (status) => {
    await expect(
      createCheckIn({ activity: { ...ATTENDANCE_ACTIVITY, status }, userId: 'u1', method: 'QR' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    // Rejected before any write is attempted.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.checkIn.create).not.toHaveBeenCalled();
  });

  it('throws a typed CheckInError, so controllers map status codes without string-matching', async () => {
    await expect(
      createCheckIn({
        activity: { ...ATTENDANCE_ACTIVITY, status: 'CANCELLED' },
        userId: 'u1',
        method: 'QR',
      }),
    ).rejects.toBeInstanceOf(CheckInError);
  });
});

describe('duplicate guard', () => {
  it('rejects a second check-in before opening the transaction', async () => {
    mockPrisma.checkIn.findUnique.mockResolvedValue({ id: 'chk-existing' });

    await expect(
      createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('looks the duplicate up on the compound [user, activity] key', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(mockPrisma.checkIn.findUnique).toHaveBeenCalledWith({
      where: { userId_activityId: { userId: 'u1', activityId: 'act-1' } },
    });
  });
});

describe('capacity guard', () => {
  const capped = { ...ATTENDANCE_ACTIVITY, maxParticipants: 10 };

  it('allows the last seat — 9 of 10 taken', async () => {
    mockPrisma.checkIn.count.mockResolvedValue(9);

    await expect(
      createCheckIn({ activity: capped, userId: 'u1', method: 'QR' }),
    ).resolves.toBeTruthy();
  });

  it('rejects at exactly the cap — the guard is >=, not >', async () => {
    mockPrisma.checkIn.count.mockResolvedValue(10);

    await expect(
      createCheckIn({ activity: capped, userId: 'u1', method: 'QR' }),
    ).rejects.toMatchObject({ code: 'FULL' });

    expect(mockPrisma.checkIn.create).not.toHaveBeenCalled();
  });

  it('rejects when somehow already over the cap', async () => {
    mockPrisma.checkIn.count.mockResolvedValue(11);

    await expect(
      createCheckIn({ activity: capped, userId: 'u1', method: 'QR' }),
    ).rejects.toMatchObject({ code: 'FULL' });
  });

  it('treats a null cap as unlimited and skips the count entirely', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(mockPrisma.checkIn.count).not.toHaveBeenCalled();
  });

  it('re-checks capacity INSIDE the transaction, not before it', async () => {
    // This is the whole point of the Serializable wrapper: two concurrent
    // check-ins must not both read the same pre-transaction count and slip
    // past the guard together.
    const order = [];
    mockPrisma.$transaction.mockImplementation(async (fn) => {
      order.push('tx-open');
      return fn(mockPrisma);
    });
    mockPrisma.checkIn.count.mockImplementation(async () => {
      order.push('count');
      return 0;
    });

    await createCheckIn({ activity: capped, userId: 'u1', method: 'QR' });

    expect(order).toEqual(['tx-open', 'count']);
  });

  it('runs the transaction at Serializable isolation', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });
});

describe('database error mapping', () => {
  it('maps a Postgres serialization failure (P2034) to a retryable CONFLICT', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('serialize'), { code: 'P2034' }));

    await expect(
      createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a unique-constraint race (P2002) to DUPLICATE, not a 500', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(
      createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('lets an unrecognised database error through untouched rather than mislabelling it', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }));

    await expect(
      createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' }),
    ).rejects.toThrow('boom');
  });

  it('does not swallow a CheckInError raised inside the transaction', async () => {
    mockPrisma.checkIn.count.mockResolvedValue(99);

    await expect(
      createCheckIn({
        activity: { ...ATTENDANCE_ACTIVITY, maxParticipants: 5 },
        userId: 'u1',
        method: 'QR',
      }),
    ).rejects.toMatchObject({ code: 'FULL' });
  });
});

describe('attendance-only activities (ADR-001 D2 — expectedSteps null)', () => {
  it('pays the activity points immediately, inside the transaction', async () => {
    const result = await createCheckIn({
      activity: ATTENDANCE_ACTIVITY,
      userId: 'u1',
      method: 'QR',
    });

    expect(applyPoints).toHaveBeenCalledWith(
      mockPrisma,
      expect.objectContaining({ userId: 'u1', amount: 50, reason: 'ACTIVITY_CHECKIN', refId: 'act-1' }),
    );
    expect(result.pointsAwarded).toBe(50);
  });

  it('stamps pointsAwardedAt and takes no step baseline', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' });

    const data = mockPrisma.checkIn.create.mock.calls[0][0].data;
    expect(data.stepsAtCheckIn).toBeNull();
    expect(data.pointsAwardedAt).toBeInstanceOf(Date);
    expect(dailyMaxSteps).not.toHaveBeenCalled();
  });

  it('never runs the step-gated award evaluation', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(evaluateActivityAward).not.toHaveBeenCalled();
  });

  it('reports 0 for a zero-point activity rather than crashing on a null points field', async () => {
    const result = await createCheckIn({
      activity: { ...ATTENDANCE_ACTIVITY, points: null },
      userId: 'u1',
      method: 'QR',
    });

    expect(result.pointsAwarded).toBe(0);
    expect(applyPoints).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ amount: 0 }));
  });
});

describe('step-gated activities (ADR-001 — expectedSteps set)', () => {
  it('records the check-in but does NOT pay points at check-in time', async () => {
    const result = await createCheckIn({
      activity: STEP_GATED_ACTIVITY,
      userId: 'u1',
      method: 'QR',
    });

    expect(applyPoints).not.toHaveBeenCalled();
    expect(result.pointsAwarded).toBe(0);
  });

  it('snapshots today\'s steps as the baseline and leaves pointsAwardedAt null', async () => {
    dailyMaxSteps.mockResolvedValue(3400);

    await createCheckIn({ activity: STEP_GATED_ACTIVITY, userId: 'u1', method: 'QR' });

    const data = mockPrisma.checkIn.create.mock.calls[0][0].data;
    expect(data.stepsAtCheckIn).toBe(3400);
    expect(data.pointsAwardedAt).toBeNull();
  });

  it('takes the baseline inside the transaction, using the transaction client', async () => {
    await createCheckIn({ activity: STEP_GATED_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(dailyMaxSteps).toHaveBeenCalledWith(mockPrisma, 'u1', expect.any(Date));
  });

  it('pays out when a concurrent sync already cleared the goal between snapshot and evaluation', async () => {
    evaluateActivityAward.mockResolvedValue({ awarded: true });

    const result = await createCheckIn({
      activity: STEP_GATED_ACTIVITY,
      userId: 'u1',
      method: 'QR',
    });

    expect(result.pointsAwarded).toBe(50);
  });

  it('evaluates AFTER the transaction commits, so an award failure cannot roll back the check-in', async () => {
    const order = [];
    mockPrisma.$transaction.mockImplementation(async (fn) => {
      const out = await fn(mockPrisma);
      order.push('tx-commit');
      return out;
    });
    evaluateActivityAward.mockImplementation(async () => {
      order.push('evaluate');
      return { awarded: false };
    });

    await createCheckIn({ activity: STEP_GATED_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(order).toEqual(['tx-commit', 'evaluate']);
  });

  it('still returns a successful check-in when the award evaluation throws', async () => {
    // A failed evaluation must never turn a committed check-in into an error
    // response — the next health sync catches it up.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    evaluateActivityAward.mockRejectedValue(new Error('award service down'));

    const result = await createCheckIn({
      activity: STEP_GATED_ACTIVITY,
      userId: 'u1',
      method: 'QR',
    });

    expect(result.checkIn).toEqual(createdRow());
    expect(result.pointsAwarded).toBe(0);
    consoleError.mockRestore();
  });
});

describe('shared write path — both entry points', () => {
  it('checks in the user it is given, which is not necessarily the caller (manual check-in)', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'target-user', method: 'MANUAL' });

    expect(mockPrisma.checkIn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'target-user', method: 'MANUAL' }),
      }),
    );
  });

  it('records the method so the attendees screen can list walk-ins separately', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'QR' });

    expect(mockPrisma.checkIn.create.mock.calls[0][0].data.method).toBe('QR');
  });

  it('stores coordinates when supplied', async () => {
    await createCheckIn({
      activity: ATTENDANCE_ACTIVITY,
      userId: 'u1',
      method: 'QR',
      latitude: 13.7367,
      longitude: 100.5331,
    });

    const data = mockPrisma.checkIn.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ latitude: 13.7367, longitude: 100.5331 });
  });

  it('defaults coordinates to null rather than undefined when omitted', async () => {
    await createCheckIn({ activity: ATTENDANCE_ACTIVITY, userId: 'u1', method: 'MANUAL' });

    const data = mockPrisma.checkIn.create.mock.calls[0][0].data;
    expect(data.latitude).toBeNull();
    expect(data.longitude).toBeNull();
  });
});
