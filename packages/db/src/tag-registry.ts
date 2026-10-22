import { Prisma, type PrismaClient } from "@prisma/client";
import { effectiveTagsSql } from "./note-tags.js";

export const APPROVED_TAG_LIMIT = 200;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TagApprovalInput {
  displayName?: string | null;
  description?: string | null;
}

function validate(owner: string, slug?: string) {
  if (!OWNER_PATTERN.test(owner)) throw new TypeError("Invalid verified owner");
  if (slug !== undefined && (slug.length > 64 || !SLUG_PATTERN.test(slug)))
    throw new TypeError("Invalid tag slug");
}

function ensureDetails(input: TagApprovalInput) {
  if (
    (input.displayName != null &&
      (input.displayName.trim().length === 0 ||
        input.displayName.length > 120)) ||
    (input.description != null && input.description.length > 500)
  )
    throw new TypeError("Invalid tag metadata");
}

function revisionOf(
  tx: Prisma.TransactionClient,
  owner: string,
): Promise<number> {
  return tx.tagRegistryRevision
    .upsert({
      where: { ownerSubject: owner },
      create: { ownerSubject: owner, revision: 1 },
      update: { revision: { increment: 1 } },
      select: { revision: true },
    })
    .then((r) => r.revision);
}

/** Approval is a separate catalog fact; imported notes remain unchanged. */
export function createTagRegistryRepository(db: PrismaClient) {
  async function mutation(
    owner: string,
    slug: string,
    operation: "approve" | "unapprove",
    input: TagApprovalInput = {},
  ) {
    validate(owner, slug);
    ensureDetails(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.$transaction(
          async (tx) => {
            const key = { ownerSubject_slug: { ownerSubject: owner, slug } };
            const existing = await tx.tagApproval.findUnique({ where: key });
            let changed = false;
            if (operation === "approve") {
              if (!existing) {
                await tx.tagApproval.create({
                  data: {
                    ownerSubject: owner,
                    slug,
                    displayName: input.displayName ?? null,
                    description: input.description ?? null,
                  },
                });
                changed = true;
              } else {
                const displayName =
                  input.displayName === undefined
                    ? existing.displayName
                    : input.displayName;
                const description =
                  input.description === undefined
                    ? existing.description
                    : input.description;
                if (
                  existing.displayName !== displayName ||
                  existing.description !== description
                ) {
                  await tx.tagApproval.update({
                    where: key,
                    data: { displayName, description },
                  });
                  changed = true;
                }
              }
            } else if (existing) {
              await tx.tagApproval.delete({ where: key });
              changed = true;
            }
            const revision = changed
              ? await revisionOf(tx, owner)
              : ((
                  await tx.tagRegistryRevision.findUnique({
                    where: { ownerSubject: owner },
                    select: { revision: true },
                  })
                )?.revision ?? 0);
            if (changed) {
              // Same serializable transaction as vocabulary mutation; one
              // owner row coalesces changes, including while a job is leased.
              await tx.tagSnapshotOutbox.upsert({
                where: { ownerSubject: owner },
                create: { ownerSubject: owner, desiredRevision: revision },
                update: {
                  desiredRevision: revision,
                  status: "PENDING",
                  attemptCount: 0,
                  leaseOwner: null,
                  leaseUntil: null,
                  nextRetryAt: null,
                  lastErrorCode: null,
                },
              });
            }
            return {
              slug,
              approved: operation === "approve",
              changed,
              revision,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        // Parallel approvals of the same slug converge idempotently.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2025", "P2034"].includes(error.code) &&
          attempt < 2
        )
          continue;
        throw error;
      }
    }
    throw new Error("Registry transaction retry exhausted");
  }
  return {
    async listByOwner(owner: string) {
      validate(owner);
      const [all, state] = await Promise.all([
        db.tagApproval.findMany({
          where: { ownerSubject: owner },
          orderBy: { slug: "asc" },
          take: APPROVED_TAG_LIMIT + 1,
        }),
        db.tagRegistryRevision.findUnique({
          where: { ownerSubject: owner },
          select: { revision: true },
        }),
      ]);
      const rows = all.slice(0, APPROVED_TAG_LIMIT);
      const slugs = rows.map((r) => r.slug);
      const counts = slugs.length
        ? await db.$queryRaw<Array<{ slug: string; count: bigint }>>(
            Prisma.sql`
              SELECT t.slug AS slug, count(DISTINCT n.id)::bigint AS count
              FROM notes n
              LEFT JOIN note_tag_overrides o ON o."noteId"=n.id AND o."ownerSubject"=n."ownerSubject"
              CROSS JOIN LATERAL unnest(${effectiveTagsSql}) AS t(slug)
              WHERE n."ownerSubject" = ${owner}
                AND t.slug IN (${Prisma.join(slugs)})
              GROUP BY t.slug
            `,
          )
        : [];
      const bySlug = new Map(
        counts.map((row) => [row.slug, Number(row.count)]),
      );
      return {
        revision: state?.revision ?? 0,
        truncated: all.length > APPROVED_TAG_LIMIT,
        approved: rows.map((row) => ({
          slug: row.slug,
          displayName: row.displayName,
          description: row.description,
          noteCount: bySlug.get(row.slug) ?? 0,
          approvedAt: row.approvedAt.toISOString(),
        })),
      };
    },
    async getSnapshotStatus(owner: string) {
      validate(owner);
      const [state, job] = await Promise.all([
        db.tagRegistryRevision.findUnique({
          where: { ownerSubject: owner },
          select: { revision: true },
        }),
        db.tagSnapshotOutbox.findUnique({
          where: { ownerSubject: owner },
        }),
      ]);
      const revision = state?.revision ?? 0;
      const publishedRevision = job && job.publishedRevision >= 0
        ? job.publishedRevision
        : null;
      return {
        desiredRevision: revision,
        publishedRevision,
        publishedAt: job?.publishedAt?.toISOString() ?? null,
        stale: publishedRevision === null || publishedRevision < revision,
        state: job?.status ?? "NOT_QUEUED",
        lastErrorCode: job?.lastErrorCode ?? null,
      };
    },
    approveByOwner: (owner: string, slug: string, input: TagApprovalInput) =>
      mutation(owner, slug, "approve", input),
    unapproveByOwner: (owner: string, slug: string) =>
      mutation(owner, slug, "unapprove"),
  };
}
