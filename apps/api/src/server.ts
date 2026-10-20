import { serve } from '@hono/node-server';
import { env, logger, productionConfigProblems, prisma } from '@recap/core';
import { createApp } from './app.js';

process.env.SERVICE_NAME ||= 'api';
const problems = productionConfigProblems(env(), 'api');
if (problems.length) {
  logger.fatal({ problems }, 'Refusing to start: invalid production configuration');
  process.exit(1);
}

const app = createApp();
const port = Number(process.env.PORT || 4000);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST || '0.0.0.0' }, (info) => {
  logger.info({ port: info.port }, 'API listening');
});

const shutdown = async (sig: string) => {
  logger.info({ sig }, 'shutting down API');
  server.close();
  await prisma.$disconnect().catch(() => undefined);
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandledRejection'));
