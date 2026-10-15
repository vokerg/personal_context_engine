import Fastify from 'fastify';
import { HealthResponseSchema } from '@pce/contracts';

/** No private routes or backing services exist in the scaffold. */
export function createApp() {
  const app = Fastify({ logger: false });
  app.get('/health', async () => HealthResponseSchema.parse({ status: 'ok' }));
  return app;
}
