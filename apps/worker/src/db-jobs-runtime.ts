import type { PrismaClient } from "@prisma/client";

// A full hour between passes allows Neon's five-minute Free-plan scale-to-zero
// timeout to elapse, even when no new queue work has arrived.
export const DB_JOBS_COOLDOWN_MS = 60 * 60_000;

/** Release Prisma's pool after every pass, including failed connections/jobs. */
export async function withDbJobsConnection(
  db: Pick<PrismaClient, "$connect" | "$disconnect">,
  pass: () => Promise<void>,
): Promise<void> {
  try {
    await db.$connect();
    await pass();
  } finally {
    await db.$disconnect();
  }
}
