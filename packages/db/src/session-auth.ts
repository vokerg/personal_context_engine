import type { PrismaClient, Prisma } from "@prisma/client";

export function createSessionRepository(db: PrismaClient) {
  return {
    createSession(data: Prisma.AuthSessionCreateInput) {
      return db.authSession.create({ data });
    },
    findSession(
      tokenHash: string,
      ownerSubject: string,
      issuer: string,
      audience: string,
      now: Date,
    ) {
      return db.authSession.findFirst({
        where: {
          tokenHash,
          ownerSubject,
          issuer,
          audience,
          revokedAt: null,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
      });
    },
    async touchSession(id: string, now: Date, expiresAt: Date) {
      await db.authSession.updateMany({
        where: { id, revokedAt: null, expiresAt: { gt: now } },
        data: { lastSeenAt: now, expiresAt },
      });
    },
    async revokeSession(id: string) {
      await db.authSession.updateMany({
        where: { id },
        data: { revokedAt: new Date() },
      });
    },
    createGrant(data: Prisma.ApiGrantUncheckedCreateInput) {
      return db.apiGrant.create({ data });
    },
    findGrant(
      accessHash: string,
      ownerSubject: string,
      issuer: string,
      audience: string,
      now: Date,
    ) {
      return db.apiGrant.findFirst({
        where: {
          accessHash,
          audience,
          revokedAt: null,
          expiresAt: { gt: now },
          session: {
            ownerSubject,
            issuer,
            revokedAt: null,
            expiresAt: { gt: now },
            absoluteExpiresAt: { gt: now },
          },
        },
        include: { session: true },
      });
    },
    findRefresh(
      refreshHash: string,
      clientId: string,
      ownerSubject: string,
      issuer: string,
      audience: string,
      now: Date,
    ) {
      return db.apiGrant.findFirst({
        where: {
          refreshHash,
          clientId,
          audience,
          revokedAt: null,
          refreshExpiresAt: { gt: now },
          session: {
            ownerSubject,
            issuer,
            revokedAt: null,
            expiresAt: { gt: now },
            absoluteExpiresAt: { gt: now },
          },
        },
        include: { session: true },
      });
    },
    async rotateGrant(
      id: string,
      oldHash: string,
      accessHash: string,
      refreshHash: string,
      expiresAt: Date,
    ) {
      const updated = await db.apiGrant.updateMany({
        where: { id, refreshHash: oldHash, revokedAt: null },
        data: { accessHash, refreshHash, expiresAt },
      });
      return updated.count === 1;
    },
    async revokeGrant(tokenHash: string) {
      await db.apiGrant.updateMany({
        where: { OR: [{ accessHash: tokenHash }, { refreshHash: tokenHash }] },
        data: { revokedAt: new Date() },
      });
    },
  };
}
export type SessionRepository = ReturnType<typeof createSessionRepository>;
