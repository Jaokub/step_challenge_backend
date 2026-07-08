import { getGroupLeaderboard } from './leaderboard.service.js';
import { getSiblingGroups, getChildGroups } from './group.scope.js';

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
  const ranking = await getGroupLeaderboard(groupId, startDate, endDate);
  return {
    ranking,
    overallStats: sumOverallStats(ranking),
    top3: ranking.slice(0, 3),
    top5: ranking.slice(0, 5),
  };
};

/**
 * Sibling groups' overall stats ONLY — never their member ranking. Callers
 * must not forward per-member data even though getGroupLeaderboard computes
 * it internally; we discard it here before returning.
 *
 * @param {string} groupId
 * @param {string|null} parentGroupId
 * @param {string} [startDate]
 * @param {string} [endDate]
 */
export const getSiblingOverviews = async (groupId, parentGroupId, startDate, endDate) => {
  const siblings = await getSiblingGroups(groupId, parentGroupId);

  const overviews = await Promise.all(
    siblings.map(async (sibling) => {
      const ranking = await getGroupLeaderboard(sibling.id, startDate, endDate);
      return {
        groupId: sibling.id,
        groupName: sibling.name,
        overallStats: sumOverallStats(ranking),
        // Deliberately no `ranking` / `members` field here.
      };
    })
  );

  return overviews;
};

/**
 * Direct child groups' overall stats — used by a parent group to get a quick
 * summary of each department before drilling into its full overview.
 *
 * @param {string} groupId
 * @param {string} [startDate]
 * @param {string} [endDate]
 */
export const getChildOverviews = async (groupId, startDate, endDate) => {
  const children = await getChildGroups(groupId);

  return Promise.all(
    children.map(async (child) => {
      const ranking = await getGroupLeaderboard(child.id, startDate, endDate);
      return {
        groupId: child.id,
        groupName: child.name,
        overallStats: sumOverallStats(ranking),
      };
    })
  );
};

export default {
  getGroupOwnOverview,
  getSiblingOverviews,
  getChildOverviews,
};
