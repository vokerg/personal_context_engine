import { workerStatus } from "./worker.js";

console.log(
  `Worker scaffold started (${workerStatus().state}; no ingestion configured)`,
);
// A pending Promise alone does not keep Node alive; remain explicitly idle.
const heartbeat = setInterval(() => {}, 60_000);
const stop = () => {
  clearInterval(heartbeat);
  console.log("Worker scaffold stopped");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
