/**
 * @module StreakService
 * @description Domain service for calculating a user's consecutive activity streak.
 * Streak is based on check-in dates (not health records) and must end today or yesterday.
 */
import prisma from '../config/prisma.js';

/**
 * Calculate the current check-in streak for a user.
 * A streak is the number of consecutive days (ending today or yesterday)
 * that the user has at least one check-in.
 *
 * @param {string} userId - The user's ID.
 * @returns {Promise<number>} The current streak count (0 if no streak).
 */
export const calculateCheckInStreak = async (userId) => {
  const checkIns = await prisma.checkIn.findMany({
    where: { userId },
    orderBy: { checkedInAt: 'desc' },
    select: { checkedInAt: true },
  });

  if (checkIns.length === 0) return 0;

  const uniqueDates = getUniqueDateStrings(checkIns.map((ci) => ci.checkedInAt));

  return countConsecutiveDays(uniqueDates);
};

/**
 * Extract unique date strings (YYYY-MM-DD) from an array of Date objects,
 * sorted descending.
 *
 * @param {Date[]} dates
 * @returns {string[]}
 */
const getUniqueDateStrings = (dates) => {
  const toDateStr = (d) => {
    const date = new Date(d);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  };

  return [...new Set(dates.map(toDateStr))].sort((a, b) => b.localeCompare(a));
};

/**
 * Count consecutive days from a sorted-descending list of date strings.
 * The streak must start from today or yesterday to be valid.
 *
 * @param {string[]} uniqueDates - Sorted descending YYYY-MM-DD strings.
 * @returns {number}
 */
const countConsecutiveDays = (uniqueDates) => {
  const now = new Date();
  const todayStr = toUTCDateStr(now);

  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const yesterdayStr = toUTCDateStr(yesterday);

  // Streak must be active (ending today or yesterday)
  if (uniqueDates[0] !== todayStr && uniqueDates[0] !== yesterdayStr) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    const prevDate = new Date(uniqueDates[i - 1]);
    const currDate = new Date(uniqueDates[i]);
    const diffDays = Math.round((prevDate - currDate) / (24 * 60 * 60 * 1000));

    if (diffDays === 1) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
};

/**
 * Format a Date as a UTC YYYY-MM-DD string.
 * Uses UTC methods to stay consistent with how dates are stored in the database.
 * @param {Date} date
 * @returns {string}
 */
const toUTCDateStr = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

export default { calculateCheckInStreak };
