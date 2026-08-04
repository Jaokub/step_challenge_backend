import prisma from '../config/prisma.js';
import { resolveGroupAccess } from '../services/group.scope.js';

/**
 * Group membership/role middleware factory.
 *
 * Looks up the caller's membership in the group identified by `req.params.id`,
 * replacing the identical checks that used to be copy-pasted into every
 * group.controller handler. On success, attaches the membership record to
 * `req.groupMembership` so handlers can inspect the caller's role without a
 * second query.
 *
 * @param {Object} [options]
 * @param {string[]} [options.roles] - If set, the caller's role must be one of these.
 * @param {string} [options.roleMessage] - 403 message when the role check fails
 *   (kept configurable so each route preserves its original wording).
 * @param {number} [options.notMemberStatus=403] - Status when the caller is not a
 *   member (leaveGroup historically returns 404 here).
 * @param {string} [options.param='id'] - Which route param holds the group id.
 *   Routes that name it something else (e.g. `/group/:groupId`) must say so, or
 *   the lookup runs with `undefined` and denies everyone.
 * @returns {import('express').RequestHandler}
 *
 * @example
 * router.delete('/:id', authenticate, requireGroupMember({
 *   roles: ['OWNER'],
 *   roleMessage: 'Only the group owner can delete the group',
 * }), deleteGroup);
 */
export const requireGroupMember = ({ roles = null, roleMessage = 'Access denied. Insufficient permissions.', notMemberStatus = 403, param = 'id' } = {}) => {
  return async (req, res, next) => {
    try {
      const groupId = req.params[param];
      const userId = req.user.id;

      // Faculty Admin (global role) is a super-admin over every group —
      // bypasses membership/role checks entirely (BUILD_PLAN.md Phase 5,
      // "admin god-mode": edit hierarchy directly, remove any group,
      // override approvals, reassign any coordinator). req.groupMembership
      // is left null here; handlers that read it (e.g. leaveGroup) must
      // guard for that instead of assuming a real membership row.
      if (req.user.role === 'ADMIN') {
        req.groupMembership = null;
        return next();
      }

      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId } },
      });

      if (!membership) {
        // Distinguish "group doesn't exist" (404) from "not a member" (403/404)
        const group = await prisma.appGroup.findUnique({
          where: { id: groupId },
          select: { id: true },
        });
        if (!group) {
          return res.status(404).json({
            success: false,
            data: null,
            message: 'Group not found',
          });
        }
        return res.status(notMemberStatus).json({
          success: false,
          data: null,
          message: 'You are not a member of this group',
        });
      }

      if (roles && !roles.includes(membership.role)) {
        return res.status(403).json({
          success: false,
          data: null,
          message: roleMessage,
        });
      }

      req.groupMembership = membership;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

/**
 * Hierarchy visibility middleware factory. Resolves the caller's relation to
 * the target group (self / ancestor / sibling / none) via group.scope.js and
 * only allows the request through if that relation is in `allow`.
 *
 * ── The visibility model this enforces (settled with the product owner,
 *    2026-08-03; see CLAUDE.md "Hierarchy visibility") ──
 *
 *   viewer → target      overall stats   full member ranking
 *   self                 ✅              ✅
 *   ancestor (parent…)   ✅              ✅
 *   descendant (child)   ✅              ❌  (stats + top 3 only)
 *   sibling              ✅              ❌  (stats + top 3 only)
 *   unrelated            ❌              ❌
 *
 * Member-level ranking flows DOWNWARD only. Looking up or sideways gets an
 * aggregate plus a bounded Top-3 preview, never the full list.
 *
 * `allow: ['self', 'ancestor']` is therefore the guard for every full-ranking
 * route. Siblings and children reach their bounded view through different
 * endpoints (`/groups/:id/siblings`, `/groups/:id/hierarchy-overview`), which
 * slice to top3 in the service layer — this middleware is what stops them
 * calling the full-ranking route directly.
 *
 * Note "ancestor" is granted on MEMBERSHIP in an ancestor group, deliberately
 * without a role check: any member of a parent group sees its descendants'
 * rankings. Group OWNER/ADMIN is about administering a group (settings,
 * enrolling it into activities), not about seeing more.
 *
 * @param {string[]} allow - relations that may proceed, e.g. ['self', 'ancestor'].
 * @param {Object} [options]
 * @param {string} [options.param='id'] - Which route param holds the group id.
 * @returns {import('express').RequestHandler}
 *
 * @example
 * router.get('/:id/overview', authenticate, requireGroupVisibility(['self', 'ancestor']), getGroupOverview);
 */
export const requireGroupVisibility = (allow, { param = 'id' } = {}) => {
  return async (req, res, next) => {
    try {
      const groupId = req.params[param];
      const userId = req.user.id;

      const target = await prisma.appGroup.findUnique({
        where: { id: groupId },
        select: { id: true, parentGroupId: true },
      });
      if (!target) {
        return res.status(404).json({
          success: false,
          data: null,
          message: 'Group not found',
        });
      }

      // Faculty Admin (global role) bypasses the relation check entirely —
      // same god-mode rationale as requireGroupMember's bypass above.
      if (req.user.role === 'ADMIN') {
        req.groupRelation = 'ancestor';
        req.groupNode = target;
        return next();
      }

      const { relation } = await resolveGroupAccess(userId, groupId);

      if (!relation || !allow.includes(relation)) {
        return res.status(403).json({
          success: false,
          data: null,
          message: 'You do not have permission to view this group',
        });
      }

      req.groupRelation = relation;
      req.groupNode = target;
      return next();
    } catch (error) {
      return next(error);
    }
  };
};
