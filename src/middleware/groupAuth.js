import prisma from '../config/prisma.js';

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
 * @returns {import('express').RequestHandler}
 *
 * @example
 * router.delete('/:id', authenticate, requireGroupMember({
 *   roles: ['OWNER'],
 *   roleMessage: 'Only the group owner can delete the group',
 * }), deleteGroup);
 */
export const requireGroupMember = ({ roles = null, roleMessage = 'Access denied. Insufficient permissions.', notMemberStatus = 403 } = {}) => {
  return async (req, res, next) => {
    try {
      const groupId = req.params.id;
      const userId = req.user.id;

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
