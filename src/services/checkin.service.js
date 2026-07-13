/**
 * @module CheckInService
 * @description Shared check-in + points-award logic. Both the QR check-in
 * path and the admin manual check-in path go through `createCheckIn` so
 * `pointsLedger` (source of truth for points — see pointsLedger.service.js)
 * is only ever written from one place, never reimplemented per-caller.
 */
import prisma from '../config/prisma.js';
import { applyPoints } from './pointsLedger.service.js';
import { thaiDayTag } from '../utils/thaiTime.js';

/**
 * Typed check-in failure so controllers can map to the right HTTP status
 * and craft caller-appropriate wording, instead of string-matching messages.
 * `code` is one of: 'INVALID_STATUS' | 'DUPLICATE' | 'FULL' | 'CONFLICT'.
 */
export class CheckInError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CheckInError';
    this.code = code;
  }
}

const CHECKIN_INCLUDE = {
  activity: {
    select: { id: true, title: true, location: true, startDate: true, endDate: true, points: true, status: true },
  },
  user: {
    select: { id: true, fullName: true, totalPoints: true },
  },
};

/**
 * Create a check-in and award the activity's points in one Serializable
 * transaction.
 *
 * @param {Object} params
 * @param {{id:string,status:string,points:number,maxParticipants:number|null}} params.activity
 * @param {string} params.userId - The user being checked in (not necessarily the caller).
 * @param {'QR'|'MANUAL'} params.method
 * @param {number|null} [params.latitude]
 * @param {number|null} [params.longitude]
 * @returns {Promise<import('@prisma/client').CheckIn>}
 */
export const createCheckIn = async ({ activity, userId, method, latitude = null, longitude = null }) => {
  if (!['UPCOMING', 'ONGOING'].includes(activity.status)) {
    throw new CheckInError('INVALID_STATUS', `Cannot check in. Activity is ${activity.status.toLowerCase()}.`);
  }

  const existingCheckIn = await prisma.checkIn.findUnique({
    where: { userId_activityId: { userId, activityId: activity.id } },
  });
  if (existingCheckIn) {
    throw new CheckInError('DUPLICATE', 'This user has already checked in to this activity.');
  }

  // Re-check capacity and create the check-in inside a Serializable
  // transaction so concurrent check-ins for the same activity can't both
  // slip past the capacity check.
  try {
    return await prisma.$transaction(
      async (tx) => {
        if (activity.maxParticipants) {
          const count = await tx.checkIn.count({ where: { activityId: activity.id } });
          if (count >= activity.maxParticipants) {
            throw new CheckInError('FULL', 'Activity is full. No more check-ins allowed.');
          }
        }

        const created = await tx.checkIn.create({
          data: { userId, activityId: activity.id, latitude, longitude, method },
          include: CHECKIN_INCLUDE,
        });

        await applyPoints(tx, {
          userId,
          amount: activity.points || 0,
          reason: 'ACTIVITY_CHECKIN',
          effectiveDate: thaiDayTag(),
          refId: activity.id,
        });

        return created;
      },
      { isolationLevel: 'Serializable' }
    );
  } catch (txError) {
    if (txError instanceof CheckInError) throw txError;
    // Postgres serialization failure: another concurrent check-in won the race.
    if (txError.code === 'P2034') {
      throw new CheckInError('CONFLICT', 'Please try again — a conflicting check-in was just processed.');
    }
    // Unique constraint violation (race condition on [userId, activityId]).
    if (txError.code === 'P2002') {
      throw new CheckInError('DUPLICATE', 'This user has already checked in to this activity.');
    }
    throw txError;
  }
};

export default { createCheckIn, CheckInError };
