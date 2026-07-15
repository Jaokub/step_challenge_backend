import prisma from '../config/prisma.js';

/**
 * @module GroupHierarchyService
 * @description Data-layer helpers for BUILD_PLAN.md Phase 5 (gap #3): the
 * parent-group request/approve flow, the admin direct-override path, and
 * coordinator transfer. Mirrors activityParticipant.service.js's split —
 * this file stays a thin prisma layer; authorization/validation lives in
 * groupHierarchy.controller.js (and, for the admin override, in
 * group.controller.js's updateGroup). Never touches pointsLedger.service.js
 * or the points schema.
 */

const CHILD_SELECT = { select: { id: true, name: true, _count: { select: { members: true } } } };
const PARENT_SELECT = { select: { id: true, name: true } };

// ─── Membership / lookups shared with controllers ─────────────────────────

export const getGroup = (id) => prisma.appGroup.findUnique({ where: { id } });

export const getOwnerMembership = (groupId) =>
  prisma.groupMember.findFirst({ where: { groupId, role: 'OWNER' } });

export const getMembership = (groupId, userId) =>
  prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });

/** Cap-consistency fix (Phase 5 gap #6): count OWNER rows, not createdById. */
export const countOwnedGroups = (userId) =>
  prisma.groupMember.count({ where: { userId, role: 'OWNER' } });

// ─── Parent-request / approve / deny ───────────────────────────────────────

export const getPendingRequestForChild = (childGroupId) =>
  prisma.groupParentRequest.findFirst({ where: { childGroupId, status: 'PENDING' } });

/**
 * Candidate parent groups for a coordinator's picker sheet (mockup frame
 * 14). Restricted to root groups (parentGroupId null) to keep the tree
 * shallow (2 levels), per the schema's documented design.
 */
export const searchParentCandidates = (excludeGroupId, search) =>
  prisma.appGroup.findMany({
    where: {
      id: { not: excludeGroupId },
      parentGroupId: null,
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    },
    include: { _count: { select: { members: true } } },
    orderBy: { name: 'asc' },
    take: 30,
  });

export const createParentRequest = ({ childGroupId, parentGroupId, requestedById }) =>
  prisma.groupParentRequest.create({
    data: { childGroupId, parentGroupId, requestedById, status: 'PENDING' },
  });

export const getIncomingRequests = (parentGroupId) =>
  prisma.groupParentRequest.findMany({
    where: { parentGroupId, status: 'PENDING' },
    include: { childGroup: CHILD_SELECT },
    orderBy: { createdAt: 'asc' },
  });

export const getRequestById = (requestId) =>
  prisma.groupParentRequest.findUnique({
    where: { id: requestId },
    include: { childGroup: CHILD_SELECT, parentGroup: PARENT_SELECT },
  });

/**
 * Resolve a pending request. On APPROVED, sets the child's parentGroupId in
 * the same transaction so the two rows can never disagree.
 * @param {string} requestId
 * @param {'APPROVED'|'DENIED'} status
 */
export const resolveRequest = (requestId, status) =>
  prisma.$transaction(async (tx) => {
    const updated = await tx.groupParentRequest.update({
      where: { id: requestId },
      data: { status, resolvedAt: new Date() },
    });
    if (status === 'APPROVED') {
      await tx.appGroup.update({
        where: { id: updated.childGroupId },
        data: { parentGroupId: updated.parentGroupId },
      });
    }
    return updated;
  });

/**
 * Admin direct override (PUT /groups/:id, parentGroupId field): set,
 * reassign, or detach (null) a group's parent with no request flow. Any
 * still-pending request for this child is superseded — resolved to match
 * the override outcome so it doesn't dangle forever.
 * @param {string} childGroupId
 * @param {string|null} newParentId
 */
export const overrideParent = (childGroupId, newParentId) =>
  prisma.$transaction(async (tx) => {
    const group = await tx.appGroup.update({
      where: { id: childGroupId },
      data: { parentGroupId: newParentId },
    });
    await tx.groupParentRequest.updateMany({
      where: { childGroupId, status: 'PENDING' },
      data: { status: newParentId ? 'APPROVED' : 'DENIED', resolvedAt: new Date() },
    });
    return group;
  });

// ─── Coordinator transfer (gap #6) ─────────────────────────────────────────

/**
 * Transfer the OWNER role for a group from its current coordinator to
 * `targetUserId`. Caller-side authorization (coordinator-initiated vs
 * admin-override, "target must already be a member" for the
 * coordinator-initiated path) is checked in the controller before this
 * runs; this function assumes the caller already validated everything
 * except the live cap count, which it re-checks inside the transaction to
 * avoid a race.
 * @param {string} groupId
 * @param {string} targetUserId
 * @returns {Promise<{ownerMembershipId: string, alreadyOwner: boolean} | {capExceeded: true}>}
 */
export const transferCoordinator = (groupId, targetUserId) =>
  prisma.$transaction(async (tx) => {
    const currentOwner = await tx.groupMember.findFirst({ where: { groupId, role: 'OWNER' } });

    if (currentOwner && currentOwner.userId === targetUserId) {
      return { alreadyOwner: true };
    }

    const targetOwnedCount = await tx.groupMember.count({
      where: { userId: targetUserId, role: 'OWNER' },
    });
    if (targetOwnedCount >= 3) {
      return { capExceeded: true };
    }

    if (currentOwner) {
      await tx.groupMember.update({ where: { id: currentOwner.id }, data: { role: 'MEMBER' } });
    }

    const targetMembership = await tx.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });

    const newOwner = targetMembership
      ? await tx.groupMember.update({ where: { id: targetMembership.id }, data: { role: 'OWNER' } })
      : await tx.groupMember.create({ data: { groupId, userId: targetUserId, role: 'OWNER' } });

    return { ownerMembershipId: newOwner.id };
  });

// ─── Admin god-mode tree (mockup frame 6) ──────────────────────────────────

/**
 * Every root group (parentGroupId null) with its actual children plus any
 * groups that have a PENDING request to join it as parent (shown nested,
 * flagged `pending`, so the admin can see + override-approve/deny in
 * context) — deliberately not a recursive/N-level walk; the schema's tree
 * is shallow (2 levels) by design.
 */
export const getAdminGroupTrees = async () => {
  const [allGroups, pendingRequests] = await Promise.all([
    prisma.appGroup.findMany({
      include: {
        _count: { select: { members: true } },
        members: {
          where: { role: 'OWNER' },
          include: { user: { select: { fullName: true } } },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.groupParentRequest.findMany({ where: { status: 'PENDING' } }),
  ]);

  const pendingByChildId = new Map(pendingRequests.map((r) => [r.childGroupId, r]));
  const roots = allGroups.filter((g) => g.parentGroupId === null);

  const toNode = (g, pendingReq, pendingParentName) => ({
    id: g.id,
    name: g.name,
    members: g._count.members,
    coordinator: g.members[0]?.user?.fullName ?? null,
    pending: !!pendingReq,
    pendingParent: pendingParentName ?? null,
    pendingRequestId: pendingReq?.id ?? null,
  });

  return roots.map((root) => {
    const actualChildren = allGroups.filter((g) => g.parentGroupId === root.id);
    const pendingChildren = allGroups.filter((g) => {
      const req = pendingByChildId.get(g.id);
      return req && req.parentGroupId === root.id && g.parentGroupId !== root.id;
    });
    return {
      root: {
        id: root.id,
        name: root.name,
        kind: actualChildren.length > 0 ? 'PARENT' : 'STANDALONE',
        members: root._count.members,
        coordinator: root.members[0]?.user?.fullName ?? null,
        childCount: actualChildren.length,
      },
      children: [
        ...actualChildren.map((c) => toNode(c, null, null)),
        ...pendingChildren.map((c) => toNode(c, pendingByChildId.get(c.id), root.name)),
      ],
    };
  });
};

export default {
  getGroup,
  getOwnerMembership,
  getMembership,
  countOwnedGroups,
  getPendingRequestForChild,
  searchParentCandidates,
  createParentRequest,
  getIncomingRequests,
  getRequestById,
  resolveRequest,
  overrideParent,
  transferCoordinator,
  getAdminGroupTrees,
};
