import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const { enrollGroup, joinIndividual, leaveActivity } = await import('./activityParticipant.service.js');

describe('activityParticipant.service — enroll/leave guards (BUILD_PLAN Phase 6A "enroll" list)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enrollGroup', () => {
    it('registers every current group member, one row per member', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
        { userId: 'u3' },
      ]);
      mockPrisma.activityParticipant.createMany.mockResolvedValue({ count: 3 });

      const result = await enrollGroup('activity-1', 'group-1');

      expect(mockPrisma.activityParticipant.createMany).toHaveBeenCalledWith({
        data: [
          { activityId: 'activity-1', userId: 'u1', groupId: 'group-1' },
          { activityId: 'activity-1', userId: 'u2', groupId: 'group-1' },
          { activityId: 'activity-1', userId: 'u3', groupId: 'group-1' },
        ],
        skipDuplicates: true,
      });
      expect(result).toEqual({ added: 3 });
    });

    it('is idempotent — re-running with skipDuplicates never errors on already-enrolled members', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      // Second run: only u2 is actually new (u1 already has a row and gets skipped by the DB).
      mockPrisma.activityParticipant.createMany.mockResolvedValue({ count: 1 });

      const result = await enrollGroup('activity-1', 'group-1');

      expect(mockPrisma.activityParticipant.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      );
      expect(result).toEqual({ added: 1 });
    });

    it('no-ops (and never calls createMany) for a group with zero members', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([]);
      const result = await enrollGroup('activity-1', 'empty-group');

      expect(result).toEqual({ added: 0 });
      expect(mockPrisma.activityParticipant.createMany).not.toHaveBeenCalled();
    });
  });

  describe('joinIndividual', () => {
    it('upserts a groupId:null row keyed on the [activityId, userId] unique constraint', async () => {
      mockPrisma.activityParticipant.upsert.mockResolvedValue({ id: 'p1' });

      await joinIndividual('activity-1', 'user-1');

      expect(mockPrisma.activityParticipant.upsert).toHaveBeenCalledWith({
        where: { activityId_userId: { activityId: 'activity-1', userId: 'user-1' } },
        create: { activityId: 'activity-1', userId: 'user-1', groupId: null },
        update: {}, // re-joining is a no-op, not a second row or an error
      });
    });
  });

  describe('leaveActivity', () => {
    it('removes only the caller\'s own participant row', async () => {
      mockPrisma.activityParticipant.deleteMany.mockResolvedValue({ count: 1 });

      await leaveActivity('activity-1', 'user-1');

      expect(mockPrisma.activityParticipant.deleteMany).toHaveBeenCalledWith({
        where: { activityId: 'activity-1', userId: 'user-1' },
      });
    });
  });
});
