import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const { getGlobalLeaderboard, getFriendsLeaderboard, getGroupLeaderboard } = await import(
  './leaderboard.service.js'
);

const USER = (id, name, totalPoints = 0) => ({
  id,
  fullName: name,
  avatarUrl: null,
  department: 'ENG',
  totalPoints,
});

describe('leaderboard.service — step-based ranking (BUILD_PLAN Phase 6A HIGH)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: healthy no-op for the points ledger groupBy so tests that
    // don't care about it (all-time branch) don't need to stub it.
    mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([]);
  });

  describe('getGlobalLeaderboard', () => {
    it('ranks by all-time HealthRecord.steps descending and hydrates profiles', async () => {
      // groupBy + orderBy is done in the DB — the mock returns pre-sorted
      // rows the way Postgres would, and the service must NOT re-sort.
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u2', _sum: { steps: 9000 } },
        { userId: 'u1', _sum: { steps: 5000 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        USER('u1', 'Alice'),
        USER('u2', 'Bob'),
      ]);

      const result = await getGlobalLeaderboard(10);

      expect(result.map((r) => r.fullName)).toEqual(['Bob', 'Alice']);
      expect(result.map((r) => r.rank)).toEqual([1, 2]);
      expect(result.map((r) => r.steps)).toEqual([9000, 5000]);
    });

    it('respects the limit by passing it through to the take clause', async () => {
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);
      await getGlobalLeaderboard(5);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 })
      );
    });

    it('users with zero health records are simply absent, not zero-step rows', async () => {
      // Only u1 ever wrote a HealthRecord; u2/u3 exist as users but never
      // synced — groupBy naturally excludes them, and the service must not
      // pad them back in.
      mockPrisma.healthRecord.groupBy.mockResolvedValue([{ userId: 'u1', _sum: { steps: 100 } }]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'Alice')]);

      const result = await getGlobalLeaderboard(10);
      expect(result).toHaveLength(1);
      expect(result[0].fullName).toBe('Alice');
    });

    it('an empty database returns an empty array without querying users', async () => {
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);
      const result = await getGlobalLeaderboard(10);
      expect(result).toEqual([]);
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('does not crash on an orphaned step aggregate (user row missing/deleted)', async () => {
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 100 } },
        { userId: 'ghost', _sum: { steps: 999 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'Alice')]); // 'ghost' not returned

      const result = await getGlobalLeaderboard(10);
      expect(result.map((r) => r.fullName)).toEqual(['Alice']);
    });

    it('no longer orders/selects by totalPoints — ranking input is steps only', async () => {
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 100 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'Alice')]);

      await getGlobalLeaderboard(10);

      // The profile hydration query must not select totalPoints — ranking
      // comes entirely from the prior HealthRecord.groupBy, not the ledger.
      const selectArg = mockPrisma.user.findMany.mock.calls[0][0].select;
      expect(selectArg.totalPoints).toBeUndefined();
      // And the groupBy that actually produces the ranking is ordered by steps.
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { _sum: { steps: 'desc' } } })
      );
    });
  });

  describe('getFriendsLeaderboard', () => {
    it('includes the signed-in user even with zero friendships', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([{ userId: 'me', _sum: { steps: 42 } }]);

      const result = await getFriendsLeaderboard('me', null, null);
      expect(result).toHaveLength(1);
      expect(result[0].fullName).toBe('Me');
      expect(result[0].rank).toBe(1);
    });

    it('ranks by steps (not points) in the all-time branch', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'Friend', 99999) },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { steps: 100 } },
        { userId: 'f1', _sum: { steps: 5000 } }, // way more steps, far fewer "points"
      ]);

      const result = await getFriendsLeaderboard('me', null, null);
      expect(result.map((r) => r.fullName)).toEqual(['Friend', 'Me']);
      expect(result.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('ranks by steps in the date-window branch too (points ledger present but unused for ranking)', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'Friend') },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { steps: 10, calories: 1, distanceKm: 1 } },
        { userId: 'f1', _sum: { steps: 20, calories: 1, distanceKm: 1 } },
      ]);
      // Deliberately give 'me' more points than 'f1' to prove points don't drive order.
      mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { amount: 500 } },
        { userId: 'f1', _sum: { amount: 1 } },
      ]);

      const result = await getFriendsLeaderboard('me', '2026-07-01', '2026-07-08');
      expect(result.map((r) => r.fullName)).toEqual(['Friend', 'Me']);
    });

    it('de-duplicates a bidirectional friendship pair into one entry', async () => {
      // Friendship rows can appear with the current user on either side.
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'Friend') },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const result = await getFriendsLeaderboard('me', null, null);
      const ids = result.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
    });

    it('produces contiguous 1..N rank numbering', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'A') },
        { userId: 'me', friendId: 'f2', user: USER('me', 'Me'), friend: USER('f2', 'B') },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { steps: 300 } },
        { userId: 'f1', _sum: { steps: 100 } },
        { userId: 'f2', _sum: { steps: 200 } },
      ]);

      const result = await getFriendsLeaderboard('me', null, null);
      expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(result.map((r) => r.fullName)).toEqual(['Me', 'B', 'A']);
    });
  });

  describe('getGroupLeaderboard', () => {
    it('ranks group members by steps descending with 1..N ranks (all-time branch)', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { user: USER('u1', 'Low') },
        { user: USER('u2', 'High') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 50 } },
        { userId: 'u2', _sum: { steps: 500 } },
      ]);

      const result = await getGroupLeaderboard('g1', null, null);
      expect(result.map((r) => r.fullName)).toEqual(['High', 'Low']);
      expect(result.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('ranks by steps in the date-window branch', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { user: USER('u1', 'Low') },
        { user: USER('u2', 'High') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 50, calories: 1, distanceKm: 1 } },
        { userId: 'u2', _sum: { steps: 500, calories: 1, distanceKm: 1 } },
      ]);
      mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([]);

      const result = await getGroupLeaderboard('g1', '2026-07-01', '2026-07-08');
      expect(result.map((r) => r.fullName)).toEqual(['High', 'Low']);
    });

    it('an empty group returns an empty array', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([]);
      const result = await getGroupLeaderboard('empty-group', null, null);
      expect(result).toEqual([]);
    });
  });

  describe('applyAllTimeSteps (exercised via the all-time branches above)', () => {
    it('issues exactly one healthRecord.groupBy call regardless of member count', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { user: USER('u1', 'A') },
        { user: USER('u2', 'B') },
        { user: USER('u3', 'C') },
        { user: USER('u4', 'D') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      await getGroupLeaderboard('g1', null, null);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(1);
    });

    it('zero-fills users with no HealthRecord rows instead of leaving steps undefined', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ user: USER('u1', 'NoRecords') }]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]); // nothing for u1

      const result = await getGroupLeaderboard('g1', null, null);
      expect(result[0].steps).toBe(0);
      expect(result[0].calories).toBe(0);
      expect(result[0].distance).toBe(0);
    });

    it('skips the query entirely for an empty user list', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue(null); // current user not found either
      mockPrisma.healthRecord.groupBy.mockClear();

      await getFriendsLeaderboard('nonexistent', null, null);
      expect(mockPrisma.healthRecord.groupBy).not.toHaveBeenCalled();
    });
  });
});
