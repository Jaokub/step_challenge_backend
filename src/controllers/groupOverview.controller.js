import {
  getGroupOwnOverview,
  getSiblingOverviews,
  getChildRanking,
  getHierarchyOverview,
} from '../services/groupOverview.service.js';

/**
 * @module GroupOverviewController
 * @description Hierarchy-aware group stat endpoints. Split out from
 * group.controller.js to keep both files under the 200-line convention.
 */

/**
 * Own overall stats + full ranking + top3/top5 for a group. Caller must be
 * a member of the group itself, or a member of its parent group (ancestor).
 * requireGroupVisibility(['self', 'ancestor']) middleware enforces this.
 * @route GET /api/groups/:id/overview
 */
export const getGroupOverview = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const { startDate, endDate } = req.query;

    const overview = await getGroupOwnOverview(groupId, startDate, endDate);

    return res.json({
      success: true,
      data: { groupId, ...overview },
      message: 'Group overview retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching group overview:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch group overview',
    });
  }
};

/**
 * Sibling groups' stats + Top-3 members preview (never the full ranking).
 * Caller must be a member of the group itself, or a member of its parent
 * group. requireGroupVisibility(['self', 'ancestor']) middleware enforces
 * this.
 * @route GET /api/groups/:id/siblings
 */
export const getGroupSiblings = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    // req.groupNode is attached by requireGroupVisibility.
    const parentGroupId = req.groupNode?.parentGroupId ?? null;
    const siblings = await getSiblingOverviews(groupId, parentGroupId);

    return res.json({
      success: true,
      data: siblings,
      message: 'Sibling group stats retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching sibling groups:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch sibling group stats',
    });
  }
};

/**
 * Direct child groups ranked by this-month steps, plus an aggregate stats
 * bar across all of them. Backs frame 20's full list. Caller must be a
 * member of the group itself, an ancestor, or Faculty Admin.
 * requireGroupVisibility(['self', 'ancestor']) (with the admin bypass)
 * enforces this.
 * @route GET /api/groups/:id/children
 */
export const getGroupChildren = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const result = await getChildRanking(groupId);

    return res.json({
      success: true,
      data: result,
      message: 'Child group ranking retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching child group ranking:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch child group ranking',
    });
  }
};

const VALID_PERIODS = new Set(['today', 'week', 'month']);
const sanitizePeriod = (value) => (VALID_PERIODS.has(value) ? value : 'month');

/**
 * Bundled { parent, siblings, children } for the frame-13/15 relation
 * cards in one authorized call. Caller must be a member of the group
 * itself (requireGroupMember() — also lets a member read their PARENT's
 * stats+top3 without a separate 'descendant' visibility relation, since
 * access is gated on membership of the group whose page this is, not on
 * membership of the parent).
 *
 * Each relation card ranks its Top-3 members independently — the mobile
 * screen shows one day/week/month pill per section (parent card, the
 * siblings section, the children section), so each accepts its own query
 * param rather than one shared period for the whole call.
 * @route GET /api/groups/:id/hierarchy-overview?parentPeriod=&siblingsPeriod=&childrenPeriod=
 */
export const getGroupHierarchyOverview = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const periods = {
      parentPeriod: sanitizePeriod(req.query.parentPeriod),
      siblingsPeriod: sanitizePeriod(req.query.siblingsPeriod),
      childrenPeriod: sanitizePeriod(req.query.childrenPeriod),
    };
    const overview = await getHierarchyOverview(groupId, periods);

    if (!overview) {
      return res.status(404).json({ success: false, data: null, message: 'Group not found' });
    }

    return res.json({
      success: true,
      data: overview,
      message: 'Group hierarchy overview retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching group hierarchy overview:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch group hierarchy overview',
    });
  }
};
