import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 * Reuses a single PrismaClient instance across the application to avoid
 * exhausting database connections, especially during development with
 * hot-reloading (nodemon).
 */

/** @type {PrismaClient} */
let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  // In development, attach the client to globalThis to prevent
  // multiple instances when nodemon restarts the server.
  if (!globalThis.__prisma) {
    globalThis.__prisma = new PrismaClient({
      log: ['query', 'warn', 'error'],
    });
  }
  prisma = globalThis.__prisma;
}

export default prisma;
