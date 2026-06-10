import leaderboardService from '../services/leaderboard.service.js';

/**
 * @module LeaderboardController
 */

/**
 * Get global leaderboard
 * @route GET /api/leaderboard/global
 */
export const getGlobalLeaderboard = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const leaderboard = await leaderboardService.getGlobalLeaderboard(limit);
    
    return res.status(200).json({
      success: true,
      data: leaderboard,
      message: 'Global leaderboard retrieved successfully'
    });
  } catch (error) {
    console.error('getGlobalLeaderboard error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve global leaderboard'
    });
  }
};

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
