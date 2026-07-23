import prisma from '../config/prisma.js';
import { getGroupLeaderboard } from './leaderboard.service.js';
import { getSiblingGroups, getChildGroups } from './group.scope.js';
import { thaiDayTag, thaiWeekStartTag, thaiMonthStartTag, addDays } from '../utils/thaiTime.js';

/**
 * @module GroupOverviewService
 * @description Hierarchy-aware group stats, composed on top of the existing
 * (frozen) leaderboard.service — never reimplements point/step aggregation.
 */

/**
 * Sum a group's ranking rows into a single overall-stats object.
 * @param {Array<{steps?: number, calories?: number, distance?: number, points?: number, totalPoints: number}>} ranking
 */
const sumOverallStats = (ranking) => {
  return ranking.reduce(
    (acc, row) => ({
      totalSteps: acc.totalSteps + (row.steps ?? 0),
      totalCalories: acc.totalCalories + (row.calories ?? 0),
      totalDistanceKm: acc.totalDistanceKm + (row.distance ?? 0),
      totalPoints: acc.totalPoints + (row.points ?? row.totalPoints ?? 0),
      memberCount: acc.memberCount + 1,
    }),
    { totalSteps: 0, totalCalories: 0, totalDistanceKm: 0, totalPoints: 0, memberCount: 0 }
  );
};

/**
 * Own overall stats + full ranking (rank 1..N) + top3/top5, for a group the
 * viewer is allowed to see everything of (self or ancestor).
 *
 * @param {string} groupId
 * @param {string} [startDate]
 * @param {string} [endDate]
 */
export const getGroupOwnOverview = async (groupId, startDate, endDate) => {
  const [ranking, ownPeriodStats] = await Promise.all([
    getGroupLeaderboard(groupId, startDate, endDate),
    getGroupPeriodStats(groupId),
  ]);
  return {
    ranking,
    overallStats: sumOverallStats(ranking),
    // The frame-13/15 mint stat card (today/week/month steps) — same 3-window
    // aggregation already used for the parent/sibling/child relation cards,
    // just for the group's own id. `overallStats` above (all-time
    // points/steps/members) stays as-is for the separate frame-10 group-tab
    // overview screen (GroupOverviewSection) — this is additive, not a replacement.
    periodStats: { today: ownPeriodStats.today, week: ownPeriodStats.week, month: ownPeriodStats.month },
    top3: ranking.slice(0, 3),
    top5: ranking.slice(0, 5),
  };
};

/**
 * Sibling groups' stats + a Top-3 MEMBERS preview — never the full ranking.
 * Phase 5.2 (D1): loosened from "stats only" to also expose a bounded
 * rank/name/steps preview; the full member list stays own-group +
 * ancestor-drill-in only (`getGroupOwnOverview`) — callers must not forward
 * anything beyond `top3` even though `getGroupLeaderboard` computes the
 * full ranking internally; we slice it here before returning.
 *
 * `overallStats` is now the D2 3-window shape ({today,week,month,
 * memberCount}, via the bundled `getGroupsPeriodSteps` — no N+1 even with
 * many siblings) instead of a single all-time total.
 *
 * @param {string} groupId
 * @param {string|null} parentGroupId
 * @param {'today'|'week'|'month'} [period]
 */
export const getSiblingOverviews = async (groupId, parentGroupId, period = 'month') => {
  const siblings = await getSiblingGroups(groupId, parentGroupId);
  if (siblings.length === 0) return [];

  const periodStats = await getGroupsPeriodSteps(siblings.map((s) => s.id));
  return Promise.all(siblings.map((sibling) => buildGroupPreview(sibling, periodStats, period)));
};

/**
 * A single group's stats + Top-3 MEMBERS preview, in the same shape
 * `getSiblingOverviews` returns per sibling — shared by the bundled
 * hierarchy-overview endpoint for the "parent"/sibling/child cards and
 * reusable wherever a one-off relation preview is needed.
 * @param {{id: string, name: string}} group
 * @param {Map<string, object>} periodStats - from getGroupsPeriodSteps, must already include `group.id`.
 * @param {'today'|'week'|'month'} [period] - which window ranks the Top-3
 *   preview; the `overallStats` {today,week,month} columns are unaffected
 *   and always show all three regardless of this.
 */
const buildGroupPreview = async (group, periodStats, period = 'month') => {
  const stats = periodStats.get(group.id);
  // Real per-member steps (for the chosen window) for the Top-3 preview, so
  // the member rows can be re-ranked by day/week/month instead of always
  // showing all-time points. getGroupLeaderboard only populates row.steps
  // when a date window is passed, so re-sort by steps ourselves.
  const window = periodWindows()[period] ?? periodWindows().month;
  const ranking = await getGroupLeaderboard(group.id, window.gte, window.lt);
  const top3 = [...ranking]
    .sort((a, b) => (b.steps ?? 0) - (a.steps ?? 0))
    .slice(0, 3)
    .map((row, i) => ({ rank: i + 1, name: row.fullName, steps: row.steps ?? 0 }));
  return {
    groupId: group.id,
    groupName: group.name,
    overallStats: { today: stats.today, week: stats.week, month: stats.month, memberCount: stats.memberCount },
    top3,
  };
};

/**
 * Direct child groups ranked by this-month step total, plus an aggregate
 * {today,week,month} combined across ALL children — backs both frame 20's
 * full ranked list and the child relation card's Top-3 slice (BUILD_PLAN.md
 * Phase 5.2). Replaces the old `getChildOverviews` (was unrouted, and its
 * `overallStats.totalSteps` was silently always 0 — `getGroupLeaderboard`
 * only populates `.steps` when a date range is passed, which nothing did).
 * Ranks by "this month" as the most representative single "current
 * standings" figure — real HealthRecord data via `getGroupsPeriodSteps`,
 * not the points-ledger-based leaderboard.
 *
 * @param {string} groupId
 */
export const getChildRanking = async (groupId) => {
  const children = await getChildGroups(groupId);
  if (children.length === 0) {
    return { stats: { today: EMPTY_PERIOD(), week: EMPTY_PERIOD(), month: EMPTY_PERIOD() }, ranking: [] };
  }

  const periodStats = await getGroupsPeriodSteps(children.map((c) => c.id));

  const ranking = children
    .map((c) => ({ groupId: c.id, groupName: c.name, steps: periodStats.get(c.id).month.steps }))
    .sort((a, b) => b.steps - a.steps)
    .map((row, i) => ({ rank: i + 1, ...row }));

  const stats = { today: EMPTY_PERIOD(), week: EMPTY_PERIOD(), month: EMPTY_PERIOD() };
  for (const child of children) {
    const s = periodStats.get(child.id);
    for (const period of ['today', 'week', 'month']) {
      stats[period].steps += s[period].steps;
      stats[period].calories += s[period].calories;
      stats[period].distanceKm += s[period].distanceKm;
    }
  }

  return { stats, ranking };
};

// ─── 3-window step aggregation (BUILD_PLAN.md Phase 5.2) ────────────────────

/**
 * The three time windows the frame-13/15 relation cards display, as
 * HealthRecord.recordDate bounds (recordDate is a @db.Date UTC-midnight tag,
 * so these use the thaiTime "tag" helpers). All three are "so far": from the
 * period start up to and including today.
 * @param {Date} [now]
 */
const periodWindows = (now = new Date()) => {
  const dayStart = thaiDayTag(now);
  const tomorrow = addDays(dayStart, 1); // exclusive upper bound = end of today
  return {
    today: { gte: dayStart, lt: tomorrow },
    week: { gte: thaiWeekStartTag(now), lt: tomorrow },
    month: { gte: thaiMonthStartTag(now), lt: tomorrow },
  };
};

const EMPTY_PERIOD = () => ({ steps: 0, calories: 0, distanceKm: 0 });

/**
 * Per-group today/this-week/this-month step (and calorie/distance) totals for
 * a set of groups, in a FIXED number of queries regardless of how many groups
 * or members are involved: 1 membership query + 3 window `groupBy`s = 4 total.
 * This is the bundled path the group-detail screen needs (own group + parent +
 * every sibling + every child) without an N+1 explosion — do NOT loop
 * getGroupLeaderboard per group per window.
 *
 * @param {string[]} groupIds
 * @returns {Promise<Map<string, { today: object, week: object, month: object, memberCount: number }>>}
 */
export const getGroupsPeriodSteps = async (groupIds) => {
  const uniqueGroupIds = [...new Set(groupIds)];
  const result = new Map(
    uniqueGroupIds.map((id) => [id, { today: EMPTY_PERIOD(), week: EMPTY_PERIOD(), month: EMPTY_PERIOD(), memberCount: 0 }])
  );
  if (uniqueGroupIds.length === 0) return result;

  // 1) memberships for every group at once
  const memberships = await prisma.groupMember.findMany({
    where: { groupId: { in: uniqueGroupIds } },
    select: { groupId: true, userId: true },
  });
  memberships.forEach((m) => {
    result.get(m.groupId).memberCount += 1;
  });

  const userIds = [...new Set(memberships.map((m) => m.userId))];
  if (userIds.length === 0) return result;

  // 2) three window aggregations, one groupBy each (Promise.all = 3 queries)
  const w = periodWindows();
  const groupByWindow = (window) =>
    prisma.healthRecord.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, recordDate: window },
      _sum: { steps: true, calories: true, distanceKm: true },
    });
  const [todayRows, weekRows, monthRows] = await Promise.all([
    groupByWindow(w.today),
    groupByWindow(w.week),
    groupByWindow(w.month),
  ]);
  const toMap = (rows) => new Map(rows.map((r) => [r.userId, r._sum]));
  const maps = { today: toMap(todayRows), week: toMap(weekRows), month: toMap(monthRows) };

  // 3) fold per-user sums up into each group they belong to
  for (const { groupId, userId } of memberships) {
    const acc = result.get(groupId);
    for (const period of ['today', 'week', 'month']) {
      const s = maps[period].get(userId);
      if (!s) continue;
      acc[period].steps += s.steps ?? 0;
      acc[period].calories += s.calories ?? 0;
      acc[period].distanceKm += s.distanceKm ?? 0;
    }
  }
  return result;
};

/**
 * Single-group convenience wrapper over getGroupsPeriodSteps.
 * @param {string} groupId
 * @returns {Promise<{ today: object, week: object, month: object, memberCount: number }>}
 */
export const getGroupPeriodStats = async (groupId) => {
  const map = await getGroupsPeriodSteps([groupId]);
  return map.get(groupId);
};

/**
 * Bundled `{ parent, siblings, children }` for the frame-13/15 relation
 * cards in ONE authorized call (BUILD_PLAN.md Phase 5.2, "recommended
 * shape"). Caller must be a member of `groupId` itself (or Faculty Admin) —
 * checked by the route's `requireGroupMember()` middleware, same as
 * `getGroupById`. This is also how a member reads their PARENT group's
 * stats+top3 without a new 'descendant' relation in group.scope.js: access
 * is gated on membership of the group whose page this is, and the parent's
 * data is fetched server-side regardless of the caller's membership in the
 * parent itself ("prefer the bundle" per the BUILD_PLAN note).
 *
 * `children` used to be one aggregate card ranking the child GROUPS against
 * each other (via `getChildRanking`) — that read as "wrong" in practice
 * (the rank list showed group names, capped at 3, with no way to see a
 * child group's own members). It's now one preview PER child group, same
 * shape as `siblings` — each with its own overallStats + Top-3 MEMBERS,
 * unbounded in count (the mobile side caps how many render, not this call).
 * `getChildRanking`/`GET /groups/:id/children` (group-vs-group ranking)
 * stays as a separate, still-routed, now-unused-by-this-endpoint function —
 * nothing here calls it anymore.
 *
 * Fetches parent + siblings' + children's period stats in a single combined
 * `getGroupsPeriodSteps` call (not three separate ones) to keep this a
 * fixed number of queries regardless of sibling/child count.
 *
 * @param {string} groupId
 * @param {{parentPeriod?: 'today'|'week'|'month', siblingsPeriod?: 'today'|'week'|'month', childrenPeriod?: 'today'|'week'|'month'}} [periods]
 *   Each relation card can be re-ranked independently (mobile shows one
 *   day/week/month pill per section).
 * @returns {Promise<{parent: object|null, siblings: object[], children: object[]} | null>}
 */
export const getHierarchyOverview = async (groupId, periods = {}) => {
  const { parentPeriod = 'month', siblingsPeriod = 'month', childrenPeriod = 'month' } = periods;

  const group = await prisma.appGroup.findUnique({
    where: { id: groupId },
    select: { id: true, parentGroupId: true },
  });
  if (!group) return null;

  const parentGroup = group.parentGroupId
    ? await prisma.appGroup.findUnique({ where: { id: group.parentGroupId }, select: { id: true, name: true } })
    : null;
  const siblings = await getSiblingGroups(groupId, group.parentGroupId);
  const children = await getChildGroups(groupId);

  const relevantIds = [
    ...(parentGroup ? [parentGroup.id] : []),
    ...siblings.map((s) => s.id),
    ...children.map((c) => c.id),
  ];
  const periodStats = relevantIds.length ? await getGroupsPeriodSteps(relevantIds) : new Map();

  const [parent, siblingPreviews, childPreviews] = await Promise.all([
    parentGroup ? buildGroupPreview(parentGroup, periodStats, parentPeriod) : Promise.resolve(null),
    Promise.all(siblings.map((s) => buildGroupPreview(s, periodStats, siblingsPeriod))),
    Promise.all(children.map((c) => buildGroupPreview(c, periodStats, childrenPeriod))),
  ]);

  return {
    parent,
    siblings: siblingPreviews,
    children: childPreviews,
  };
};

export default {
  getGroupOwnOverview,
  getSiblingOverviews,
  getChildRanking,
  getHierarchyOverview,
  getGroupsPeriodSteps,
  getGroupPeriodStats,
};
