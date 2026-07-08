import prisma from '../config/prisma.js';

/**
 * @module EventService
 * @description Event CRUD and join/leave. Step aggregation lives separately in
 * eventStats.service.js. Neither file imports the frozen points/health services.
 */

const EVENT_INCLUDE = { _count: { select: { participants: true } } };

const withParticipantCount = (event) =>
  event && { ...event, participantCount: event._count.participants, _count: undefined };

/**
 * @param {{title: string, description?: string, startDate: string, endDate: string, createdById: string}} data
 */
export const createEvent = async (data) => {
  const event = await prisma.event.create({
    data: {
      title: data.title,
      description: data.description ?? null,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
      createdById: data.createdById,
    },
    include: EVENT_INCLUDE,
  });
  return withParticipantCount(event);
};

export const listEvents = async () => {
  const events = await prisma.event.findMany({
    orderBy: { startDate: 'desc' },
    include: EVENT_INCLUDE,
  });
  return events.map(withParticipantCount);
};

export const getEventById = async (id) => {
  const event = await prisma.event.findUnique({ where: { id }, include: EVENT_INCLUDE });
  return withParticipantCount(event);
};

/**
 * Caller's group membership (used to authorize a GROUP join).
 * @param {string} groupId
 * @param {string} userId
 */
export const getGroupMembership = (groupId, userId) =>
  prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });

/**
 * Individual join — idempotent via the [eventId, userId] unique constraint.
 * @param {string} eventId
 * @param {string} userId
 */
export const joinIndividual = (eventId, userId) =>
  prisma.eventParticipant.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId, joinMode: 'INDIVIDUAL' },
    update: {}, // already joined -> no-op
  });

/**
 * Group join — a group admin enrolls every current group member as a GROUP
 * participant. Idempotent: members already in the event are skipped (their
 * existing row, individual or group, is kept).
 * @param {string} eventId
 * @param {string} groupId
 * @returns {Promise<{added: number}>}
 */
export const joinByGroup = async (eventId, groupId) => {
  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  if (!members.length) return { added: 0 };

  const result = await prisma.eventParticipant.createMany({
    data: members.map((m) => ({ eventId, userId: m.userId, groupId, joinMode: 'GROUP' })),
    skipDuplicates: true,
  });
  return { added: result.count };
};

export const leaveEvent = (eventId, userId) =>
  prisma.eventParticipant.deleteMany({ where: { eventId, userId } });

export const getParticipation = (eventId, userId) =>
  prisma.eventParticipant.findUnique({ where: { eventId_userId: { eventId, userId } } });

export default {
  createEvent,
  listEvents,
  getEventById,
  getGroupMembership,
  joinIndividual,
  joinByGroup,
  leaveEvent,
  getParticipation,
};
