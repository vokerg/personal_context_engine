import { Prisma, type PrismaClient } from "@prisma/client";
import { APPROVED_TAG_LIMIT } from "./tag-registry.js";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;

export class TagSnapshotTooLargeError extends Error {
  constructor() {
    super("Approved vocabulary exceeds the snapshot limit");
    this.name = "TagSnapshotTooLargeError";
  }
}

/** Export only approved owner vocabulary. No source-note or candidate reads. */
export function createTagSnapshotRepository(db: PrismaClient) {
  return {
    async readApproved(ownerSubject: string) {
      if (!OWNER.test(ownerSubject)) throw new TypeError("Invalid owner");
      return db.$transaction(
        async (tx) => {
          const [state, rows] = await Promise.all([
            tx.tagRegistryRevision.findUnique({
              where: { ownerSubject },
              select: { revision: true },
            }),
            tx.tagApproval.findMany({
              where: { ownerSubject },
              orderBy: { slug: "asc" },
              take: APPROVED_TAG_LIMIT + 1,
              select: {
                slug: true,
                displayName: true,
                description: true,
              },
            }),
          ]);
          if (rows.length > APPROVED_TAG_LIMIT)
            throw new TagSnapshotTooLargeError();
          return {
            schema_version: 1 as const,
            revision: state?.revision ?? 0,
            tags: rows.map((row) => ({
              slug: row.slug,
              display_name: row.displayName,
              description: row.description,
            })),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}
