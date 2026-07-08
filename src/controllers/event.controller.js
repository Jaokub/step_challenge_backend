import {
  createEvent as createEventService,
  listEvents,
  getEventById,
  getGroupMembership,
  joinIndividual,
  joinByGroup,
  leaveEvent as leaveEventService,
  getParticipation,
} from '../services/event.service.js';
import {
  getIndividualLeaderboard,
  getGroupLeaderboard,
  getEventStats,
} from '../services/eventStats.service.js';

/**
 * @module EventController
 * @description Thin HTTP layer for step-count events. All logic lives in
 * event.service.js (CRUD/join) and eventStats.service.js (aggregation).
 */

const ok = (res, data, message) => res.json({ success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ success: false, data: null, message });

/** POST /events (admin only) */
export const createEvent = async (req, res, next) => {
  try {
    const { title, description, startDate, endDate } = req.body;
    if (new Date(endDate) < new Date(startDate)) {
      return fail(res, 400, 'endDate must be on or after startDate.');
    }
    const event = await createEventService({ title, description, startDate, endDate, createdById: req.user.id });
    return res.status(201).json({ success: true, data: event, message: 'Event created successfully.' });
  } catch (error) {
    return next(error);
  }
};

/** GET /events */
export const getEvents = async (_req, res, next) => {
  try {
    const events = await listEvents();
    return ok(res, events, 'Events retrieved successfully.');
  } catch (error) {
    return next(error);
  }
};

/** GET /events/:id — includes whether the caller has joined. */
export const getEvent = async (req, res, next) => {
  try {
    const event = await getEventById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    const participation = await getParticipation(req.params.id, req.user.id);
    return ok(res, { ...event, joined: !!participation, joinMode: participation?.joinMode ?? null }, 'Event retrieved successfully.');
  } catch (error) {
    return next(error);
  }
};

/**
 * POST /events/:id/join
 * body: { mode: 'INDIVIDUAL' | 'GROUP', groupId?: string }
 * GROUP mode requires the caller to be OWNER/ADMIN of groupId.
 */
export const joinEvent = async (req, res, next) => {
  try {
    const eventId = req.params.id;
    const { mode, groupId } = req.body;

    const event = await getEventById(eventId);
    if (!event) return fail(res, 404, 'Event not found.');
    if (event.status === 'COMPLETED' || event.status === 'CANCELLED') {
      return fail(res, 400, 'This event is no longer open to join.');
    }

    if (mode === 'GROUP') {
      if (!groupId) return fail(res, 400, 'groupId is required to join as a group.');
      const membership = await getGroupMembership(groupId, req.user.id);
      if (!membership || !['OWNER', 'ADMIN'].includes(membership.role)) {
        return fail(res, 403, 'Only a group owner or admin can enroll the group in an event.');
      }
      const { added } = await joinByGroup(eventId, groupId);
      return ok(res, { added }, `Group enrolled. ${added} member(s) added.`);
    }

    if (mode === 'INDIVIDUAL') {
      await joinIndividual(eventId, req.user.id);
      return ok(res, { added: 1 }, 'Joined event successfully.');
    }

    return fail(res, 400, "mode must be 'INDIVIDUAL' or 'GROUP'.");
  } catch (error) {
    return next(error);
  }
};

/** DELETE /events/:id/leave */
export const leaveEvent = async (req, res, next) => {
  try {
    await leaveEventService(req.params.id, req.user.id);
    return ok(res, null, 'Left event successfully.');
  } catch (error) {
    return next(error);
  }
};

/** GET /events/:id/leaderboard?scope=individual|group */
export const getEventLeaderboard = async (req, res, next) => {
  try {
    const event = await getEventById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');

    const scope = req.query.scope === 'group' ? 'group' : 'individual';
    const ranking =
      scope === 'group' ? await getGroupLeaderboard(event) : await getIndividualLeaderboard(event);

    return ok(res, { scope, ranking }, 'Event leaderboard retrieved successfully.');
  } catch (error) {
    return next(error);
  }
};

/** GET /events/:id/stats */
export const getEventStatsController = async (req, res, next) => {
  try {
    const event = await getEventById(req.params.id);
    if (!event) return fail(res, 404, 'Event not found.');
    const stats = await getEventStats(event);
    return ok(res, stats, 'Event stats retrieved successfully.');
  } catch (error) {
    return next(error);
  }
};
