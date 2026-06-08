import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const userId = '0546b3bd-07a3-4aa6-ac94-a20f2c421832';
  
  const allRecords = await prisma.healthRecord.findMany({ where: { userId } });
  console.log("All records length:", allRecords.length);
  
  if (allRecords.length > 0) {
    const recordTime = allRecords[0].recordDate.getTime();
    console.log("Record time:", new Date(recordTime).toISOString(), "->", recordTime);
    
    const now = new Date();
    console.log("now:", now.toISOString());
    const locStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const locEnd = new Date(locStart.getTime() + 24 * 60 * 60 * 1000);
    
    console.log("locStart:", locStart.toISOString(), "->", locStart.getTime());
    console.log("locEnd:", locEnd.toISOString(), "->", locEnd.getTime());
    
    console.log("Is recordTime >= locStart?", recordTime >= locStart.getTime());
    console.log("Is recordTime < locEnd?", recordTime < locEnd.getTime());
  }
}

run().finally(() => prisma.$disconnect());
