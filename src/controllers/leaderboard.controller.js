import leaderboardService from '../services/leaderboard.service.js';

/**
 * @module LeaderboardController
 */

/**
 * Get friends leaderboard
 * @route GET /api/leaderboard/friends
 */
export const getFriendsLeaderboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;
    const leaderboard = await leaderboardService.getFriendsLeaderboard(userId, startDate, endDate);
    
    return res.status(200).json({
      success: true,
      data: leaderboard,
      message: 'Friends leaderboard retrieved successfully'
    });
  } catch (error) {
    console.error('getFriendsLeaderboard error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve friends leaderboard'
    });
  }
};

/**
 * Get group leaderboard
 * @route GET /api/leaderboard/group/:groupId
 */
export const getGroupLeaderboard = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { startDate, endDate } = req.query;
    const leaderboard = await leaderboardService.getGroupLeaderboard(groupId, startDate, endDate);
    
    return res.status(200).json({
      success: true,
      data: leaderboard,
      message: 'Group leaderboard retrieved successfully'
    });
  } catch (error) {
    console.error('getGroupLeaderboard error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve group leaderboard'
    });
  }
};
