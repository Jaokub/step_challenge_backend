import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

// `createCheckIn` is the single shared write path for BOTH entry points
// (QR and admin manual). It has its own guards; what's under test here is
// the controller layer around it — QR lookup, admin target resolution, and
// the CheckInError → HTTP status mapping.
class CheckInError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CheckInError';
    this.code = code;
  }
}
const createCheckIn = vi.fn();
vi.mock('../services/checkin.service.js', () => ({
  createCheckIn: (...args) => createCheckIn(...args),
  CheckInError,
  default: { createCheckIn: (...args) => createCheckIn(...args), CheckInError },
}));

const { checkInByQR, adminCheckIn } = await import('./checkin.controller.js');

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

const ACTIVITY = {
  id: 'act-1',
  title: 'วิ่งเช้าคณะวิศวะ',
  qrCode: 'qr-abc',
  status: 'ONGOING',
  points: 50,
  maxParticipants: null,
};

/**
 * Coverage for the two check-in ENTRY points.
 *
 * Context: `cancelCheckIn` was already covered (checkin.controller.test.js,
 * the ADR-001 cancel-before/after-award cases) but the two ways a check-in is
 * actually *created* were not — despite check-in being the core interaction
 * of the whole product and the only thing QR scanning exists for.
 *
 * The shared `createCheckIn` service holds the real business guards
 * (activity status, duplicate, capacity, serializable retry). It's mocked
 * here on purpose: these tests pin the controller's own responsibilities,
 * which is where the untested surface actually was.
 */
describe('checkInByQR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCheckIn.mockResolvedValue({ checkIn: { id: 'ci-1' }, pointsAwarded: 0 });
  });

  const run = async (body) => {
    const res = makeRes();
    await checkInByQR({ body, user: { id: 'user-1', role: 'STAFF' } }, res);
    return res;
  };

  it('404s on an unknown QR code', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(null);
    const res = await run({ qrCode: 'nope' });
    expect(res.statusCode).toBe(404);
    expect(createCheckIn).not.toHaveBeenCalled();
  });

  it('checks the scanning user into the activity the QR resolves to', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    const res = await run({ qrCode: 'qr-abc' });

    expect(res.statusCode).toBe(201);
    expect(createCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ activity: ACTIVITY, userId: 'user-1', method: 'QR' })
    );
  });

  it('maps a duplicate check-in to 409, not a generic 400', async () => {
    // The mobile scan screen relies on this specific status to show
    // "already checked in" instead of a hard error.
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    createCheckIn.mockRejectedValue(new CheckInError('DUPLICATE', 'dupe'));

    const res = await run({ qrCode: 'qr-abc' });
    expect(res.statusCode).toBe(409);
  });

  it('maps a full activity to 400', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    createCheckIn.mockRejectedValue(new CheckInError('FULL', 'full'));

    const res = await run({ qrCode: 'qr-abc' });
    expect(res.statusCode).toBe(400);
  });

  it('maps a wrong-status activity to 400', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    createCheckIn.mockRejectedValue(new CheckInError('INVALID_STATUS', 'completed'));

    const res = await run({ qrCode: 'qr-abc' });
    expect(res.statusCode).toBe(400);
  });

  it('maps a serialization conflict to 409 so the client can retry', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    createCheckIn.mockRejectedValue(new CheckInError('CONFLICT', 'retry'));

    const res = await run({ qrCode: 'qr-abc' });
    expect(res.statusCode).toBe(409);
  });

  it('parses optional coordinates as floats, and passes null when absent', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);

    await run({ qrCode: 'qr-abc', latitude: '13.7367', longitude: '100.5232' });
    expect(createCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 13.7367, longitude: 100.5232 })
    );

    vi.clearAllMocks();
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    createCheckIn.mockResolvedValue({ checkIn: { id: 'ci-2' }, pointsAwarded: 0 });
    await run({ qrCode: 'qr-abc' });
    expect(createCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: null, longitude: null })
    );
  });
});

describe('adminCheckIn (manual walk-in check-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCheckIn.mockResolvedValue({ checkIn: { id: 'ci-1' }, pointsAwarded: 0 });
  });

  const run = async (body) => {
    const res = makeRes();
    await adminCheckIn({ body, user: { id: 'admin-1', role: 'ADMIN' } }, res);
    return res;
  };

  it('checks in the TARGET user, not the admin making the request', async () => {
    // The bug this guards against is subtle and was live once before in
    // cancelCheckIn's points reversal: using req.user.id where the payload's
    // userId is meant. Here it would silently check the admin in instead of
    // the walk-in participant.
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-9', fullName: 'ผู้เข้าร่วม' });

    const res = await run({ activityId: 'act-1', userId: 'user-9' });

    expect(res.statusCode).toBe(201);
    expect(createCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-9', method: 'MANUAL' })
    );
    const passed = createCheckIn.mock.calls[0][0];
    expect(passed.userId).not.toBe('admin-1');
  });

  it('404s when the activity does not exist', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(null);
    const res = await run({ activityId: 'missing', userId: 'user-9' });
    expect(res.statusCode).toBe(404);
    expect(createCheckIn).not.toHaveBeenCalled();
  });

  it('404s when the target user does not exist', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await run({ activityId: 'act-1', userId: 'ghost' });
    expect(res.statusCode).toBe(404);
    expect(createCheckIn).not.toHaveBeenCalled();
  });

  it('maps a duplicate manual check-in to 409', async () => {
    mockPrisma.activity.findUnique.mockResolvedValue(ACTIVITY);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-9' });
    createCheckIn.mockRejectedValue(new CheckInError('DUPLICATE', 'dupe'));

    const res = await run({ activityId: 'act-1', userId: 'user-9' });
    expect(res.statusCode).toBe(409);
  });
});
