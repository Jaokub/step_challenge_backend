/**
 * Find — and optionally hard-delete — a test Activity or Event by title.
 *
 * Written 2026-07-19 to clear the "ทดสอบ วิ่งเช้าคณะวิศวะ" test record so a
 * real activity can be created from a clean slate.
 *
 * ── Why a script and not just the admin UI ────────────────────────────────
 * `DELETE /api/v1/activities/:id` is a **soft delete** — it only sets
 * `status: 'CANCELLED'` (see `activity.controller.js deleteActivity`). The row
 * survives and still shows under the "ยกเลิก" filter, which is not what
 * "remove the test data" means here. Only a direct DB delete actually removes
 * it. There is no delete endpoint for Events at all (ADR-002 cancelled it).
 *
 * ── Why it searches BOTH tables ───────────────────────────────────────────
 * In this project's vocabulary "event" and "activity" mean the same thing (see
 * CLAUDE.md → Terminology), but the database has two unrelated models. A
 * record described as "an event" is almost certainly an `Activity` row created
 * through the admin UI — the `Event` table has no UI that can write to it.
 * This script reports which table the match is actually in, so the answer is
 * observed rather than assumed. **If it finds a row in `events`, that
 * contradicts ADR-002's premise that the table is empty — stop and re-read the
 * ADR before deleting anything.**
 *
 * ── Referential integrity ─────────────────────────────────────────────────
 * `ActivityParticipant.activityId` is `onDelete: Cascade`, but `CheckIn` is
 * NOT — a plain relation. So deleting an activity that has check-ins fails on
 * a foreign-key violation unless the check-ins go first. This script deletes
 * in dependency order inside a transaction. It also clears the matching
 * `points_ledger` rows (`refId = activityId`), which have no FK at all and
 * would otherwise be silently orphaned — harmless while points are dormant,
 * but they'd corrupt any future re-enablement of the ledger.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   # 1. Dry run first — ALWAYS. Shows what matched and what would be deleted.
 *   node scripts/purge-test-record.mjs --title "ทดสอบ"
 *
 *   # 2. Only once the dry run shows exactly what you expect:
 *   node scripts/purge-test-record.mjs --title "ทดสอบ" --confirm
 *
 * Matching is case-insensitive "contains", so a partial title works. Run it
 * from `backend/` on a machine with network access to Neon.
 */

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const title = getArg('--title');
const confirmed = args.includes('--confirm');

if (!title) {
  console.error('Usage: node scripts/purge-test-record.mjs --title "<substring>" [--confirm]');
  console.error('Run WITHOUT --confirm first to see what would be deleted.');
  process.exit(1);
}

const prisma = new PrismaClient();

const main = async () => {
  const where = { title: { contains: title, mode: 'insensitive' } };

  const activities = await prisma.activity.findMany({
    where,
    include: { _count: { select: { checkIns: true, activityParticipants: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const events = await prisma.event.findMany({
    where,
    include: { _count: { select: { participants: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nSearching for titles containing: "${title}"\n`);

  if (!activities.length && !events.length) {
    console.log('No matching rows in `activities` or `events`. Nothing to do.');
    return;
  }

  if (events.length) {
    console.log('⚠️  MATCHES IN THE `events` TABLE — this contradicts ADR-002.');
    console.log('    ADR-002 concluded the Event table is empty by construction.');
    console.log('    Stop and re-read the ADR before deleting these.\n');
    for (const e of events) {
      console.log(`  [event]    ${e.id}  [${e.status}]  "${e.title}"`);
      console.log(`             ${e.startDate.toISOString()} → ${e.endDate.toISOString()}`);
      console.log(`             participants=${e._count.participants}`);
    }
    console.log('');
  }

  let ledgerTotal = 0;
  if (activities.length) {
    console.log('Matches in the `activities` table:\n');
    for (const a of activities) {
      const ledgerCount = await prisma.pointsLedgerEntry.count({ where: { refId: a.id } });
      ledgerTotal += ledgerCount;
      console.log(`  [activity] ${a.id}  [${a.status}]  "${a.title}"`);
      console.log(`             location="${a.location}"  created=${a.createdAt.toISOString()}`);
      console.log(`             ${a.startDate.toISOString()} → ${a.endDate.toISOString()}`);
      console.log(
        `             checkIns=${a._count.checkIns}  participants=${a._count.activityParticipants}  pointsLedgerRows=${ledgerCount}`
      );
    }
    console.log('');
  }

  if (!confirmed) {
    console.log('── DRY RUN — nothing was deleted. ──');
    console.log('If the list above is exactly what you want gone, re-run with --confirm:');
    console.log(`  node scripts/purge-test-record.mjs --title "${title}" --confirm`);
    return;
  }

  if (events.length) {
    console.log('❌ Refusing to delete while `events` rows matched.');
    console.log('   That result invalidates ADR-002\'s premise and needs a human decision.');
    console.log('   Re-run with a narrower --title that matches only activities, or');
    console.log('   reopen ADR-002 first.');
    process.exitCode = 1;
    return;
  }

  console.log('Deleting...\n');
  for (const a of activities) {
    await prisma.$transaction(async (tx) => {
      // Order matters: CheckIn has no cascade, so it must go before the
      // activity. ActivityParticipant cascades but is deleted explicitly for
      // symmetry and so the reported counts are honest.
      const ledger = await tx.pointsLedgerEntry.deleteMany({ where: { refId: a.id } });
      const checkIns = await tx.checkIn.deleteMany({ where: { activityId: a.id } });
      const participants = await tx.activityParticipant.deleteMany({ where: { activityId: a.id } });
      await tx.activity.delete({ where: { id: a.id } });

      console.log(
        `  ✅ "${a.title}" — removed activity + ${checkIns.count} check-in(s), ` +
          `${participants.count} participant(s), ${ledger.count} ledger row(s)`
      );
    });
  }

  console.log(`\nDone. ${activities.length} activity/activities removed (${ledgerTotal} ledger rows cleared).`);
};

main()
  .catch((err) => {
    console.error('\n❌ Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
