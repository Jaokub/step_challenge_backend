import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const userId = '0546b3bd-07a3-4aa6-ac94-a20f2c421832'; // user's ID
  const now = new Date();
  
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

  console.log('--- Health Summary UTC Query ---');
  console.log('todayStart:', todayStart.toISOString());
  console.log('todayEnd:', todayEnd.toISOString());

  const records = await prisma.healthRecord.findMany({
    where: {
      userId,
      recordDate: { gte: todayStart, lte: todayEnd }
    }
  });

  console.log('Found records (health summary):', records.length);
  if (records.length > 0) console.log('Steps:', records[0].steps);

  console.log('\n--- Dashboard Local Query ---');
  const locStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const locEnd = new Date(locStart.getTime() + 24 * 60 * 60 * 1000);
  console.log('locStart:', locStart.toISOString());
  console.log('locEnd:', locEnd.toISOString());

  const records2 = await prisma.healthRecord.findMany({
    where: {
      userId,
      recordDate: { gte: locStart, lt: locEnd }
    }
  });

  console.log('Found records (dashboard):', records2.length);
  if (records2.length > 0) console.log('Steps:', records2[0].steps);

}

run().finally(() => prisma.$disconnect());
