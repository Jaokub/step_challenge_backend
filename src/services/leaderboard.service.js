import prisma from '../config/prisma.js';
import { calculateHealthPoints } from './points.service.js';

/**
 * @module LeaderboardService
 * @description Domain service for generating leaderboards
 */

/**
 * Generates a global leaderboard based on total points
 * @param {number} limit 
 * @returns {Promise<Array>}
 */
export const getGlobalLeaderboard = async (limit = 10) => {
  const users = await prisma.user.findMany({
    orderBy: { totalPoints: 'desc' },
    take: limit,
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
      totalPoints: true,
      department: true
    }
  });

  return users.map((user, index) => ({
    ...user,
    rank: index + 1
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
    const userIds = friendsList.map(u => u.id);
    const healthRecords = await prisma.healthRecord.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        recordDate: {
          gte: new Date(startDate),
          lt: new Date(endDate)
        }
      },
      _sum: {
        steps: true,
        calories: true,
        distanceKm: true
      }
    });

    const metricsMap = new Map();
    healthRecords.forEach(hr => {
      metricsMap.set(hr.userId, {
        steps: hr._sum.steps || 0,
        calories: hr._sum.calories || 0,
        distanceKm: hr._sum.distanceKm || 0
      });
    });

    friendsList.forEach(u => {
      const metrics = metricsMap.get(u.id) || { steps: 0, calories: 0, distanceKm: 0 };
      u.steps = metrics.steps;
      u.calories = metrics.calories;
      u.distance = metrics.distanceKm;
      u.points = calculateHealthPoints(metrics, 0);
    });
  } else {
    friendsList.forEach(u => {
      u.points = u.totalPoints;
    });
  }
  
  // Sort by points descending
  friendsList.sort((a, b) => b.points - a.points);
  
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
    const userIds = membersList.map(u => u.id);
    const healthRecords = await prisma.healthRecord.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        recordDate: {
          gte: new Date(startDate),
          lt: new Date(endDate)
        }
      },
      _sum: {
        steps: true,
        calories: true,
        distanceKm: true
      }
    });

    const metricsMap = new Map();
    healthRecords.forEach(hr => {
      metricsMap.set(hr.userId, {
        steps: hr._sum.steps || 0,
        calories: hr._sum.calories || 0,
        distanceKm: hr._sum.distanceKm || 0
      });
    });

    membersList.forEach(u => {
      const metrics = metricsMap.get(u.id) || { steps: 0, calories: 0, distanceKm: 0 };
      u.steps = metrics.steps;
      u.calories = metrics.calories;
      u.distance = metrics.distanceKm;
      u.points = calculateHealthPoints(metrics, 0);
    });
  } else {
    membersList.forEach(u => {
      u.points = u.totalPoints;
    });
  }
  
  // Sort by points descending
  membersList.sort((a, b) => b.points - a.points);
  
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
