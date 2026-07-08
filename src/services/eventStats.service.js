import prisma from '../config/prisma.js';
import { thaiDayTag } from '../utils/thaiTime.js';

/**
 * @module EventStatsService
 * @description Read-only aggregation of event step totals. Steps are summed on
 * demand from HealthRecord within the event's day window — an Event stores no
 * steps of its own. This service NEVER imports from or mutates the frozen
 * points/health/leaderboard services; it only reads HealthRecord.
 *
 * All three views (individual ranking, group-sum ranking, event-wide total) are
 * derived from a single `userId -> steps` map so they can never disagree.
 */

const USER_SELECT = { id: true, fullName: true, avatarUrl: true, department: true };

/**
 * Inclusive UTC-midnight day-tag window for an event. HealthRecord.recordDate is
 * a @db.Date (UTC-midnight tag), so we compare against the same tag convention.
 * @param {{startDate: Date, endDate: Date}} event
 */
const eventWindow = (event) => ({
  startTag: thaiDayTag(event.startDate),
  endTag: thaiDayTag(event.endDate),
});

/**
 * All participants of an event, with their user and (optional) group.
 * @param {string} eventId
 */
const getParticipants = (eventId) =>
  prisma.eventParticipant.findMany({
    where: { eventId },
    select: {
      userId: true,
      groupId: true,
      joinMode: true,
      user: { select: USER_SELECT },
      group: { select: { id: true, name: true } },
    },
  });

/**
 * Sum of steps per user over [startTag, endTag], for the given users only.
 * One groupBy query regardless of participant count.
 * @param {string[]} userIds
 * @param {Date} startTag
 * @param {Date} endTag
 * @returns {Promise<Map<string, number>>}
 */
const stepsByUser = async (userIds, startTag, endTag) => {
  if (!userIds.length) return new Map();
  const rows = await prisma.healthRecord.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, recordDate: { gte: startTag, lte: endTag } },
    _sum: { steps: true },
  });
  const map = new Map();
  rows.forEach((r) => map.set(r.userId, r._sum.steps || 0));
  return map;
};

/**
 * Load an event's participants and their step sums once. Every public view
 * below is derived from this shared scope so totals always reconcile.
 * @param {{id: string, startDate: Date, endDate: Date}} event
 */
const loadScope = async (event) => {
  const { startTag, endTag } = eventWindow(event);
  const participants = await getParticipants(event.id);
  const stepsMap = await stepsByUser(
    participants.map((p) => p.userId),
    startTag,
    endTag
  );
  return { participants, stepsMap };
};

/**
 * Individual leaderboard: every participant ranked by their own steps.
 * @param {Object} event
 */
export const getIndividualLeaderboard = async (event) => {
  const { participants, stepsMap } = await loadScope(event);

  const rows = participants.map((p) => ({
    ...p.user,
    steps: stepsMap.get(p.userId) || 0,
    joinMode: p.joinMode,
  }));
  rows.sort((a, b) => b.steps - a.steps);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
};

/**
 * Group-sum leaderboard: GROUP-mode participants aggregated by their group,
 * groups ranked against each other by total steps. INDIVIDUAL participants are
 * excluded here (they still count toward the event-wide total).
 * @param {Object} event
 */
export const getGroupLeaderboard = async (event) => {
  const { participants, stepsMap } = await loadScope(event);

  const groups = new Map();
  participants.forEach((p) => {
    if (!p.groupId || !p.group) return;
    const steps = stepsMap.get(p.userId) || 0;
    const entry = groups.get(p.groupId) || {
      groupId: p.groupId,
      groupName: p.group.name,
      totalSteps: 0,
      memberCount: 0,
    };
    entry.totalSteps += steps;
    entry.memberCount += 1;
    groups.set(p.groupId, entry);
  });

  const rows = Array.from(groups.values());
  rows.sort((a, b) => b.totalSteps - a.totalSteps);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
};

/**
 * Event-wide stats: total steps of EVERY participant (grouped or individual),
 * plus participant and distinct-group counts.
 * @param {Object} event
 */
export const getEventStats = async (event) => {
  const { participants, stepsMap } = await loadScope(event);

  let totalSteps = 0;
  const groupIds = new Set();
  participants.forEach((p) => {
    totalSteps += stepsMap.get(p.userId) || 0;
    if (p.groupId) groupIds.add(p.groupId);
  });

  return {
    totalSteps,
    participantCount: participants.length,
    groupCount: groupIds.size,
  };
};

export default { getIndividualLeaderboard, getGroupLeaderboard, getEventStats };
