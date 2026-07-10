import { PrismaClient } from '.prisma/client-order';
import logger from './logger';

const prisma = new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'stdout' },
    { level: 'warn', emit: 'stdout' },
  ],
});

// Prisma SQL 日志：仅在 PRISMA_LOG=true 时输出，避免淹没业务日志
if (process.env.PRISMA_LOG === 'true') {
  prisma.$on('query' as never, (e: any) => {
    logger.debug('Query: ' + e.query);
    logger.debug('Duration: ' + e.duration + 'ms');
  });
}

export default prisma;
