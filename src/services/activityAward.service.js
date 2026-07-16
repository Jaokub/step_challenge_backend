/**
 * @module ActivityAwardService
 * @description Step-gated activity points (ADR-001-activity-step-gated-points.md,
 * BUILD_PLAN.md Phase 7). Unfrozen — this is the ONE place activity-bonus
 * award logic lives, so `healthSync.service.js` only needs a single hook
 * call rather than growing real logic of its own.
 *
 * Award rule recap:
 *   - Attendance-only activity (`expectedSteps == null`) pays out at
 *     check-in — handled directly in `checkin.service.js`, this module is
 *     never involved for that path.
 *   - Step-gated activity (`expectedSteps` set) pays out ONCE, when the
 *     user has a `CheckIn` AND their post-check-in step delta (D4
 *     "baseline delta") reaches `expectedSteps`. `evaluateActivityAward`
 *     is idempotent (safe to call repeatedly / concurrently) via a
 *     conditional `updateMany WHERE pointsAwardedAt IS NULL` race guard.
 *
 * Still writes through `pointsLedger.service.js` (`applyPoints`) — this
 * module never mutates points directly, only decides *whether* to.
 */
import prisma from '../config/prisma.js';
import { applyPoints } from './pointsLedger.service.js';
import { thaiDayTag } from '../utils/thaiTime.js';

/**
 * Cumulative steps for a user on a single Thai calendar day, taking the
 * MAX across sources (never sum GOOGLE_HEALTH + APPLE_HEALTH + MANUAL for
 * the same day — that double-counts, per ADR-001 D4).
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {string} userId
 * @param {Date} dayTag - UTC-midnight tag (thaiDayTag convention).
 * @returns {Promise<number>}
 */
export const dailyMaxSteps = async (client, userId, dayTag) => {
  const records = await client.healthRecord.findMany({
    where: { userId, recordDate: dayTag },
    select: { steps: true },
  });
  if (records.length === 0) return 0;
  return Math.max(...records.map((r) => r.steps || 0));
};

/**
 * Baseline-delta event steps for a step-gated CheckIn (ADR-001 D4):
 *
 *   eventSteps = (dailyMax(checkInDay) - stepsAtCheckIn)
 *              + Σ dailyMax(day) for each full day after the check-in day,
 *                up to min(activity.endDate, today)
 *
 * One query over the whole window (not N per-day queries), maxed per day
 * in memory.
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {{userId:string, checkedInAt:Date, stepsAtCheckIn:number|null}} checkIn
 * @param {{endDate:Date}} activity
 * @returns {Promise<number>}
 */
export const computeEventSteps = async (client, checkIn, activity) => {
  const checkInDayTag = thaiDayTag(checkIn.checkedInAt);
  const activityEndTag = thaiDayTag(activity.endDate);
  const todayTag = thaiDayTag();
  const lastTag = activityEndTag.getTime() < todayTag.getTime() ? activityEndTag : todayTag;

  if (lastTag.getTime() < checkInDayTag.getTime()) return 0;

  const records = await client.healthRecord.findMany({
    where: {
      userId: checkIn.userId,
      recordDate: { gte: checkInDayTag, lte: lastTag },
    },
    select: { recordDate: true, steps: true },
  });

  const maxByDay = new Map();
  for (const r of records) {
    const key = r.recordDate.getTime();
    maxByDay.set(key, Math.max(maxByDay.get(key) ?? 0, r.steps || 0));
  }

  const baseline = checkIn.stepsAtCheckIn ?? 0;
  const checkInDayMax = maxByDay.get(checkInDayTag.getTime()) ?? 0;
  let total = Math.max(checkInDayMax - baseline, 0);

  for (const [dayMs, maxSteps] of maxByDay) {
    if (dayMs > checkInDayTag.getTime()) total += maxSteps;
  }

  return total;
};

/**
 * Idempotent, safe to call repeatedly / concurrently. No-ops unless the
 * user has an unpaid, step-gated CheckIn whose baseline-delta has reached
 * the goal.
 *
 * @param {string} userId
 * @param {string} activityId
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} [txClient]
 *   Pass an existing transaction client to run inside a caller's
 *   transaction (e.g. healthSync's upsert tx); defaults to opening its own.
 * @returns {Promise<{awarded: boolean}>}
 */
export const evaluateActivityAward = async (userId, activityId, txClient = prisma) => {
  const run = async (client) => {
    const checkIn = await client.checkIn.findUnique({
      where: { userId_activityId: { userId, activityId } },
    });
    if (!checkIn || checkIn.pointsAwardedAt) return { awarded: false };

    const activity = await client.activity.findUnique({ where: { id: activityId } });
    if (!activity || activity.expectedSteps == null) return { awarded: false };

    const eventSteps = await computeEventSteps(client, checkIn, activity);
    if (eventSteps < activity.expectedSteps) return { awarded: false };

    // Concurrency guard: only the caller that flips pointsAwardedAt from
    // NULL wins the award. A concurrent evaluator (e.g. two syncs racing)
    // gets count 0 and no-ops instead of double-paying.
    const gate = await client.checkIn.updateMany({
      where: { id: checkIn.id, pointsAwardedAt: null },
      data: { pointsAwardedAt: new Date() },
    });
    if (gate.count === 0) return { awarded: false };

    await applyPoints(client, {
      userId,
      amount: activity.points || 0,
      reason: 'ACTIVITY_CHECKIN',
      effectiveDate: thaiDayTag(),
      refId: activityId,
    });

    return { awarded: true };
  };

  // If we were handed a real transaction client (not the root PrismaClient),
  // run directly in it — Prisma doesn't support nested transactions and the
  // caller (healthSync) already wants this atomic with its own write.
  const isRootClient = typeof txClient.$transaction === 'function';
  return isRootClient ? prisma.$transaction((tx) => run(tx)) : run(txClient);
};

/**
 * Re-evaluate every unpaid, step-gated activity the user has checked into
 * whose window contains `date`. This is the single hook called from
 * `healthSync.service.js` after a HealthRecord upsert for that date.
 *
 * @param {string} userId
 * @param {Date} date - Any instant on the day to evaluate (typically the
 *   same `normalizedDate` just upserted into HealthRecord).
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} [txClient]
 * @returns {Promise<string[]>} activityIds newly awarded by this call.
 */
export const evaluateActivityAwardsForDate = async (userId, date, txClient = prisma) => {
  const dayTag = thaiDayTag(date);

  const candidates = await txClient.checkIn.findMany({
    where: {
      userId,
      pointsAwardedAt: null,
      activity: { expectedSteps: { not: null } },
    },
    select: {
      activityId: true,
      activity: { select: { startDate: true, endDate: true } },
    },
  });

  const inWindow = candidates.filter(({ activity }) => {
    const startTag = thaiDayTag(activity.startDate);
    const endTag = thaiDayTag(activity.endDate);
    return dayTag.getTime() >= startTag.getTime() && dayTag.getTime() <= endTag.getTime();
  });

  const awardedActivityIds = [];
  for (const { activityId } of inWindow) {
    const result = await evaluateActivityAward(userId, activityId, txClient);
    if (result.awarded) awardedActivityIds.push(activityId);
  }
  return awardedActivityIds;
};

export default { dailyMaxSteps, computeEventSteps, evaluateActivityAward, evaluateActivityAwardsForDate };
