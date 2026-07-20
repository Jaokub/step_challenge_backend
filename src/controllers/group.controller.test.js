import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const { createGroup } = await import('./group.controller.js');

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

describe('group.controller.createGroup — cap guard (BUILD_PLAN Phase 2 gap #2 / Phase 5 gap #6 fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with 409 when the user already owns 3 groups', async () => {
    mockPrisma.groupMember.count.mockResolvedValue(3);
    const req = { user: { id: 'user-1' }, body: { name: 'Fourth Group' } };
    const res = mockRes();

    await createGroup(req, res);

    expect(mockPrisma.groupMember.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', role: 'OWNER' },
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
    // Never gets as far as trying to create the group.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows creation at 2/3 (below the cap) and creates the group as the 3rd', async () => {
    mockPrisma.groupMember.count.mockResolvedValue(2);
    mockPrisma.appGroup.findUnique
      .mockResolvedValueOnce(null) // invite-code uniqueness check passes first try
      .mockResolvedValueOnce({ id: 'group-1', name: 'Third Group' }); // post-create fetch
    mockPrisma.appGroup.create = vi.fn().mockResolvedValue({ id: 'group-1' });
    mockPrisma.groupMember.create.mockResolvedValue({ id: 'member-1' });
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

    const req = { user: { id: 'user-1' }, body: { name: 'Third Group' } };
    const res = mockRes();

    await createGroup(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('rejects at exactly 3/3 (boundary — the cap is inclusive of 3, not 4)', async () => {
    mockPrisma.groupMember.count.mockResolvedValue(3);
    const req = { user: { id: 'user-1' }, body: { name: 'One Too Many' } };
    const res = mockRes();

    await createGroup(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('counts LIVE OWNER membership rows, not AppGroup.createdById (Phase 5 gap #6 cap-consistency fix)', async () => {
    // A user who transferred away all 3 owned groups should have their slot
    // freed even though they're still `createdById` on the old rows —
    // asserting the query shape itself is the regression guard here.
    mockPrisma.groupMember.count.mockResolvedValue(0);
    mockPrisma.appGroup.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'g' });
    mockPrisma.appGroup.create = vi.fn().mockResolvedValue({ id: 'g' });
    mockPrisma.groupMember.create.mockResolvedValue({ id: 'm' });
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));

    const req = { user: { id: 'user-1' }, body: { name: 'Fresh Slot' } };
    const res = mockRes();
    await createGroup(req, res);

    const countArgs = mockPrisma.groupMember.count.mock.calls[0][0];
    expect(countArgs.where).toEqual({ userId: 'user-1', role: 'OWNER' });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
