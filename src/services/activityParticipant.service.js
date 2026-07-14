import prisma from '../config/prisma.js';

/**
 * @module ActivityParticipantService
 * @description Registration-only cascade for activities (BUILD_PLAN.md Phase
 * 4 / gap #1). Mirrors the event.service.js group-join pattern. A row here
 * means "signed up", nothing more — it awards no points and creates no
 * CheckIn, so it never touches pointsLedger.service.js or checkin.service.js.
 */

const USER_SELECT = { select: { id: true, fullName: true, department: true, avatarUrl: true } };

/**
 * Caller's group membership (used to authorize a group enroll).
 * @param {string} groupId
 * @param {string} userId
 */
export const getGroupMembership = (groupId, userId) =>
  prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });

/**
 * Group enroll — a group's OWNER/ADMIN registers every current member.
 * Idempotent: members already registered (via this group or individually)
 * keep their existing row. Intentional: a member who previously called
 * leaveActivity() has no row, so re-running this re-adds them — "leave" is
 * a one-time opt-out, not a sticky exclusion. If a coordinator re-enrolls
 * the group, everyone (including past leavers) is back on the roster. This
 * was a deliberate call (2026-07-14): no suppression flag/table, so a
 * leaver who wants to stay off the roster has to leave again after each
 * re-enroll.
 * @param {string} activityId
 * @param {string} groupId
 * @returns {Promise<{added: number}>}
 */
export const enrollGroup = async (activityId, groupId) => {
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  if (!members.length) return { added: 0 };

  const result = await prisma.activityParticipant.createMany({
    data: members.map((m) => ({ activityId, userId: m.userId, groupId })),
    skipDuplicates: true,
  });
  return { added: result.count };
};

/**
 * Individual self-enroll — idempotent via the [activityId, userId] unique
 * constraint.
 * @param {string} activityId
 * @param {string} userId
 */
export const joinIndividual = (activityId, userId) =>
  prisma.activityParticipant.upsert({
    where: { activityId_userId: { activityId, userId } },
    create: { activityId, userId, groupId: null },
    update: {}, // already registered -> no-op
  });

/**
 * Remove only the caller's own participant row — opts them (and only them)
 * out of a group cascade or their own individual join.
 * @param {string} activityId
 * @param {string} userId
 */
export const leaveActivity = (activityId, userId) =>
  prisma.activityParticipant.deleteMany({ where: { activityId, userId } });

/**
 * The caller's own participant row, if any, with the enrolling group's name
 * (used to render the "your group already joined" badge).
 * @param {string} activityId
 * @param {string} userId
 */
export const getMyParticipation = (activityId, userId) =>
  prisma.activityParticipant.findUnique({
    where: { activityId_userId: { activityId, userId } },
    include: { group: { select: { id: true, name: true } } },
  });

/**
 * Full participant list for an activity, including which group (if any)
 * enrolled each row. Used by admin/coordinator views.
 * @param {string} activityId
 */
export const getParticipants = (activityId) =>
  prisma.activityParticipant.findMany({
    where: { activityId },
    include: {
      user: USER_SELECT,
      group: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

export default {
  getGroupMembership,
  enrollGroup,
  joinIndividual,
  leaveActivity,
  getMyParticipation,
  getParticipants,
};
