import { createApp } from './app.js';

const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be a valid TCP port');
}
const app = createApp();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
try {
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Scaffold API listening at http://127.0.0.1:${port}`);
} catch (error) {
  console.error('Unable to start scaffold API');
  await app.close();
  process.exitCode = 1;
}
