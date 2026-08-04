import prisma from '../config/prisma.js';
import { getSubtreeGroups } from './group.scope.js';
import { getPeriodPointsByUser } from './pointsLedger.service.js';

/**
 * Attach period-scoped stats to a list of users.
 *
 * Points come from the PointsLedger (the same source of truth that feeds
 * User.totalPoints), so the leaderboard can never disagree with the points a
 * user sees on their profile. Health metrics (steps/calories/distance) are
 * aggregated separately for display. Two queries total, regardless of the
 * number of users.
 *
 * @param {Array<Object>} usersList - Users with .id (mutated in place with .steps/.calories/.distance/.points)
 * @param {string} startDate
 * @param {string} endDate
 */
const applyPeriodPoints = async (usersList, startDate, endDate) => {
  const userIds = usersList.map((u) => u.id);

  const [healthRecords, pointsByUser] = await Promise.all([
    prisma.healthRecord.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, recordDate: { gte: new Date(startDate), lt: new Date(endDate) } },
      _sum: { steps: true, calories: true, distanceKm: true },
    }),
    getPeriodPointsByUser(userIds, startDate, endDate),
  ]);

  const metricsMap = new Map();
  healthRecords.forEach((hr) => {
    metricsMap.set(hr.userId, {
      steps: hr._sum.steps || 0,
      calories: hr._sum.calories || 0,
      distanceKm: hr._sum.distanceKm || 0,
    });
  });

  usersList.forEach((u) => {
    const metrics = metricsMap.get(u.id) || { steps: 0, calories: 0, distanceKm: 0 };
    u.steps = metrics.steps;
    u.calories = metrics.calories;
    u.distance = metrics.distanceKm;
    u.points = pointsByUser.get(u.id) || 0;
  });
};

/**
 * Attach all-time health totals (no date window) to a list of users. Used by
 * the "all-time" leaderboard branches, which rank by cumulative steps. One
 * query regardless of the number of users. Points are left as the denormalized
 * `totalPoints` cache the caller already selected — ranking is by steps.
 *
 * @param {Array<Object>} usersList - Users with .id (mutated in place with .steps/.calories/.distance)
 */
const applyAllTimeSteps = async (usersList) => {
  const userIds = usersList.map((u) => u.id);
  if (userIds.length === 0) return;

  const healthRecords = await prisma.healthRecord.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
    _sum: { steps: true, calories: true, distanceKm: true },
  });

  const metricsMap = new Map();
  healthRecords.forEach((hr) => {
    metricsMap.set(hr.userId, {
      steps: hr._sum.steps || 0,
      calories: hr._sum.calories || 0,
      distanceKm: hr._sum.distanceKm || 0,
    });
  });

  usersList.forEach((u) => {
    const metrics = metricsMap.get(u.id) || { steps: 0, calories: 0, distanceKm: 0 };
    u.steps = metrics.steps;
    u.calories = metrics.calories;
    u.distance = metrics.distanceKm;
  });
};

/**
 * @module LeaderboardService
 * @description Domain service for generating leaderboards
 */

/**
 * ⛔ `getGlobalLeaderboard` was removed on 2026-08-03 along with its route
 * (TEST_FINDINGS F2). Every leaderboard in this service is now SCOPED — to a
 * friend graph or to a group — which is the point: ranking is a property of a
 * relationship, not of the whole faculty. See the note in
 * `routes/leaderboard.routes.js` before adding an unscoped one back.
 */

/**
 * Generates a leaderboard among a user and their friends
 * @param {string} userId 
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<Array>}
 */
export const getFriendsLeaderboard = async (userId, startDate, endDate) => {
  // Get accepted friends
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { userId, status: 'ACCEPTED' },
        { friendId: userId, status: 'ACCEPTED' }
      ]
    },
    include: {
      user: { select: { id: true, fullName: true, avatarUrl: true, totalPoints: true, department: true } },
      friend: { select: { id: true, fullName: true, avatarUrl: true, totalPoints: true, department: true } }
    }
  });

  // Extract friend user objects and include the current user
  const userMap = new Map();
  
  // Need to get current user details
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, fullName: true, avatarUrl: true, totalPoints: true, department: true }
  });
  
  if (currentUser) userMap.set(currentUser.id, currentUser);

  friendships.forEach(f => {
    if (f.userId !== userId) userMap.set(f.userId, f.user);
    if (f.friendId !== userId) userMap.set(f.friendId, f.friend);
  });

  const friendsList = Array.from(userMap.values());

  if (startDate && endDate) {
    await applyPeriodPoints(friendsList, startDate, endDate);
  } else {
    await applyAllTimeSteps(friendsList);
  }

  // Rank by step count descending
  friendsList.sort((a, b) => (b.steps || 0) - (a.steps || 0));

  return friendsList.map((user, index) => ({
    ...user,
    rank: index + 1
  }));
};

/**
 * Generates a leaderboard for a specific group, covering its WHOLE SUBTREE
 * (ADR-003). A parent group whose people have all joined its child groups used
 * to return an empty ranking; it now ranks everyone beneath it.
 *
 * Each row carries `groups[]` — the descendants of `groupId` that the person
 * belongs to. The viewed group itself is never listed, so a leaf group yields
 * `groups: []` on every row and the client can hide the column without needing
 * to know whether this group has children.
 *
 * Everyone appears once however many sub-groups they are in.
 *
 * @param {string} groupId
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<Array>}
 */
export const getGroupLeaderboard = async (groupId, startDate, endDate) => {
  const descendants = (await getSubtreeGroups([groupId])).get(groupId) ?? [];
  const nameByGroupId = new Map(descendants.map((g) => [g.id, g.name]));

  const groupMembers = await prisma.groupMember.findMany({
    where: { groupId: { in: [groupId, ...descendants.map((g) => g.id)] } },
    include: {
      user: {
        select: { id: true, fullName: true, avatarUrl: true, totalPoints: true, department: true }
      }
    }
  });

  // Fold the membership rows into one entry per person, collecting the
  // sub-groups they belong to as we go.
  const byUserId = new Map();
  for (const member of groupMembers) {
    if (!member.user) continue;
    if (!byUserId.has(member.user.id)) {
      byUserId.set(member.user.id, { ...member.user, groups: [] });
    }
    if (member.groupId && member.groupId !== groupId) {
      byUserId
        .get(member.user.id)
        .groups.push({ id: member.groupId, name: nameByGroupId.get(member.groupId) ?? '' });
    }
  }

  const membersList = [...byUserId.values()];
  // Plain string comparison rather than localeCompare, whose result depends on
  // the runtime's ICU data — order is cosmetic, determinism is not.
  for (const user of membersList) {
    user.groups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  if (startDate && endDate) {
    await applyPeriodPoints(membersList, startDate, endDate);
  } else {
    await applyAllTimeSteps(membersList);
  }

  // Rank by step count descending
  membersList.sort((a, b) => (b.steps || 0) - (a.steps || 0));

  return membersList.map((user, index) => ({
    ...user,
    rank: index + 1
  }));
};

export default {
  getFriendsLeaderboard,
  getGroupLeaderboard
};
