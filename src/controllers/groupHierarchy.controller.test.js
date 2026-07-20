import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Coverage for the group-hierarchy write paths: parent-link request,
 * approve/deny, and coordinator transfer.
 *
 * These are the scariest untested functions in the backend. Getting them
 * wrong strips someone of coordinator rights or breaks a group's parent link
 * in a way the affected user cannot undo themselves — unlike a wrong number
 * on a dashboard, which is merely visible.
 *
 * The service layer is already covered by `groupHierarchy.service.test.js`
 * (cycle detection, depth arithmetic, the transfer's cap accounting). What
 * was missing, and is pinned here, is the CONTROLLER's own responsibility:
 * who is allowed to call each of these, and the ordering of the guards.
 */

const svc = {
  getGroup: vi.fn(),
  getMembership: vi.fn(),
  getPendingRequestForChild: vi.fn(),
  searchParentCandidates: vi.fn(),
  createParentRequest: vi.fn(),
  getIncomingRequests: vi.fn(),
  getRequestById: vi.fn(),
  resolveRequest: vi.fn(),
  transferCoordinator: vi.fn(),
  getAdminGroupTrees: vi.fn(),
  wouldCreateCycle: vi.fn(),
  depthWouldExceed: vi.fn(),
};
vi.mock('../services/groupHierarchy.service.js', () => ({ ...svc, default: svc }));
vi.mock('../services/group.scope.js', () => ({ MAX_GROUP_DEPTH: 4, default: { MAX_GROUP_DEPTH: 4 } }));

const { requestParent, approveRequest, denyRequest, transferCoordinator } = await import(
  './groupHierarchy.controller.js'
);

const makeRes = () => {
  const res = { statusCode: 200, body: undefined };
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

const OWNER = { id: 'owner-1', role: 'STAFF' };
const MEMBER_USER = { id: 'member-1', role: 'STAFF' };
const ADMIN = { id: 'admin-1', role: 'ADMIN' };

beforeEach(() => {
  vi.clearAllMocks();
  svc.getGroup.mockResolvedValue({ id: 'g-child', name: 'ภาควิชาโยธา' });
  svc.wouldCreateCycle.mockResolvedValue(false);
  svc.depthWouldExceed.mockResolvedValue(false);
  svc.getPendingRequestForChild.mockResolvedValue(null);
  svc.createParentRequest.mockResolvedValue({ id: 'req-1', status: 'PENDING' });
});

describe('requestParent — a coordinator asks to become a child of another group', () => {
  const call = (body, params = { id: 'g-child' }) => {
    const res = makeRes();
    return requestParent({ params, body, user: OWNER }, res, vi.fn()).then(() => res);
  };

  it('creates a pending request and returns 201', async () => {
    const res = await call({ parentGroupId: 'g-parent' });

    expect(res.statusCode).toBe(201);
    expect(svc.createParentRequest).toHaveBeenCalledWith({
      childGroupId: 'g-child',
      parentGroupId: 'g-parent',
      requestedById: 'owner-1',
    });
  });

  it('400s when no parent group is supplied', async () => {
    const res = await call({});

    expect(res.statusCode).toBe(400);
    expect(svc.createParentRequest).not.toHaveBeenCalled();
  });

  it('refuses to make a group its own parent', async () => {
    const res = await call({ parentGroupId: 'g-child' });

    expect(res.statusCode).toBe(400);
    expect(svc.createParentRequest).not.toHaveBeenCalled();
  });

  it('404s when the prospective parent does not exist', async () => {
    svc.getGroup.mockResolvedValue(null);

    const res = await call({ parentGroupId: 'ghost' });

    expect(res.statusCode).toBe(404);
    expect(svc.createParentRequest).not.toHaveBeenCalled();
  });

  it('blocks a link that would create a loop in the hierarchy', async () => {
    svc.wouldCreateCycle.mockResolvedValue(true);

    const res = await call({ parentGroupId: 'g-descendant' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/loop/i);
    expect(svc.createParentRequest).not.toHaveBeenCalled();
  });

  it('blocks a link that would push the tree past the depth cap', async () => {
    svc.depthWouldExceed.mockResolvedValue(true);

    const res = await call({ parentGroupId: 'g-deep' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('4');
    expect(svc.createParentRequest).not.toHaveBeenCalled();
  });

  it('409s rather than queueing a second request while one is pending', async () => {
    svc.getPendingRequestForChild.mockResolvedValue({ id: 'req-existing' });

    const res = await call({ parentGroupId: 'g-parent' });

    expect(res.statusCode).toBe(409);
    expect(svc.createParentRequest).not.toHaveBeenCalled();
  });

  it('checks the cycle and depth guards BEFORE the pending-request check', async () => {
    // Order matters for the message the coordinator sees: an impossible link
    // should be reported as impossible, not as "already pending".
    svc.wouldCreateCycle.mockResolvedValue(true);
    svc.getPendingRequestForChild.mockResolvedValue({ id: 'req-existing' });

    const res = await call({ parentGroupId: 'g-parent' });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/loop/i);
  });
});

describe('approveRequest / denyRequest — only the parent group resolves', () => {
  const PENDING = {
    id: 'req-1',
    status: 'PENDING',
    childGroupId: 'g-child',
    parentGroupId: 'g-parent',
  };

  const call = (handler, { request = PENDING, params = { id: 'g-parent', requestId: 'req-1' } } = {}) => {
    svc.getRequestById.mockResolvedValue(request);
    svc.resolveRequest.mockResolvedValue({ ...request, status: 'APPROVED' });
    const res = makeRes();
    return handler({ params, user: OWNER }, res, vi.fn()).then(() => res);
  };

  it('approves a pending request', async () => {
    const res = await call(approveRequest);

    expect(res.statusCode).toBe(200);
    expect(svc.resolveRequest).toHaveBeenCalledWith('req-1', 'APPROVED');
  });

  it('denies a pending request', async () => {
    const res = await call(denyRequest);

    expect(svc.resolveRequest).toHaveBeenCalledWith('req-1', 'DENIED');
  });

  it('404s for a request that does not exist', async () => {
    const res = await call(approveRequest, { request: null });

    expect(res.statusCode).toBe(404);
    expect(svc.resolveRequest).not.toHaveBeenCalled();
  });

  it('404s when the request belongs to a DIFFERENT parent group', async () => {
    // The coordinator of group A must not be able to approve a request
    // addressed to group B by guessing its request id.
    const res = await call(approveRequest, {
      request: { ...PENDING, parentGroupId: 'someone-elses-group' },
    });

    expect(res.statusCode).toBe(404);
    expect(svc.resolveRequest).not.toHaveBeenCalled();
  });

  it('409s on an already-approved request instead of silently reapplying it', async () => {
    const res = await call(approveRequest, { request: { ...PENDING, status: 'APPROVED' } });

    expect(res.statusCode).toBe(409);
    expect(svc.resolveRequest).not.toHaveBeenCalled();
  });

  it('409s on an already-denied request', async () => {
    const res = await call(denyRequest, { request: { ...PENDING, status: 'DENIED' } });

    expect(res.statusCode).toBe(409);
    expect(svc.resolveRequest).not.toHaveBeenCalled();
  });

  it('re-checks the cycle guard at approval time, not just at request time', async () => {
    // The tree can change between request and approval.
    svc.wouldCreateCycle.mockResolvedValue(true);

    const res = await call(approveRequest);

    expect(res.statusCode).toBe(409);
    expect(svc.resolveRequest).not.toHaveBeenCalled();
  });

  it('re-checks the depth guard at approval time', async () => {
    svc.depthWouldExceed.mockResolvedValue(true);

    const res = await call(approveRequest);

    expect(res.statusCode).toBe(409);
    expect(svc.resolveRequest).not.toHaveBeenCalled();
  });

  it('does NOT run the tree guards when denying — a denial can never break the tree', async () => {
    svc.wouldCreateCycle.mockResolvedValue(true);

    const res = await call(denyRequest);

    expect(res.statusCode).toBe(200);
    expect(svc.resolveRequest).toHaveBeenCalledWith('req-1', 'DENIED');
  });
});

describe('transferCoordinator — coordinator-initiated', () => {
  const call = (user, body = { userId: 'member-1' }) => {
    const res = makeRes();
    return transferCoordinator({ params: { id: 'g-1' }, body, user }, res, vi.fn()).then(() => res);
  };

  beforeEach(() => {
    svc.getGroup.mockResolvedValue({ id: 'g-1', name: 'ชมรมเดิน' });
    svc.transferCoordinator.mockResolvedValue({ ok: true });
  });

  it('hands the group over when the current coordinator asks', async () => {
    svc.getMembership
      .mockResolvedValueOnce({ role: 'OWNER' }) // caller
      .mockResolvedValueOnce({ role: 'MEMBER' }); // target

    const res = await call(OWNER);

    expect(res.statusCode).toBe(200);
    expect(svc.transferCoordinator).toHaveBeenCalledWith('g-1', 'member-1');
  });

  it('400s when no target user is supplied', async () => {
    const res = await call(OWNER, {});

    expect(res.statusCode).toBe(400);
    expect(svc.transferCoordinator).not.toHaveBeenCalled();
  });

  it('404s for a group that does not exist', async () => {
    svc.getGroup.mockResolvedValue(null);

    const res = await call(OWNER);

    expect(res.statusCode).toBe(404);
    expect(svc.transferCoordinator).not.toHaveBeenCalled();
  });

  it('403s when a plain member tries to transfer the group', async () => {
    svc.getMembership.mockResolvedValueOnce({ role: 'MEMBER' });

    const res = await call(MEMBER_USER);

    expect(res.statusCode).toBe(403);
    expect(svc.transferCoordinator).not.toHaveBeenCalled();
  });

  it('403s when a non-member outsider tries to transfer the group', async () => {
    svc.getMembership.mockResolvedValueOnce(null);

    const res = await call({ id: 'stranger', role: 'STAFF' });

    expect(res.statusCode).toBe(403);
    expect(svc.transferCoordinator).not.toHaveBeenCalled();
  });

  it('400s when the target is not a member of the group', async () => {
    svc.getMembership
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce(null);

    const res = await call(OWNER);

    expect(res.statusCode).toBe(400);
    expect(svc.transferCoordinator).not.toHaveBeenCalled();
  });

  it('409s when the target already coordinates 3 groups (the cap)', async () => {
    svc.getMembership
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce({ role: 'MEMBER' });
    svc.transferCoordinator.mockResolvedValue({ capExceeded: true });

    const res = await call(OWNER);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/3 groups/);
  });

  it('409s when the target is already the coordinator', async () => {
    svc.getMembership
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce({ role: 'MEMBER' });
    svc.transferCoordinator.mockResolvedValue({ alreadyOwner: true });

    const res = await call(OWNER);

    expect(res.statusCode).toBe(409);
  });
});

describe('transferCoordinator — Faculty Admin override', () => {
  const call = (body = { userId: 'anyone' }) => {
    const res = makeRes();
    return transferCoordinator({ params: { id: 'g-1' }, body, user: ADMIN }, res, vi.fn()).then(() => res);
  };

  beforeEach(() => {
    svc.getGroup.mockResolvedValue({ id: 'g-1', name: 'ชมรมเดิน' });
    svc.transferCoordinator.mockResolvedValue({ ok: true });
  });

  it('reassigns a group the admin does not belong to, without any membership check', async () => {
    const res = await call();

    expect(res.statusCode).toBe(200);
    expect(svc.getMembership).not.toHaveBeenCalled();
    expect(svc.transferCoordinator).toHaveBeenCalledWith('g-1', 'anyone');
  });

  it('can appoint someone who is not yet a member of the group', async () => {
    const res = await call({ userId: 'outsider' });

    expect(res.statusCode).toBe(200);
    expect(svc.transferCoordinator).toHaveBeenCalledWith('g-1', 'outsider');
  });

  it('still 404s on a missing group — the override skips permissions, not existence', async () => {
    svc.getGroup.mockResolvedValue(null);

    const res = await call();

    expect(res.statusCode).toBe(404);
    expect(svc.transferCoordinator).not.toHaveBeenCalled();
  });

  it('is still bound by the recipient\'s 3-group cap', async () => {
    svc.transferCoordinator.mockResolvedValue({ capExceeded: true });

    const res = await call();

    expect(res.statusCode).toBe(409);
  });
});
