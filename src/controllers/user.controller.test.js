import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../services/userSanitizer.service.js', () => ({ sanitizeUser: (u) => u }));

const { updateUserRole } = await import('./user.controller.js');

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
 * `PATCH /users/:id/role` — the only endpoint that grants or revokes global
 * ADMIN. Untested until 2026-07-19 despite being the highest-privilege
 * operation in the API.
 *
 * Two layers protect it and both matter:
 *  - the route (`user.routes.js`) requires ADMIN and validates `role` with
 *    `isIn(['ADMIN','STAFF'])`, so arbitrary role strings never reach here;
 *  - the controller refuses to revoke the LAST remaining admin, which is what
 *    stops the faculty locking itself out of its own admin console.
 *
 * The lockout guard is the one worth pinning down: it's a `count()` check with
 * an off-by-one waiting to happen, and its failure mode is unrecoverable
 * without direct DB access.
 */
describe('updateUserRole — last-admin lockout guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  });

  it('404s for a user that does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = makeRes();

    await updateUserRole({ params: { id: 'ghost' }, body: { role: 'ADMIN' } }, res);

    expect(res.statusCode).toBe(404);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to demote the only remaining admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', role: 'ADMIN' });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = makeRes();

    await updateUserRole({ params: { id: 'admin-1' }, body: { role: 'STAFF' } }, res);

    expect(res.statusCode).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('allows demoting an admin when another admin remains', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', role: 'ADMIN' });
    mockPrisma.user.count.mockResolvedValue(2);
    const res = makeRes();

    await updateUserRole({ params: { id: 'admin-1' }, body: { role: 'STAFF' } }, res);

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: { role: 'STAFF' },
    });
  });

  it('does not run the lockout check when PROMOTING to admin', async () => {
    // Promotion can never reduce the admin count, so it must not be gated on
    // it — an over-eager guard here would block bootstrapping a second admin.
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-2', role: 'STAFF' });
    const res = makeRes();

    await updateUserRole({ params: { id: 'user-2' }, body: { role: 'ADMIN' } }, res);

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: { role: 'ADMIN' },
    });
  });

  it('is a no-op-ish when re-applying STAFF to an existing STAFF user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-3', role: 'STAFF' });
    const res = makeRes();

    await updateUserRole({ params: { id: 'user-3' }, body: { role: 'STAFF' } }, res);

    expect(res.statusCode).toBe(200);
    // Not an admin, so the lockout count must not be consulted.
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });
});
