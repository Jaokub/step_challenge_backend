/**
 * Backfill script: seed the PointsLedger from existing data.
 *
 * Strategy (per user):
 *   1. One HEALTH_SYNC entry per HealthRecord, using the base formula
 *      (no streak multiplier — historical streaks are not reconstructible).
 *   2. One ACTIVITY_CHECKIN entry per CheckIn (activity.points).
 *   3. One ADJUSTMENT entry so that SUM(ledger) === user.totalPoints exactly,
 *      preserving every user's current total to the point.
 *
 * Idempotent: users who already have ledger entries are skipped.
 *
 * Run AFTER `npx prisma migrate dev` (or `db push`) has created the table:
 *   node scripts/backfill_points_ledger.js
 */
import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import { calculateHealthPoints } from '../src/services/points.service.js';
import { thaiDayTag } from '../src/utils/thaiTime.js';

const backfillUser = async (user) => {
  const existing = await prisma.pointsLedgerEntry.count({ where: { userId: user.id } });
  if (existing > 0) {
    console.log(`- ${user.email}: already has ${existing} ledger entries, skipping`);
    return;
  }

  const [healthRecords, checkIns] = await Promise.all([
    prisma.healthRecord.findMany({
      where: { userId: user.id },
      select: { recordDate: true, source: true, steps: true, calories: true, distanceKm: true },
    }),
    prisma.checkIn.findMany({
      where: { userId: user.id },
      select: { activityId: true, checkedInAt: true, activity: { select: { points: true } } },
    }),
  ]);

  const entries = [];

  for (const hr of healthRecords) {
    const amount = calculateHealthPoints(
      { steps: hr.steps, calories: hr.calories, distanceKm: hr.distanceKm },
      0
    );
    if (amount > 0) {
      entries.push({
        userId: user.id,
        amount,
        reason: 'HEALTH_SYNC',
        effectiveDate: hr.recordDate,
        refId: hr.source,
      });
    }
  }

  for (const ci of checkIns) {
    const amount = ci.activity?.points || 0;
    if (amount > 0) {
      entries.push({
        userId: user.id,
        amount,
        reason: 'ACTIVITY_CHECKIN',
        effectiveDate: thaiDayTag(ci.checkedInAt),
        refId: ci.activityId,
      });
    }
  }

  const reconstructedTotal = entries.reduce((sum, e) => sum + e.amount, 0);
  const adjustment = user.totalPoints - reconstructedTotal;
  if (adjustment !== 0) {
    entries.push({
      userId: user.id,
      amount: adjustment,
      reason: 'ADJUSTMENT',
      effectiveDate: thaiDayTag(),
      refId: 'backfill-reconciliation',
    });
  }

  if (entries.length > 0) {
    await prisma.pointsLedgerEntry.createMany({ data: entries });
  }
  console.log(
    `- ${user.email}: ${entries.length} entries (reconstructed ${reconstructedTotal}, adjustment ${adjustment}, total ${user.totalPoints})`
  );
};

const main = async () => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, totalPoints: true },
  });
  console.log(`Backfilling points ledger for ${users.length} users...`);

  for (const user of users) {
    await backfillUser(user);
  }

  console.log('Done.');
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
