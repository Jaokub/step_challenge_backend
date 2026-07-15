import prisma from '../config/prisma.js';
import { MAX_GROUP_DEPTH, getAncestorIds } from './group.scope.js';

/**
 * @module GroupHierarchyService
 * @description Data-layer helpers for BUILD_PLAN.md Phase 5 (gap #3): the
 * parent-group request/approve flow, the admin direct-override path, and
 * coordinator transfer. Mirrors activityParticipant.service.js's split —
 * this file stays a thin prisma layer; authorization/validation lives in
 * groupHierarchy.controller.js (and, for the admin override, in
 * group.controller.js's updateGroup). Never touches pointsLedger.service.js
 * or the points schema.
 *
 * Phase 5.1: the tree may be up to MAX_GROUP_DEPTH levels deep, so linking a
 * child under a parent is guarded by wouldCreateCycle + depthWouldExceed
 * instead of the old "parent must be a root" rule.
 */

// ─── Multi-level tree guards (Phase 5.1) ───────────────────────────────────

/**
 * All descendant group ids of `rootId` (excludes the group itself), collected
 * breadth-first and bounded by MAX_GROUP_DEPTH so a malformed cycle can't spin.
 * @param {string} rootId
 * @returns {Promise<string[]>}
 */
export const getDescendantIds = async (rootId) => {
  const result = [];
  let frontier = [rootId];
  for (let depth = 0; depth <= MAX_GROUP_DEPTH + 1 && frontier.length; depth++) {
    const children = await prisma.appGroup.findMany({
      where: { parentGroupId: { in: frontier } },
      select: { id: true },
    });
    const ids = children.map((c) => c.id).filter((id) => id !== rootId && !result.includes(id));
    if (ids.length === 0) break;
    result.push(...ids);
    frontier = ids;
  }
  return result;
};

/**
 * Height of the subtree rooted at `groupId` in LEVELS below it (0 = leaf).
 * @param {string} groupId
 * @returns {Promise<number>}
 */
export const getSubtreeHeight = async (groupId) => {
  let height = 0;
  let frontier = [groupId];
  for (let i = 0; i <= MAX_GROUP_DEPTH + 1; i++) {
    const children = await prisma.appGroup.findMany({
      where: { parentGroupId: { in: frontier } },
      select: { id: true },
    });
    if (children.length === 0) break;
    height += 1;
    frontier = children.map((c) => c.id);
  }
  return height;
};

/**
 * True if making `childId` a child of `proposedParentId` would create a cycle
 * (self-parent, or the parent already lives inside the child's subtree).
 * @param {string} childId
 * @param {string} proposedParentId
 * @returns {Promise<boolean>}
 */
export const wouldCreateCycle = async (childId, proposedParentId) => {
  if (childId === proposedParentId) return true;
  // If the child is an ancestor of the proposed parent, linking loops.
  const parentAncestors = await getAncestorIds(proposedParentId);
  if (parentAncestors.includes(childId)) return true;
  // If the proposed parent is a descendant of the child, linking loops.
  const childDescendants = await getDescendantIds(childId);
  return childDescendants.includes(proposedParentId);
};

/**
 * True if linking `childId` under `proposedParentId` would push the deepest
 * leaf of the child's subtree past MAX_GROUP_DEPTH levels. Levels are 1-based
 * (a root is level 1).
 * @param {string} childId
 * @param {string} proposedParentId
 * @returns {Promise<boolean>}
 */
export const depthWouldExceed = async (childId, proposedParentId) => {
  const parentLevel = (await getAncestorIds(proposedParentId)).length + 1;
  const childHeight = await getSubtreeHeight(childId);
  const deepestLevel = parentLevel + 1 + childHeight; // +1 for the child itself
  return deepestLevel > MAX_GROUP_DEPTH;
};

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
 * 14). Phase 5.1: no longer restricted to root groups — any group may be a
 * parent as long as it isn't the group itself or one of its descendants
 * (which would create a cycle). The remaining depth limit is enforced at
 * request time by depthWouldExceed (a candidate that passes the cycle filter
 * but would breach MAX_GROUP_DEPTH is still rejected on submit — the picker
 * may optionally grey those out once the frontend surfaces each candidate's
 * level).
 */
export const searchParentCandidates = async (excludeGroupId, search) => {
  const descendantIds = await getDescendantIds(excludeGroupId);
  return prisma.appGroup.findMany({
    where: {
      id: { notIn: [excludeGroupId, ...descendantIds] },
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    },
    include: { _count: { select: { members: true } } },
    orderBy: { name: 'asc' },
    take: 30,
  });
};

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
 * Every root group (parentGroupId null), recursively expanded down to
 * MAX_GROUP_DEPTH levels (Phase 5.1 — the tree is no longer assumed to be 2
 * levels). Each node also carries any group with a still-PENDING request to
 * join it as parent, nested in `children` alongside its real children and
 * flagged `pending` (so the admin can see + override-approve in context) —
 * a pending group is intrinsically flagged (it has at most one PENDING
 * outgoing request, enforced in requestParent), not something computed
 * per-caller, so it shows up both under its real parent (if any, none for a
 * fresh standalone group) AND nested under its *requested* parent.
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

  const groupById = new Map(allGroups.map((g) => [g.id, g]));
  const pendingByChildId = new Map(pendingRequests.map((r) => [r.childGroupId, r]));
  const childrenByParentId = new Map();
  for (const g of allGroups) {
    if (!g.parentGroupId) continue;
    if (!childrenByParentId.has(g.parentGroupId)) childrenByParentId.set(g.parentGroupId, []);
    childrenByParentId.get(g.parentGroupId).push(g);
  }

  const buildNode = (group, level) => {
    const pendingReq = pendingByChildId.get(group.id);
    const actualChildren = childrenByParentId.get(group.id) ?? [];
    // Pseudo-children: groups requesting group.id as parent that aren't
    // already its real child (would otherwise double-list them).
    const pendingChildren =
      level < MAX_GROUP_DEPTH
        ? allGroups.filter((c) => {
            const r = pendingByChildId.get(c.id);
            return r && r.parentGroupId === group.id && c.parentGroupId !== group.id;
          })
        : [];
    const childGroups = level >= MAX_GROUP_DEPTH ? [] : [...actualChildren, ...pendingChildren];

    return {
      id: group.id,
      name: group.name,
      kind: actualChildren.length > 0 ? 'PARENT' : 'STANDALONE',
      members: group._count.members,
      coordinator: group.members[0]?.user?.fullName ?? null,
      childCount: actualChildren.length,
      pending: !!pendingReq,
      pendingParent: pendingReq ? groupById.get(pendingReq.parentGroupId)?.name ?? null : null,
      pendingRequestId: pendingReq?.id ?? null,
      children: childGroups.map((c) => buildNode(c, level + 1)),
    };
  };

  const roots = allGroups.filter((g) => g.parentGroupId === null);
  return roots.map((root) => buildNode(root, 1));
};

export default {
  getGroup,
  getOwnerMembership,
  getMembership,
  countOwnedGroups,
  getDescendantIds,
  getSubtreeHeight,
  wouldCreateCycle,
  depthWouldExceed,
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
