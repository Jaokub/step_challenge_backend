import {
  getGroup,
  getMembership,
  getPendingRequestForChild,
  searchParentCandidates,
  createParentRequest,
  getIncomingRequests,
  getRequestById,
  resolveRequest,
  transferCoordinator as transferCoordinatorService,
  getAdminGroupTrees,
} from '../services/groupHierarchy.service.js';

/**
 * @module GroupHierarchyController
 * @description Thin HTTP layer for BUILD_PLAN.md Phase 5 (gap #3 + gap #6):
 * parent-group request/approve/deny, the admin god-mode tree, and
 * coordinator transfer. The admin *override* path (PUT /groups/:id
 * parentGroupId) lives in group.controller.js's updateGroup — this file
 * only owns the request/approve/deny flow, the candidate picker, the
 * read-only admin tree, and the transfer endpoint.
 */

const ok = (res, data, message) => res.json({ success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ success: false, data: null, message });

/**
 * GET /groups/:id/parent-candidates?search=
 * Caller must be OWNER of :id (requireGroupMember middleware; Faculty
 * Admin bypasses via the same middleware).
 */
export const getParentCandidates = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const search = (req.query.search ?? '').toString().trim();

    const [candidates, pending] = await Promise.all([
      searchParentCandidates(groupId, search),
      getPendingRequestForChild(groupId),
    ]);

    const data = candidates.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g._count.members,
      requested: pending?.parentGroupId === g.id,
    }));

    return ok(res, { candidates: data, pendingRequestId: pending?.id ?? null }, 'Parent candidates retrieved.');
  } catch (error) {
    return next(error);
  }
};

/**
 * POST /groups/:id/parent-request
 * body: { parentGroupId }
 * Caller must be OWNER of :id.
 */
export const requestParent = async (req, res, next) => {
  try {
    const childGroupId = req.params.id;
    const { parentGroupId } = req.body;
    if (!parentGroupId) return fail(res, 400, 'parentGroupId is required.');
    if (parentGroupId === childGroupId) return fail(res, 400, 'A group cannot be its own parent.');

    const parent = await getGroup(parentGroupId);
    if (!parent) return fail(res, 404, 'Parent group not found.');
    if (parent.parentGroupId) {
      return fail(res, 400, 'That group already has a parent — the tree only supports two levels.');
    }

    const existing = await getPendingRequestForChild(childGroupId);
    if (existing) return fail(res, 409, 'A parent-group request is already pending for this group.');

    const request = await createParentRequest({
      childGroupId,
      parentGroupId,
      requestedById: req.user.id,
    });
    return res.status(201).json({ success: true, data: request, message: 'Request sent — waiting on approval.' });
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /groups/:id/parent-requests
 * Incoming requests where :id is the prospective parent. Caller must be
 * OWNER of :id (or Faculty Admin, via middleware bypass).
 */
export const listIncomingRequests = async (req, res, next) => {
  try {
    const requests = await getIncomingRequests(req.params.id);
    return ok(res, requests, 'Incoming parent-group requests retrieved.');
  } catch (error) {
    return next(error);
  }
};

const resolve = (status) => async (req, res, next) => {
  try {
    const { id: parentGroupId, requestId } = req.params;
    const request = await getRequestById(requestId);
    if (!request) return fail(res, 404, 'Request not found.');
    if (request.parentGroupId !== parentGroupId) return fail(res, 404, 'Request not found.');
    if (request.status !== 'PENDING') return fail(res, 409, 'This request has already been resolved.');

    const updated = await resolveRequest(requestId, status);
    return ok(res, updated, status === 'APPROVED' ? 'Request approved.' : 'Request denied.');
  } catch (error) {
    return next(error);
  }
};

/** POST /groups/:id/parent-requests/:requestId/approve */
export const approveRequest = resolve('APPROVED');
/** POST /groups/:id/parent-requests/:requestId/deny */
export const denyRequest = resolve('DENIED');

/**
 * POST /groups/:id/transfer-coordinator
 * body: { userId }
 * Two authorization paths:
 *  - Coordinator-initiated: caller is the group's current OWNER; target
 *    must already be a MEMBER of the group.
 *  - Admin override: caller is a global ADMIN; target need not already be
 *    a member (mockup frame 6 "เปลี่ยนผู้ประสานงาน").
 * Not gated behind requireGroupMember — a global admin transferring a
 * group they don't belong to would 404 there — so the checks live here.
 */
export const transferCoordinator = async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const { userId: targetUserId } = req.body;
    if (!targetUserId) return fail(res, 400, 'userId is required.');

    const group = await getGroup(groupId);
    if (!group) return fail(res, 404, 'Group not found.');

    const isAdmin = req.user.role === 'ADMIN';

    if (!isAdmin) {
      const callerMembership = await getMembership(groupId, req.user.id);
      if (!callerMembership || callerMembership.role !== 'OWNER') {
        return fail(res, 403, 'Only the group coordinator can transfer coordinator rights.');
      }
      const targetMembership = await getMembership(groupId, targetUserId);
      if (!targetMembership || targetMembership.role !== 'MEMBER') {
        return fail(res, 400, 'The new coordinator must already be a member of this group.');
      }
    }

    const result = await transferCoordinatorService(groupId, targetUserId);
    if (result.alreadyOwner) return fail(res, 409, 'This user is already the coordinator.');
    if (result.capExceeded) {
      return fail(res, 409, 'This user already coordinates 3 groups — the maximum allowed.');
    }

    return ok(res, result, 'Coordinator transferred.');
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /groups/admin/tree
 * Faculty Admin only (requireRole('ADMIN') on the route).
 */
export const getAdminTree = async (req, res, next) => {
  try {
    const trees = await getAdminGroupTrees();
    return ok(res, trees, 'Group hierarchy retrieved.');
  } catch (error) {
    return next(error);
  }
};
