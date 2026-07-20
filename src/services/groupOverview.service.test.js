import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';
import { thaiDayTag, thaiWeekStartTag, thaiMonthStartTag } from '../utils/thaiTime.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const {
  getGroupsPeriodSteps,
  getGroupPeriodStats,
  getSiblingOverviews,
  getChildRanking,
  getGroupOwnOverview,
} = await import('./groupOverview.service.js');

const USER = (id, name, totalPoints = 0) => ({
  id,
  fullName: name,
  avatarUrl: null,
  department: 'ENG',
  totalPoints,
});

describe('groupOverview.service (Phase 5.2 deferred tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // buildGroupPreview always calls getGroupLeaderboard with a date window,
    // which touches the points ledger even though ranking ignores its output.
    mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([]);
  });

  describe('getGroupsPeriodSteps — fixed query count + window boundaries', () => {
    it('issues exactly 4 queries (1 membership + 3 window groupBys) regardless of group/member count', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'g1', userId: 'u1' },
        { groupId: 'g1', userId: 'u2' },
        { groupId: 'g2', userId: 'u3' },
        { groupId: 'g2', userId: 'u4' },
        { groupId: 'g3', userId: 'u5' },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      await getGroupsPeriodSteps(['g1', 'g2', 'g3']);

      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(3);
    });

    it('returns zeroed stats for an empty groupIds list without querying', async () => {
      const result = await getGroupsPeriodSteps([]);
      expect(result.size).toBe(0);
      expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    });

    it('returns zeroed stats for a group with no members', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([]);
      const result = await getGroupsPeriodSteps(['empty-group']);
      expect(result.get('empty-group')).toEqual({
        today: { steps: 0, calories: 0, distanceKm: 0 },
        week: { steps: 0, calories: 0, distanceKm: 0 },
        month: { steps: 0, calories: 0, distanceKm: 0 },
        memberCount: 0,
      });
      // Bails before the window queries since there are no userIds to aggregate.
      expect(mockPrisma.healthRecord.groupBy).not.toHaveBeenCalled();
    });

    it('passes the correct Thai today/week/month window bounds to each of the three groupBy calls', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const now = new Date();
      await getGroupsPeriodSteps(['g1']);

      const calls = mockPrisma.healthRecord.groupBy.mock.calls.map((c) => c[0].where.recordDate);
      const [todayRange, weekRange, monthRange] = calls;

      const dayStart = thaiDayTag(now);
      expect(todayRange.gte.getTime()).toBe(dayStart.getTime());
      expect(weekRange.gte.getTime()).toBe(thaiWeekStartTag(now).getTime());
      expect(monthRange.gte.getTime()).toBe(thaiMonthStartTag(now).getTime());
      // All three share the same exclusive upper bound: start of tomorrow.
      expect(todayRange.lt.getTime()).toBe(weekRange.lt.getTime());
      expect(weekRange.lt.getTime()).toBe(monthRange.lt.getTime());
    });

    it('folds per-user sums into the correct group for each window independently', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'g1', userId: 'u1' },
        { groupId: 'g2', userId: 'u2' },
      ]);
      // Call order for one group's Promise.all is [today, week, month].
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([{ userId: 'u1', _sum: { steps: 100, calories: 1, distanceKm: 0.1 } }]) // today
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 400, calories: 4, distanceKm: 0.4 } },
          { userId: 'u2', _sum: { steps: 200, calories: 2, distanceKm: 0.2 } },
        ]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 900, calories: 9, distanceKm: 0.9 } },
          { userId: 'u2', _sum: { steps: 500, calories: 5, distanceKm: 0.5 } },
        ]); // month

      const result = await getGroupsPeriodSteps(['g1', 'g2']);

      expect(result.get('g1').today.steps).toBe(100);
      expect(result.get('g1').week.steps).toBe(400);
      expect(result.get('g1').month.steps).toBe(900);
      expect(result.get('g2').today.steps).toBe(0); // u2 had no "today" record
      expect(result.get('g2').week.steps).toBe(200);
      expect(result.get('g2').month.steps).toBe(500);
      expect(result.get('g1').memberCount).toBe(1);
      expect(result.get('g2').memberCount).toBe(1);
    });
  });

  describe('getGroupPeriodStats — single-group wrapper', () => {
    it('returns the same shape as one entry of getGroupsPeriodSteps', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);
      const stats = await getGroupPeriodStats('g1');
      expect(stats).toHaveProperty('today');
      expect(stats).toHaveProperty('week');
      expect(stats).toHaveProperty('month');
      expect(stats).toHaveProperty('memberCount', 1);
    });
  });

  describe('getSiblingOverviews / buildGroupPreview — Top-3 exposure (D1)', () => {
    it('exposes only 3 rows even when a sibling has more than 3 members', async () => {
      // Target group g2's parent is p1; siblings share p1.
      mockPrisma.appGroup.findMany.mockResolvedValue([{ id: 'g1', name: 'Sibling Group' }]); // getSiblingGroups
      mockPrisma.groupMember.findMany
        // First call: getGroupsPeriodSteps' membership query for the sibling(s).
        .mockResolvedValueOnce([
          { groupId: 'g1', userId: 'u1' },
          { groupId: 'g1', userId: 'u2' },
          { groupId: 'g1', userId: 'u3' },
          { groupId: 'g1', userId: 'u4' },
          { groupId: 'g1', userId: 'u5' },
        ])
        // Second call: getGroupLeaderboard's own membership query inside buildGroupPreview.
        .mockResolvedValueOnce([
          { user: USER('u1', 'A') },
          { user: USER('u2', 'B') },
          { user: USER('u3', 'C') },
          { user: USER('u4', 'D') },
          { user: USER('u5', 'E') },
        ]);
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([]) // today
        .mockResolvedValueOnce([]) // week
        .mockResolvedValueOnce([]) // month (getGroupsPeriodSteps)
        // getGroupLeaderboard's own healthRecord.groupBy call for the month window it's passed.
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 10, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 50, calories: 0, distanceKm: 0 } },
          { userId: 'u3', _sum: { steps: 30, calories: 0, distanceKm: 0 } },
          { userId: 'u4', _sum: { steps: 90, calories: 0, distanceKm: 0 } },
          { userId: 'u5', _sum: { steps: 20, calories: 0, distanceKm: 0 } },
        ]);

      const overviews = await getSiblingOverviews('g2', 'p1');

      expect(overviews).toHaveLength(1);
      expect(overviews[0].top3).toHaveLength(3);
      // Never the full ranking, and never the raw `ranking`/`members` fields.
      expect(overviews[0].ranking).toBeUndefined();
      expect(overviews[0].members).toBeUndefined();
      // Sorted descending by real month steps: D(90) > B(50) > C(30).
      expect(overviews[0].top3.map((r) => r.name)).toEqual(['D', 'B', 'C']);
      expect(overviews[0].top3.map((r) => r.rank)).toEqual([1, 2, 3]);
    });

    it('returns an empty array when the group has no parent (no siblings)', async () => {
      const overviews = await getSiblingOverviews('g1', null);
      expect(overviews).toEqual([]);
      expect(mockPrisma.appGroup.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getChildRanking', () => {
    it('ranks children by this-month steps descending with 1..N rank numbering', async () => {
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([
        { id: 'c1', name: 'Child Low' },
        { id: 'c2', name: 'Child High' },
      ]); // getChildGroups
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'c1', userId: 'u1' },
        { groupId: 'c2', userId: 'u2' },
      ]);
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([]) // today
        .mockResolvedValueOnce([]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 100, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 900, calories: 0, distanceKm: 0 } },
        ]); // month

      const { ranking } = await getChildRanking('parent-group');
      expect(ranking.map((r) => r.groupName)).toEqual(['Child High', 'Child Low']);
      expect(ranking.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('returns an empty ranking and zeroed stats for a group with no children', async () => {
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([]);
      const { ranking, stats } = await getChildRanking('leaf-group');
      expect(ranking).toEqual([]);
      expect(stats.month).toEqual({ steps: 0, calories: 0, distanceKm: 0 });
      expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    });
  });

  describe('regression guard — row.points ?? row.totalPoints fallback (Phase 8 kept this alive)', () => {
    it('getGroupOwnOverview.overallStats.totalPoints falls back to totalPoints when .points is absent', async () => {
      // getGroupLeaderboard's all-time branch (no dates) never sets `.points`
      // — only `.totalPoints` (carried from the select) survives. This is
      // the exact shape sumOverallStats's `row.points ?? row.totalPoints`
      // fallback exists to handle; deleting the fallback would silently
      // zero out this figure.
      mockPrisma.groupMember.findMany
        .mockResolvedValueOnce([
          { user: USER('u1', 'Alice', 150) },
          { user: USER('u2', 'Bob', 250) },
        ]) // getGroupLeaderboard membership
        .mockResolvedValueOnce([
          { groupId: 'g1', userId: 'u1' },
          { groupId: 'g1', userId: 'u2' },
        ]); // getGroupPeriodStats membership
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]); // all-time steps + the 3 period windows

      const overview = await getGroupOwnOverview('g1', null, null);

      expect(overview.ranking.every((r) => r.points === undefined)).toBe(true);
      expect(overview.overallStats.totalPoints).toBe(400); // 150 + 250, via the totalPoints fallback
    });
  });
});
