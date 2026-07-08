import prisma from '../config/prisma.js';

/**
 * @module GroupScope
 * @description Resolves a viewer's relationship to a target group in the
 * (shallow, 2-level) group hierarchy: self / ancestor (parent looking at a
 * descendant) / sibling (shares the same parent) / none.
 *
 * Tree is only 2 levels deep (Faculty -> Dept), so plain findMany calls are
 * enough — no recursive CTE needed.
 */

/**
 * @param {string} groupId
 * @returns {Promise<{id: string, parentGroupId: string|null}|null>}
 */
export const getGroupNode = async (groupId) => {
  return prisma.appGroup.findUnique({
    where: { id: groupId },
    select: { id: true, parentGroupId: true },
  });
};

/**
 * All group IDs the given user is a member of.
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
export const getViewerGroupIds = async (userId) => {
  const memberships = await prisma.groupMember.findMany({
    where: { userId },
    select: { groupId: true },
  });
  return memberships.map((m) => m.groupId);
};

/**
 * Resolve how `userId` relates to `targetGroupId`.
 *
 * - 'self'     — userId is a member of targetGroupId itself.
 * - 'ancestor' — userId is a member of targetGroupId's parent (sees everything).
 * - 'sibling'  — userId is a member of a group that shares targetGroupId's parent.
 * - null       — no relationship; access denied.
 *
 * @param {string} userId
 * @param {string} targetGroupId
 * @returns {Promise<{relation: 'self'|'ancestor'|'sibling'|null, target: {id: string, parentGroupId: string|null}|null}>}
 */
export const resolveGroupAccess = async (userId, targetGroupId) => {
  const target = await getGroupNode(targetGroupId);
  if (!target) return { relation: null, target: null };

  const viewerGroupIds = await getViewerGroupIds(userId);
  const viewerGroupIdSet = new Set(viewerGroupIds);

  if (viewerGroupIdSet.has(targetGroupId)) {
    return { relation: 'self', target };
  }

  if (target.parentGroupId && viewerGroupIdSet.has(target.parentGroupId)) {
    return { relation: 'ancestor', target };
  }

  if (target.parentGroupId) {
    // Sibling: viewer belongs to another group with the same parent.
    const siblingMembership = await prisma.groupMember.findFirst({
      where: {
        userId,
        group: { parentGroupId: target.parentGroupId, id: { not: targetGroupId } },
      },
      select: { groupId: true },
    });
    if (siblingMembership) {
      return { relation: 'sibling', target };
    }
  }

  return { relation: null, target };
};

/**
 * Sibling groups of `groupId` (same parent, excluding itself). Empty array
 * if the group has no parent.
 * @param {string} groupId
 * @param {string|null} parentGroupId
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export const getSiblingGroups = async (groupId, parentGroupId) => {
  if (!parentGroupId) return [];
  return prisma.appGroup.findMany({
    where: { parentGroupId, id: { not: groupId } },
    select: { id: true, name: true },
  });
};

/**
 * Direct child groups of `groupId`.
 * @param {string} groupId
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export const getChildGroups = async (groupId) => {
  return prisma.appGroup.findMany({
    where: { parentGroupId: groupId },
    select: { id: true, name: true },
  });
};

export default {
  getGroupNode,
  getViewerGroupIds,
  resolveGroupAccess,
  getSiblingGroups,
  getChildGroups,
};
