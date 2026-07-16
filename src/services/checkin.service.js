/**
 * @module CheckInService
 * @description Shared check-in + points-award logic. Both the QR check-in
 * path and the admin manual check-in path go through `createCheckIn` so
 * `pointsLedger` (source of truth for points — see pointsLedger.service.js)
 * is only ever written from one place, never reimplemented per-caller.
 *
 * ADR-001 / BUILD_PLAN.md Phase 7 — award timing now depends on activity
 * type: attendance-only (`activity.expectedSteps == null`) still pays out
 * immediately here, unchanged. Step-gated activities snapshot a step
 * baseline instead and defer payout to `activityAward.service.js`, which
 * fires once the post-check-in step delta reaches `expectedSteps`.
 */
import prisma from '../config/prisma.js';
import { applyPoints } from './pointsLedger.service.js';
import { thaiDayTag } from '../utils/thaiTime.js';
import { dailyMaxSteps, evaluateActivityAward } from './activityAward.service.js';

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
    // expectedSteps included (PR 2): the client needs it to tell "step-gated,
    // goal not yet met" (pointsAwarded 0, show "walk to earn" copy) apart
    // from "attendance-only activity worth 0 points" (pointsAwarded 0, plain
    // success) — see ADR-001 Phase 7 consequences.
    select: {
      id: true,
      title: true,
      location: true,
      startDate: true,
      endDate: true,
      points: true,
      status: true,
      expectedSteps: true,
    },
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
 * @returns {Promise<{checkIn: import('@prisma/client').CheckIn, pointsAwarded: number}>}
 *   `pointsAwarded` reflects what actually hit the ledger for this call:
 *   `activity.points` for an attendance-only check-in (paid now), and for a
 *   step-gated check-in either 0 (goal not yet met — the normal case) or
 *   `activity.points` in the rare case the post-check-in evaluation already
 *   cleared the goal. Never reports points that weren't awarded.
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
  const isStepGated = activity.expectedSteps != null;

  let created;
  try {
    created = await prisma.$transaction(
      async (tx) => {
        if (activity.maxParticipants) {
          const count = await tx.checkIn.count({ where: { activityId: activity.id } });
          if (count >= activity.maxParticipants) {
            throw new CheckInError('FULL', 'Activity is full. No more check-ins allowed.');
          }
        }

        // Step-gated: snapshot today's known cumulative steps as the
        // baseline (D4). Attendance-only: no baseline needed, award now.
        const stepsAtCheckIn = isStepGated ? await dailyMaxSteps(tx, userId, thaiDayTag()) : null;

        const row = await tx.checkIn.create({
          data: {
            userId,
            activityId: activity.id,
            latitude,
            longitude,
            method,
            stepsAtCheckIn,
            pointsAwardedAt: isStepGated ? null : new Date(),
          },
          include: CHECKIN_INCLUDE,
        });

        if (!isStepGated) {
          await applyPoints(tx, {
            userId,
            amount: activity.points || 0,
            reason: 'ACTIVITY_CHECKIN',
            effectiveDate: thaiDayTag(),
            refId: activity.id,
          });
        }

        return row;
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

  // Attendance-only paid inside the transaction above.
  let pointsAwarded = isStepGated ? 0 : activity.points || 0;

  // Step-gated: the check-in itself is already committed at this point.
  // Evaluate outside the transaction, best-effort — normally a no-op (the
  // baseline was just snapshotted from the same steps, so the delta starts
  // at ~0), but keeps a single award code path and covers a concurrent
  // sync landing between snapshot and here. Never let an evaluation
  // failure turn a successful check-in into an error response; the next
  // health sync's evaluateActivityAwardsForDate hook will catch it up.
  if (isStepGated) {
    try {
      const { awarded } = await evaluateActivityAward(userId, activity.id);
      if (awarded) pointsAwarded = activity.points || 0;
    } catch (awardError) {
      console.error('createCheckIn: post-check-in evaluateActivityAward failed', awardError);
    }
  }

  return { checkIn: created, pointsAwarded };
};

export default { createCheckIn, CheckInError };
