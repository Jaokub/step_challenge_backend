import { vi } from 'vitest';

/**
 * @module test-utils/mockPrisma
 * @description Builds a fresh fake Prisma client for unit tests. Every
 * model/method used anywhere in the services under test in Phase 6A is a
 * `vi.fn()` stub so a test can `.mockResolvedValueOnce(...)` on exactly the
 * call it cares about. Not exhaustive of the real Prisma API — add a method
 * here the first time a test needs it.
 *
 * `$transaction` defaults to just invoking the callback with the same mock
 * client (no real transaction semantics) so services that wrap writes in
 * `prisma.$transaction(tx => ...)` can be tested without extra ceremony.
 * Override it per-test with `mockPrisma.$transaction.mockImplementationOnce(...)`
 * if a test needs to assert transactional behavior specifically.
 */
export const createMockPrisma = () => {
  const mock = {
    healthRecord: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    friendship: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    groupMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    appGroup: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    groupParentRequest: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    activityParticipant: {
      createMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    checkIn: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    activity: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    eventParticipant: {
      findMany: vi.fn(),
    },
    pointsLedgerEntry: {
      groupBy: vi.fn(),
    },
  };

  mock.$transaction = vi.fn(async (arg) => {
    if (typeof arg === 'function') return arg(mock);
    // Array-of-promises form: just await them all, same as real Prisma.
    return Promise.all(arg);
  });

  return mock;
};

export default createMockPrisma;
