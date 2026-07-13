import prisma from '../config/prisma.js';
import {
  getGroupMembership,
  enrollGroup,
  joinIndividual,
  leaveActivity as leaveActivityService,
  getParticipants,
} from '../services/activityParticipant.service.js';

/**
 * @module ActivityParticipantController
 * @description Thin HTTP layer for the activity registration cascade
 * (BUILD_PLAN.md Phase 4). All logic lives in activityParticipant.service.js.
 */

const ok = (res, data, message) => res.json({ success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ success: false, data: null, message });

const OPEN_STATUSES = new Set(['UPCOMING', 'ONGOING']);

/**
 * POST /activities/:id/enroll-group
 * body: { groupId }
 * Caller must be OWNER/ADMIN of groupId.
 */
export const enrollGroupIntoActivity = async (req, res, next) => {
  try {
    const activityId = req.params.id;
    const { groupId } = req.body;
    if (!groupId) return fail(res, 400, 'groupId is required.');

    const activity = await prisma.activity.findUnique({ where: { id: activityId } });
    if (!activity) return fail(res, 404, 'Activity not found.');
    if (!OPEN_STATUSES.has(activity.status)) {
      return fail(res, 400, 'This activity is no longer open for enrollment.');
    }

    const membership = await getGroupMembership(groupId, req.user.id);
    if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
      return fail(res, 403, 'Only a group owner or admin can enroll the group in an activity.');
    }

    const { added } = await enrollGroup(activityId, groupId);
    return ok(res, { added }, `Group enrolled. ${added} member(s) registered.`);
  } catch (error) {
    return next(error);
  }
};

/** POST /activities/:id/join — individual self-enroll. */
export const joinActivity = async (req, res, next) => {
  try {
    const activityId = req.params.id;
    const activity = await prisma.activity.findUnique({ where: { id: activityId } });
    if (!activity) return fail(res, 404, 'Activity not found.');
    if (!OPEN_STATUSES.has(activity.status)) {
      return fail(res, 400, 'This activity is no longer open for enrollment.');
    }

    await joinIndividual(activityId, req.user.id);
    return ok(res, { added: 1 }, 'Registered for this activity.');
  } catch (error) {
    return next(error);
  }
};

/** DELETE /activities/:id/leave — removes only the caller's own row. */
export const leaveActivity = async (req, res, next) => {
  try {
    await leaveActivityService(req.params.id, req.user.id);
    return ok(res, null, 'Left the activity registration.');
  } catch (error) {
    return next(error);
  }
};

/**
 * GET /activities/:id/participants
 * Access: global ADMIN, or a caller who already has a participant row for
 * this activity (i.e. they or their group are enrolled).
 */
export const getActivityParticipants = async (req, res, next) => {
  try {
    const activityId = req.params.id;
    const activity = await prisma.activity.findUnique({ where: { id: activityId } });
    if (!activity) return fail(res, 404, 'Activity not found.');

    if (req.user.role !== 'ADMIN') {
      const own = await prisma.activityParticipant.findUnique({
        where: { activityId_userId: { activityId, userId: req.user.id } },
      });
      if (!own) return fail(res, 403, 'You are not registered for this activity.');
    }

    const participants = await getParticipants(activityId);
    return ok(res, participants, 'Participants retrieved successfully.');
  } catch (error) {
    return next(error);
  }
};
