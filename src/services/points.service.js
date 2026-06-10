/**
 * @module PointsService
 * @description Service for calculating user points based on health data and activities.
 * Implements clean architecture by separating calculation logic from controllers.
 */

// Core configuration for point calculation
const CONFIG = {
  STEPS_PER_POINT: 100,       // 1 point per 100 steps
  CALORIES_PER_POINT: 10,     // 1 point per 10 active calories
  DISTANCE_KM_PER_POINT: 1,   // 1 point per 1 KM
  STREAK_MULTIPLIER: {
    3: 1.1,  // 3-day streak = 10% bonus
    7: 1.25, // 7-day streak = 25% bonus
    14: 1.5, // 14-day streak = 50% bonus
    30: 2.0  // 30-day streak = 100% bonus
  },
  ACTIVITY_CHECKIN_POINTS: 50 // Flat 50 points per event check-in
};

/**
 * Calculates the total points from health metrics
 * @param {Object} metrics - Health metrics
 * @param {number} metrics.steps - Total steps
 * @param {number} metrics.calories - Total active calories
 * @param {number} metrics.distanceKm - Total distance in KM
 * @param {number} currentStreak - User's current daily streak
 * @returns {number} Calculated points (integer)
 */
export const calculateHealthPoints = (metrics, currentStreak = 0) => {
  const { steps = 0, calories = 0, distanceKm = 0 } = metrics;
  
  // Base points calculation
  const stepsPoints = Math.floor(steps / CONFIG.STEPS_PER_POINT);
  const caloriesPoints = Math.floor(calories / CONFIG.CALORIES_PER_POINT);
  const distancePoints = Math.floor(distanceKm / CONFIG.DISTANCE_KM_PER_POINT);
  
  const basePoints = stepsPoints + caloriesPoints + distancePoints;
  
  // Apply streak multiplier
  let multiplier = 1.0;
  if (currentStreak >= 30) multiplier = CONFIG.STREAK_MULTIPLIER[30];
  else if (currentStreak >= 14) multiplier = CONFIG.STREAK_MULTIPLIER[14];
  else if (currentStreak >= 7) multiplier = CONFIG.STREAK_MULTIPLIER[7];
  else if (currentStreak >= 3) multiplier = CONFIG.STREAK_MULTIPLIER[3];
  
  return Math.floor(basePoints * multiplier);
};

/**
 * Calculates points for checking into an activity
 * @returns {number} Points for activity check-in
 */
export const getActivityCheckinPoints = () => {
  return CONFIG.ACTIVITY_CHECKIN_POINTS;
};

/**
 * Helper to calculate the difference in points between two health metric states
 * Useful for upserting daily health data without overcounting
 */
export const calculatePointsDelta = (oldMetrics, newMetrics, currentStreak = 0) => {
  const oldPoints = calculateHealthPoints(oldMetrics, currentStreak);
  const newPoints = calculateHealthPoints(newMetrics, currentStreak);
  return newPoints - oldPoints;
};

export default {
  calculateHealthPoints,
  getActivityCheckinPoints,
  calculatePointsDelta,
  CONFIG
};
