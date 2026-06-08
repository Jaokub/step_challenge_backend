const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const prisma = new PrismaClient();

async function backfill() {
  const users = await prisma.user.findMany({ where: { syncToken: null } });
  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { syncToken: uuidv4() }
    });
    console.log(`Updated user ${user.email} with syncToken`);
  }
  console.log('Done');
}

backfill()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
