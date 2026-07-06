/**
 * @module PointsLedgerService
 * @description The ONLY place allowed to change a user's points.
 *
 * Every points mutation writes a PointsLedgerEntry AND updates the
 * User.totalPoints cache in the same transaction, so the two can never
 * drift apart. Period-scoped views (leaderboards, dashboards) sum the
 * ledger instead of re-deriving points with their own formulas.
 */
import prisma from '../config/prisma.js';

/**
 * Apply a points delta to a user inside an existing transaction.
 *
 * Negative deltas are clamped so totalPoints never drops below 0; the
 * ledger entry records the *applied* amount, keeping ledger sum equal to
 * totalPoints. Returns the applied amount (0 means nothing was written).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {Object} entry
 * @param {string} entry.userId
 * @param {number} entry.amount - Requested delta (integer, may be negative).
 * @param {'HEALTH_SYNC'|'ACTIVITY_CHECKIN'|'CHECKIN_CANCELLED'|'ADJUSTMENT'} entry.reason
 * @param {Date} entry.effectiveDate - Thai day tag (UTC midnight) the points belong to.
 * @param {string} [entry.refId] - Optional reference (activityId, HealthSource, ...).
 * @returns {Promise<number>} The applied (possibly clamped) amount.
 */
export const applyPoints = async (tx, { userId, amount, reason, effectiveDate, refId = null }) => {
  if (!Number.isInteger(amount)) {
    throw new Error(`applyPoints: amount must be an integer, got ${amount}`);
  }
  if (amount === 0) return 0;

  let applied = amount;

  if (amount < 0) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { totalPoints: true },
    });
    applied = -Math.min(Math.abs(amount), user?.totalPoints ?? 0);
    if (applied === 0) return 0;
  }

  await tx.pointsLedgerEntry.create({
    data: { userId, amount: applied, reason, effectiveDate, refId },
  });

  await tx.user.update({
    where: { id: userId },
    data: { totalPoints: { increment: applied } },
  });

  return applied;
};

/**
 * Sum ledger points per user for a date range, in a single query.
 * Replaces the old per-user recomputation (health formula × current streak),
 * which both disagreed with totalPoints and issued N queries per leaderboard.
 *
 * @param {string[]} userIds
 * @param {Date|string} startDate - Inclusive lower bound on effectiveDate.
 * @param {Date|string} endDate - Exclusive upper bound on effectiveDate.
 * @returns {Promise<Map<string, number>>} userId -> points earned in range.
 */
export const getPeriodPointsByUser = async (userIds, startDate, endDate) => {
  if (userIds.length === 0) return new Map();

  const grouped = await prisma.pointsLedgerEntry.groupBy({
    by: ['userId'],
    where: {
      userId: { in: userIds },
      effectiveDate: { gte: new Date(startDate), lt: new Date(endDate) },
    },
    _sum: { amount: true },
  });

  return new Map(grouped.map((g) => [g.userId, g._sum.amount || 0]));
};

export default { applyPoints, getPeriodPointsByUser };
