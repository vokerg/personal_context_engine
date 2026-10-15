import { workerStatus } from './worker.js';

console.log(`Worker scaffold started (${workerStatus().state}; no ingestion configured)`);
await new Promise<void>((resolve) => {
  process.once('SIGTERM', resolve);
  process.once('SIGINT', resolve);
});
console.log('Worker scaffold stopped');
