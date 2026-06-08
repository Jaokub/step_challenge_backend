import fetch from 'node-fetch'; // if available, or just mock the logic
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testSummary() {
  const userId = "0546b3bd-07a3-4aa6-ac94-a20f2c421832"; // The user we just saw
  const now = new Date();

  // Today (UTC)
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

  console.log("Looking for dates between", todayStart, "and", todayEnd);

  const todayRecords = await prisma.healthRecord.findMany({
    where: {
      userId,
      recordDate: { gte: todayStart, lte: todayEnd },
    },
  });

  console.log("todayRecords:", todayRecords);
}

testSummary()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
