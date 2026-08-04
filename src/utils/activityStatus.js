/**
 * @module utils/activityStatus
 * @description Activity.status has always been an assign-once column —
 * createActivity() hardcodes 'UPCOMING' and nothing ever transitions it as
 * real time passes (this backend runs on Vercel with no cron/background
 * worker). Left alone, an activity whose date has already come and gone
 * stays stuck showing as "UPCOMING" forever, which is what made the
 * mobile app's Upcoming/Ongoing/Past pills look broken — a real activity
 * with a past date kept showing up under Upcoming.
 *
 * Every reader that cares about "is this activity upcoming/ongoing/
 * completed" must derive it from startDate/endDate instead of trusting the
 * stored value — except CANCELLED, which stays a real, manual, terminal
 * state (nothing about the clock should ever resurrect a cancelled
 * activity). This is the single source of truth for that derivation, so
 * the activity list/detail endpoints, the admin stats KPI, and the
 * check-in / enrollment eligibility gates can't disagree with each other.
 */

export const ACTIVITY_STATUSES = ['UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'];

/**
 * @param {{status: string, startDate: Date|string, endDate: Date|string}} activity
 * @param {Date} [now]
 * @returns {'UPCOMING'|'ONGOING'|'COMPLETED'|'CANCELLED'}
 */
export function computeEffectiveStatus(activity, now = new Date()) {
  if (activity.status === 'CANCELLED') return 'CANCELLED';

  const start = new Date(activity.startDate);
  const end = new Date(activity.endDate);

  if (now < start) return 'UPCOMING';
  if (now > end) return 'COMPLETED';
  return 'ONGOING';
}

/**
 * Prisma `where` for "hasn't finished yet" — the union of UPCOMING and
 * ONGOING, derived from dates like everything else here.
 *
 * Exists because that union is NOT expressible by calling
 * `activityStatusWhere` twice: UPCOMING is `startDate > now` and ONGOING is
 * `startDate <= now AND endDate >= now`, and merging them into one object
 * would produce contradictory `startDate` clauses. Since `endDate >= startDate`
 * always holds, the union collapses to a single `endDate >= now`.
 *
 * The personal dashboard's "what's coming up" card is the caller. It used to
 * filter on `status IN ('UPCOMING','ONGOING') AND startDate >= now`, which
 * silently excluded every ongoing activity — anything ongoing has by
 * definition already started, so the second clause killed the first clause's
 * ONGOING half. Fixed 2026-08-03 (TEST_FINDINGS F3).
 *
 * @param {Date} [now]
 */
export function upcomingOrOngoingWhere(now = new Date()) {
  return { status: { not: 'CANCELLED' }, endDate: { gte: now } };
}

/**
 * Builds the Prisma `where` fragment for a requested status filter using
 * date comparisons instead of the raw column (CANCELLED is still the real
 * column value — it's the one status that IS just stored data). Mirrors
 * `computeEffectiveStatus` so "what filtering to a status returns" and
 * "what status an activity reports as" never disagree.
 *
 * An absent or unrecognised status falls back to the same hide-cancelled
 * default as before (see activity.controller.test.js's 2026-07-20
 * regression note) — this behavior is unchanged by this fix.
 *
 * @param {string|undefined} status - raw query param, any case
 * @param {Date} [now]
 */
export function activityStatusWhere(status, now = new Date()) {
  const upper = typeof status === 'string' ? status.toUpperCase() : undefined;

  switch (upper) {
    case 'CANCELLED':
      return { status: 'CANCELLED' };
    case 'UPCOMING':
      return { status: { not: 'CANCELLED' }, startDate: { gt: now } };
    case 'ONGOING':
      return { status: { not: 'CANCELLED' }, startDate: { lte: now }, endDate: { gte: now } };
    case 'COMPLETED':
      return { status: { not: 'CANCELLED' }, endDate: { lt: now } };
    default:
      return { status: { not: 'CANCELLED' } };
  }
}
