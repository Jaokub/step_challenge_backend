import { describe, it, expect, vi, beforeEach } from 'vitest';
import { body, validationResult } from 'express-validator';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));
vi.mock('uuid', () => ({ v4: () => 'fixed-uuid-qr' }));

const { createActivity, updateActivity, deleteActivity } = await import('./activity.controller.js');

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

const makeReq = (overrides = {}) => ({
  user: { id: 'admin-1', role: 'ADMIN' },
  body: {
    title: 'ทดสอบ วิ่งเช้าคณะวิศวะ',
    description: '',
    location: 'สนามกีฬาคณะ',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-01T00:00:00.000Z',
    points: 0,
    expectedSteps: null,
    totalDistance: null,
    ...overrides,
  },
});

/**
 * Regression tests for `POST /activities`.
 *
 * **Why these exist:** activity creation shipped with ZERO test coverage —
 * Phase 6A built the suite around leaderboards, hierarchy and points, and no
 * test ever exercised the create path. Two independent bugs made the admin
 * "create activity" form unusable in practice, and both survived a green
 * 108-test suite because nothing called this controller or its route
 * validator. Neither bug is subtle; they were simply never run.
 *
 * Bug A — attendance-only activities were impossible.
 *   The form offers `activityType: ATTENDANCE | STEP_GATED`; ATTENDANCE sends
 *   `expectedSteps: null, totalDistance: null`. The controller rejected that
 *   with "Provide at least one target". But ADR-001 D2 defines `expectedSteps
 *   = null` as *exactly* what an attendance-only activity looks like, so the
 *   guard contradicted the documented model and blocked a supported type.
 *
 * Bug B — single-day activities were impossible (see the route-validator
 *   block at the bottom of this file). `duration: SINGLE_DAY` is the form's
 *   DEFAULT and sets `endDate = startDate`; the route validator rejected
 *   `endDate <= startDate`. The controller and the mobile form both allowed
 *   `>=`; only the validator disagreed, and it runs first.
 *
 * Together: the default form state failed, and so did every attendance-only
 * activity. Only STEP_GATED + MULTI_DAY with distinct dates got through.
 */
describe('createActivity — attendance-only activities (Bug A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.activity.create.mockImplementation(async ({ data }) => ({ id: 'act-1', ...data }));
  });

  it('creates an attendance-only activity with no step or distance target', async () => {
    const req = makeReq({ expectedSteps: null, totalDistance: null });
    const res = makeRes();

    await createActivity(req, res);

    expect(res.statusCode).toBe(201);
    expect(mockPrisma.activity.create).toHaveBeenCalled();
    const { data } = mockPrisma.activity.create.mock.calls[0][0];
    // ADR-001 D2: null expectedSteps IS the attendance-only marker.
    expect(data.expectedSteps).toBeNull();
    expect(data.totalDistance).toBeNull();
  });

  it('still creates a step-gated activity when expectedSteps is provided', async () => {
    const req = makeReq({ expectedSteps: 6500 });
    const res = makeRes();

    await createActivity(req, res);

    expect(res.statusCode).toBe(201);
    const { data } = mockPrisma.activity.create.mock.calls[0][0];
    expect(data.expectedSteps).toBe(6500);
  });

  it('accepts a distance-only target', async () => {
    const req = makeReq({ totalDistance: 5 });
    const res = makeRes();

    await createActivity(req, res);

    expect(res.statusCode).toBe(201);
    const { data } = mockPrisma.activity.create.mock.calls[0][0];
    expect(data.totalDistance).toBe(5);
    expect(data.expectedSteps).toBeNull();
  });

  it('still rejects genuinely missing required fields', async () => {
    const req = makeReq({ title: '', location: '' });
    const res = makeRes();

    await createActivity(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('still rejects an endDate before startDate', async () => {
    const req = makeReq({
      startDate: '2026-08-10T00:00:00.000Z',
      endDate: '2026-08-01T00:00:00.000Z',
    });
    const res = makeRes();

    await createActivity(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('accepts equal start and end dates (single-day activity)', async () => {
    const sameDay = '2026-08-01T00:00:00.000Z';
    const req = makeReq({ startDate: sameDay, endDate: sameDay });
    const res = makeRes();

    await createActivity(req, res);

    expect(res.statusCode).toBe(201);
  });
});

/**
 * Bug B lives in the ROUTE validator, not the controller, so it needs the
 * express-validator chain itself under test. This mirrors the chain declared
 * in `routes/activity.routes.js` for `endDate`.
 */
const endDateChain = body('endDate')
  .notEmpty()
  .withMessage('End date is required')
  .isISO8601()
  .withMessage('End date must be a valid ISO 8601 date')
  .custom((value, { req }) => {
    if (new Date(value) < new Date(req.body.startDate)) {
      throw new Error('End date must not be before start date');
    }
    return true;
  });

const runChain = async (reqBody) => {
  const req = { body: reqBody };
  await endDateChain.run(req);
  return validationResult(req);
};

describe('POST /activities route validator — endDate rule (Bug B)', () => {
  it('allows endDate === startDate, the SINGLE_DAY default', async () => {
    const sameDay = '2026-08-01T00:00:00.000Z';
    const result = await runChain({ startDate: sameDay, endDate: sameDay });
    expect(result.isEmpty()).toBe(true);
  });

  it('allows endDate after startDate', async () => {
    const result = await runChain({
      startDate: '2026-08-01T00:00:00.000Z',
      endDate: '2026-08-05T00:00:00.000Z',
    });
    expect(result.isEmpty()).toBe(true);
  });

  it('rejects endDate before startDate', async () => {
    const result = await runChain({
      startDate: '2026-08-10T00:00:00.000Z',
      endDate: '2026-08-01T00:00:00.000Z',
    });
    expect(result.isEmpty()).toBe(false);
    expect(result.array()[0].msg).toMatch(/not be before/i);
  });

  it('rejects a missing endDate', async () => {
    const result = await runChain({ startDate: '2026-08-01T00:00:00.000Z', endDate: '' });
    expect(result.isEmpty()).toBe(false);
  });
});

/**
 * `PUT /activities/:id` — the edit path.
 *
 * Note the asymmetry that motivated these: `POST /activities` validates the
 * date order TWICE (route validator + controller), while `PUT /:id` has **no
 * validator middleware at all** — the route is just
 * `router.put('/:id', requireRole('ADMIN'), updateActivity)`. Until 2026-07-19
 * the controller didn't check either, so an admin could edit an activity into
 * an endDate-before-startDate state. That range is exactly what step-gated
 * awards (ADR-001) and every period aggregation are computed over, so an
 * inverted window fails silently rather than loudly.
 */
const EXISTING = {
  id: 'act-1',
  title: 'วิ่งเช้าคณะวิศวะ',
  description: '',
  location: 'สนามกีฬาคณะ',
  startDate: new Date('2026-08-01T00:00:00.000Z'),
  endDate: new Date('2026-08-05T00:00:00.000Z'),
  status: 'UPCOMING',
  points: 0,
  expectedSteps: null,
  totalDistance: null,
};

describe('updateActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.activity.findUnique.mockResolvedValue({ ...EXISTING });
    // `_count` mirrors the controller's `include` — it reads
    // activity._count.checkIns when shaping the response.
    mockPrisma.activity.update.mockImplementation(async ({ data }) => ({
      ...EXISTING,
      ...data,
      _count: { checkIns: 0, activityParticipants: 0 },
    }));
  });

  const run = async (body, id = 'act-1') => {
    const res = makeRes();
    await updateActivity({ params: { id }, body, user: { id: 'admin-1', role: 'ADMIN' } }, res);
    return res;
  };

  it('404s for an activity that does not exist', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(null);
    const res = await run({ title: 'x' });
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });

  it('applies a partial update without touching unspecified fields', async () => {
    const res = await run({ title: 'ชื่อใหม่' });
    expect(res.statusCode).toBe(200);
    const { data } = mockPrisma.activity.update.mock.calls[0][0];
    expect(data).toEqual({ title: 'ชื่อใหม่' });
    expect(data.startDate).toBeUndefined();
    expect(data.location).toBeUndefined();
  });

  it('rejects an update that would put endDate before startDate', async () => {
    const res = await run({
      startDate: '2026-08-10T00:00:00.000Z',
      endDate: '2026-08-02T00:00:00.000Z',
    });
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });

  it('validates a PARTIAL date edit against the stored value, not just the body', async () => {
    // Only startDate is sent. It must be checked against the row's EXISTING
    // endDate (2026-08-05) — moving the start past it is invalid even though
    // the request body alone looks self-consistent. This is the case a naive
    // "only compare what was sent" guard would wave through.
    const res = await run({ startDate: '2026-08-20T00:00:00.000Z' });
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });

  it('allows a partial date edit that stays in order', async () => {
    const res = await run({ endDate: '2026-08-09T00:00:00.000Z' });
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.activity.update).toHaveBeenCalled();
  });

  it('allows equal start and end dates (single-day)', async () => {
    const sameDay = '2026-09-01T00:00:00.000Z';
    const res = await run({ startDate: sameDay, endDate: sameDay });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an invalid status value', async () => {
    const res = await run({ status: 'PAUSED' });
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });

  it('accepts every valid status value', async () => {
    for (const status of ['UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED']) {
      vi.clearAllMocks();
      mockPrisma.activity.findUnique.mockResolvedValue({ ...EXISTING });
      // `_count` mirrors the controller's `include` — it reads
    // activity._count.checkIns when shaping the response.
    mockPrisma.activity.update.mockImplementation(async ({ data }) => ({
      ...EXISTING,
      ...data,
      _count: { checkIns: 0, activityParticipants: 0 },
    }));
      const res = await run({ status });
      expect(res.statusCode, `status ${status}`).toBe(200);
    }
  });

  it('clears expectedSteps when sent as null — step-gated → attendance-only', async () => {
    // ADR-001 D2: expectedSteps is the type discriminator, so being able to
    // null it out is how an activity is converted to attendance-only.
    const res = await run({ expectedSteps: null });
    expect(res.statusCode).toBe(200);
    const { data } = mockPrisma.activity.update.mock.calls[0][0];
    expect(data.expectedSteps).toBeNull();
  });

  it('treats an empty-string expectedSteps as null rather than NaN', async () => {
    const res = await run({ expectedSteps: '' });
    expect(res.statusCode).toBe(200);
    const { data } = mockPrisma.activity.update.mock.calls[0][0];
    expect(data.expectedSteps).toBeNull();
  });

  it('does not write NaN points when the field is cleared', async () => {
    const res = await run({ points: '' });
    expect(res.statusCode).toBe(200);
    const { data } = mockPrisma.activity.update.mock.calls[0][0];
    expect(Number.isNaN(data.points)).toBe(false);
    expect(data.points).toBe(0);
  });

  it('400s on unparseable points instead of letting Prisma throw a 500', async () => {
    const res = await run({ points: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });
});

/**
 * `DELETE /activities/:id` is a **soft** delete — it sets status CANCELLED
 * rather than removing the row, so check-in history and step aggregates
 * survive. Worth pinning down in a test: the endpoint's name says "delete"
 * but its behaviour is "cancel", and a future reader could easily "fix" that
 * into a hard delete and silently destroy attendance records.
 */
describe('deleteActivity (soft cancel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const run = async (id = 'act-1') => {
    const res = makeRes();
    await deleteActivity({ params: { id }, user: { id: 'admin-1', role: 'ADMIN' } }, res);
    return res;
  };

  it('404s for an activity that does not exist', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(null);
    const res = await run();
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });

  it('sets status to CANCELLED instead of deleting the row', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue({ ...EXISTING, status: 'ONGOING' });
    mockPrisma.activity.update.mockResolvedValue({ ...EXISTING, status: 'CANCELLED' });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.activity.update).toHaveBeenCalledWith({
      where: { id: 'act-1' },
      data: { status: 'CANCELLED' },
    });
    // The row must survive — check-ins and step aggregates reference it.
    expect(mockPrisma.activity.delete).not.toHaveBeenCalled();
  });

  it('rejects cancelling an already-cancelled activity', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue({ ...EXISTING, status: 'CANCELLED' });
    const res = await run();
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.activity.update).not.toHaveBeenCalled();
  });
});
