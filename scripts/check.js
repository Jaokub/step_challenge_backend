import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const records = await prisma.healthRecord.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(records, null, 2));
}

check()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
