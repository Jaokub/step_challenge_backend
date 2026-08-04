import prisma from '../config/prisma.js';

/**
 * @module GroupScope
 * @description Resolves a viewer's relationship to a target group in the group
 * hierarchy: self / ancestor (any group up the chain looking at a descendant) /
 * sibling (shares the same immediate parent) / none.
 *
 * BUILD_PLAN.md Phase 5.1: the tree used to be a fixed 2 levels (Faculty ->
 * Dept). It now supports up to `MAX_GROUP_DEPTH` levels, so "ancestor" means
 * *any* group on the target's parent chain, not just its immediate parent. The
 * chain is walked one level at a time (bounded by MAX_GROUP_DEPTH, so a handful
 * of point-lookups — no recursive CTE). Sibling stays "shares the target's
 * IMMEDIATE parent".
 */

/**
 * Maximum hierarchy depth measured in LEVELS (root = level 1). Default 3 =>
 * Faculty -> Dept -> lab. ⚠️ BUILD_PLAN.md Phase 5.1 marks the exact value as
 * advisor-gated — tune here; every guard reads this constant.
 */
export const MAX_GROUP_DEPTH = 3;

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
 * All ancestor group ids of `groupId`, nearest-parent first (excludes the
 * group itself). Walks `parentGroupId` upward, capped at `MAX_GROUP_DEPTH + 1`
 * iterations so a malformed cycle can never spin forever.
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export const getAncestorIds = async (groupId) => {
  const ancestors = [];
  let currentId = groupId;
  for (let i = 0; i <= MAX_GROUP_DEPTH + 1; i++) {
    const node = await prisma.appGroup.findUnique({
      where: { id: currentId },
      select: { parentGroupId: true },
    });
    if (!node || !node.parentGroupId) break;
    if (ancestors.includes(node.parentGroupId)) break; // cycle safety net
    ancestors.push(node.parentGroupId);
    currentId = node.parentGroupId;
  }
  return ancestors;
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
 * - 'ancestor' — userId is a member of ANY group on targetGroupId's parent
 *                chain (immediate parent, grandparent, …) — sees everything.
 * - 'sibling'  — userId is a member of a group that shares targetGroupId's
 *                IMMEDIATE parent.
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

  // Ancestor: viewer belongs to any group up the target's parent chain, not
  // just the immediate parent (Phase 5.1 — a Faculty coordinator sees any
  // dept/lab beneath them, at any depth).
  if (target.parentGroupId) {
    const ancestorIds = await getAncestorIds(targetGroupId);
    if (ancestorIds.some((id) => viewerGroupIdSet.has(id))) {
      return { relation: 'ancestor', target };
    }
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
 * Every descendant of each given group, batched — the read side of ADR-003.
 *
 * Walks the tree one level at a time for ALL requested roots at once, so the
 * query count is bounded by depth rather than by how many groups were asked
 * for. That property is what lets `getGroupsPeriodSteps` aggregate a whole
 * subtree without an N+1; see ADR-003 "The engine".
 *
 * Selects `name` alongside `id` because callers need it for the sub-group
 * badges on ranking rows, and fetching it here avoids a second lookup.
 *
 * A group has exactly one parent, so subtrees of unrelated roots are disjoint
 * — but a caller may legitimately ask for a group AND one of its own
 * descendants (the group-detail screen asks for self + parent + siblings +
 * children at once). Attribution is therefore per-root, and a group can appear
 * in more than one root's list.
 *
 * @param {string[]} groupIds - roots to expand. Duplicates are ignored.
 * @returns {Promise<Map<string, Array<{id: string, name: string}>>>} descendants
 *   per root, **excluding the root itself**, breadth-first.
 */
export const getSubtreeGroups = async (groupIds) => {
  const roots = [...new Set(groupIds)];
  const result = new Map(roots.map((id) => [id, []]));
  if (roots.length === 0) return result;

  // groupId -> the roots whose subtree it currently sits in.
  let frontier = new Map(roots.map((id) => [id, new Set([id])]));
  // Per root, everything already attributed. Seeded with the root so it is
  // never listed as its own descendant, and so a malformed cycle terminates
  // instead of re-adding groups forever.
  const seen = new Map(roots.map((id) => [id, new Set([id])]));

  for (let depth = 0; depth <= MAX_GROUP_DEPTH + 1 && frontier.size; depth++) {
    const children = await prisma.appGroup.findMany({
      where: { parentGroupId: { in: [...frontier.keys()] } },
      select: { id: true, name: true, parentGroupId: true },
    });
    if (children.length === 0) break;

    const next = new Map();
    for (const child of children) {
      const owningRoots = frontier.get(child.parentGroupId);
      if (!owningRoots) continue;

      for (const rootId of owningRoots) {
        if (seen.get(rootId).has(child.id)) continue;
        seen.get(rootId).add(child.id);
        result.get(rootId).push({ id: child.id, name: child.name });

        if (!next.has(child.id)) next.set(child.id, new Set());
        next.get(child.id).add(rootId);
      }
    }
    frontier = next;
  }

  return result;
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
  MAX_GROUP_DEPTH,
  getGroupNode,
  getAncestorIds,
  getViewerGroupIds,
  resolveGroupAccess,
  getSubtreeGroups,
  getSiblingGroups,
  getChildGroups,
};
