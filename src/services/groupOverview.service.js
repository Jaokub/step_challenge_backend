import prisma from '../config/prisma.js';
import { getGroupLeaderboard } from './leaderboard.service.js';
import { getSiblingGroups, getChildGroups } from './group.scope.js';
import {
  getGroupsPeriodSteps,
  getGroupPeriodStats,
  periodWindows,
} from './groupAggregation.service.js';

/**
 * @module GroupOverviewService
 * @description Hierarchy-aware group stats — the presentation layer over
 * `groupAggregation.service.js`, which does the actual subtree resolution and
 * step aggregation (ADR-003).
 *
 * Re-exported here so existing callers and tests keep importing
 * `getGroupsPeriodSteps` / `getGroupPeriodStats` from this module; the split
 * exists to keep both files near the 200-line convention.
 */

export { getGroupsPeriodSteps, getGroupPeriodStats };

const EMPTY_PERIOD = () => ({ steps: 0, calories: 0, distanceKm: 0 });

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
  return siblings.map((sibling) => buildGroupPreview(sibling, periodStats, period));
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
const buildGroupPreview = (group, periodStats, period = 'month') => {
  const stats = periodStats.get(group.id);
  // Top-3 comes straight from the engine's member rows — no query of its own.
  //
  // This used to call `getGroupLeaderboard(group.id, ...)` once per group,
  // which made a screen with N relation cards issue 2N extra queries. The
  // docstring on `getGroupsPeriodSteps` warned against exactly that ("do NOT
  // loop getGroupLeaderboard per group per window") while this function did
  // it. Deriving from the engine also guarantees the Top-3 and the stat
  // columns above it come from one data set, so they cannot disagree.
  const top3 = [...stats.members]
    .sort((a, b) => (b[period]?.steps ?? 0) - (a[period]?.steps ?? 0))
    .slice(0, 3)
    .map((row, i) => ({
      rank: i + 1,
      name: row.fullName,
      steps: row[period]?.steps ?? 0,
      groups: row.groups,
    }));
  return {
    groupId: group.id,
    groupName: group.name,
    overallStats: {
      today: stats.today,
      week: stats.week,
      month: stats.month,
      subtreeMemberCount: stats.subtreeMemberCount,
    },
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
    return {
      stats: { today: EMPTY_PERIOD(), week: EMPTY_PERIOD(), month: EMPTY_PERIOD() },
      ranking: [],
      // Nothing to be "left over" from when there are no child rows at all.
      directOnlyMembers: { today: EMPTY_PERIOD(), week: EMPTY_PERIOD(), month: EMPTY_PERIOD(), count: 0 },
    };
  }

  // The group itself rides along in the same batched call so its
  // directOnlyMembers figure costs no extra query.
  const periodStats = await getGroupsPeriodSteps([groupId, ...children.map((c) => c.id)]);

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

  // Members of this group who are in NONE of its children — the "left over"
  // row shown under the ranked child list. Kept out of `ranking` because it is
  // not a group: a `groupId: null` entry there would break tap-to-open, and a
  // rank number on something that competes with nobody reads oddly.
  const own = periodStats.get(groupId);
  return { stats, ranking, directOnlyMembers: own.directOnly };
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
