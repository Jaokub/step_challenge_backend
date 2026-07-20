import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const { getIndividualLeaderboard, getGroupLeaderboard, getEventStats } = await import(
  './eventStats.service.js'
);

// A fixed event window so thaiDayTag(startDate)/thaiDayTag(endDate) are
// deterministic regardless of when the suite runs.
const EVENT = {
  id: 'evt-1',
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  endDate: new Date('2026-07-07T00:00:00.000Z'),
};

const USER = (id, name) => ({ id, fullName: name, avatarUrl: null, department: 'ENG' });

describe('eventStats.service — reconciliation identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('event total steps === sum of every individual participant\'s steps', async () => {
    const participants = [
      { userId: 'u1', groupId: 'g1', joinMode: 'GROUP', user: USER('u1', 'Alice'), group: { id: 'g1', name: 'Lab A' } },
      { userId: 'u2', groupId: 'g1', joinMode: 'GROUP', user: USER('u2', 'Bob'), group: { id: 'g1', name: 'Lab A' } },
      { userId: 'u3', groupId: null, joinMode: 'INDIVIDUAL', user: USER('u3', 'Carol'), group: null },
    ];
    mockPrisma.eventParticipant.findMany.mockResolvedValue(participants);
    mockPrisma.healthRecord.groupBy.mockResolvedValue([
      { userId: 'u1', _sum: { steps: 1000 } },
      { userId: 'u2', _sum: { steps: 2000 } },
      { userId: 'u3', _sum: { steps: 500 } },
    ]);

    const individual = await getIndividualLeaderboard(EVENT);
    const stats = await getEventStats(EVENT);

    const sumOfIndividuals = individual.reduce((acc, row) => acc + row.steps, 0);
    expect(sumOfIndividuals).toBe(3500);
    expect(stats.totalSteps).toBe(sumOfIndividuals);
    expect(stats.participantCount).toBe(3);
  });

  it('group-sum ranking total is a subset of (never exceeds) the event total', async () => {
    const participants = [
      { userId: 'u1', groupId: 'g1', joinMode: 'GROUP', user: USER('u1', 'Alice'), group: { id: 'g1', name: 'Lab A' } },
      { userId: 'u2', groupId: 'g1', joinMode: 'GROUP', user: USER('u2', 'Bob'), group: { id: 'g1', name: 'Lab A' } },
      { userId: 'u3', groupId: 'g2', joinMode: 'GROUP', user: USER('u3', 'Carol'), group: { id: 'g2', name: 'Lab B' } },
      // Individual join-mode participant: counts toward the event total but
      // is excluded from the group-sum ranking (no group to attribute it to).
      { userId: 'u4', groupId: null, joinMode: 'INDIVIDUAL', user: USER('u4', 'Dan'), group: null },
    ];
    mockPrisma.eventParticipant.findMany.mockResolvedValue(participants);
    mockPrisma.healthRecord.groupBy.mockResolvedValue([
      { userId: 'u1', _sum: { steps: 1000 } },
      { userId: 'u2', _sum: { steps: 1500 } },
      { userId: 'u3', _sum: { steps: 800 } },
      { userId: 'u4', _sum: { steps: 5000 } }, // large, but must NOT leak into the group sums
    ]);

    const groups = await getGroupLeaderboard(EVENT);
    const stats = await getEventStats(EVENT);

    const groupTotal = groups.reduce((acc, g) => acc + g.totalSteps, 0);
    expect(groupTotal).toBe(1000 + 1500 + 800); // u4 excluded
    expect(groupTotal).toBeLessThan(stats.totalSteps);
    expect(stats.totalSteps).toBe(groupTotal + 5000);
    expect(stats.groupCount).toBe(2);

    // Each group's own total must equal the sum of its own members.
    const labA = groups.find((g) => g.groupId === 'g1');
    expect(labA.totalSteps).toBe(2500);
    expect(labA.memberCount).toBe(2);
  });

  it('all three views are derived from the same stepsMap — no double-counting a user with 0 records', async () => {
    const participants = [
      { userId: 'u1', groupId: 'g1', joinMode: 'GROUP', user: USER('u1', 'Alice'), group: { id: 'g1', name: 'Lab A' } },
    ];
    mockPrisma.eventParticipant.findMany.mockResolvedValue(participants);
    mockPrisma.healthRecord.groupBy.mockResolvedValue([]); // no HealthRecord rows at all

    const individual = await getIndividualLeaderboard(EVENT);
    const groups = await getGroupLeaderboard(EVENT);
    const stats = await getEventStats(EVENT);

    expect(individual[0].steps).toBe(0);
    expect(groups[0].totalSteps).toBe(0);
    expect(stats.totalSteps).toBe(0);
  });

  it('ranks participants/groups by steps descending with 1..N rank numbering', async () => {
    const participants = [
      { userId: 'u1', groupId: null, joinMode: 'INDIVIDUAL', user: USER('u1', 'Low'), group: null },
      { userId: 'u2', groupId: null, joinMode: 'INDIVIDUAL', user: USER('u2', 'High'), group: null },
      { userId: 'u3', groupId: null, joinMode: 'INDIVIDUAL', user: USER('u3', 'Mid'), group: null },
    ];
    mockPrisma.eventParticipant.findMany.mockResolvedValue(participants);
    mockPrisma.healthRecord.groupBy.mockResolvedValue([
      { userId: 'u1', _sum: { steps: 100 } },
      { userId: 'u2', _sum: { steps: 900 } },
      { userId: 'u3', _sum: { steps: 500 } },
    ]);

    const individual = await getIndividualLeaderboard(EVENT);
    expect(individual.map((r) => r.fullName)).toEqual(['High', 'Mid', 'Low']);
    expect(individual.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});
