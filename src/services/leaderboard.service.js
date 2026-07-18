import prisma from '../config/prisma.js';
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
 * Generates a global leaderboard ranked by cumulative (all-time) step count.
 * Steps are aggregated from HealthRecord; the top `limit` step-earners are then
 * hydrated with their profile details. Users with no health records simply
 * don't appear (they have 0 steps).
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export const getGlobalLeaderboard = async (limit = 10) => {
  const stepAgg = await prisma.healthRecord.groupBy({
    by: ['userId'],
    _sum: { steps: true },
    orderBy: { _sum: { steps: 'desc' } },
    take: limit,
  });

  const userIds = stepAgg.map((s) => s.userId);
  if (userIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true, avatarUrl: true, department: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return stepAgg
    .filter((s) => userMap.has(s.userId))
    .map((s, index) => ({
      ...userMap.get(s.userId),
      steps: s._sum.steps || 0,
      rank: index + 1,
    }));
};

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
 * Generates a leaderboard for a specific group
 * @param {string} groupId 
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<Array>}
 */
export const getGroupLeaderboard = async (groupId, startDate, endDate) => {
  const groupMembers = await prisma.groupMember.findMany({
    where: { groupId },
    include: {
      user: {
        select: { id: true, fullName: true, avatarUrl: true, totalPoints: true, department: true }
      }
    }
  });

  const membersList = groupMembers.map(member => member.user);

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
  getGlobalLeaderboard,
  getFriendsLeaderboard,
  getGroupLeaderboard
};
