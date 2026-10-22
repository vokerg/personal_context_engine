import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createTagRegistryRepository,
  createTagSnapshotRepository,
} from "@pce/db";
import { runTagSnapshotPass } from "./tag-snapshot-jobs.js";
import {
  SnapshotPublishError,
  type ApprovedTagSnapshot,
} from "./tag-snapshot-publisher.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "taxonomy-export-" + randomUUID();
const other = "taxonomy-other-" + randomUUID();

describe.skipIf(!url)("tag publisher DB outbox (synthetic; no GitHub)", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    await db.tagSnapshotOutbox.deleteMany({
      where: { ownerSubject: { in: [owner, other] } },
    });
    await db.tagApproval.deleteMany({
      where: { ownerSubject: { in: [owner, other] } },
    });
    await db.tagRegistryRevision.deleteMany({
      where: { ownerSubject: { in: [owner, other] } },
    });
    await db.$disconnect();
  });

  it("initial empty registry publishes revision zero once", async () => {
    const snapshots: ApprovedTagSnapshot[] = [];
    const publisher = {
      async publish(snapshot: ApprovedTagSnapshot) {
        snapshots.push(snapshot);
        return { hash: "a".repeat(64), changed: true };
      },
    };
    expect(await runTagSnapshotPass(db, owner, publisher)).toMatchObject({
      published: 1,
    });
    expect(snapshots).toEqual([{ schema_version: 1, revision: 0, tags: [] }]);
    expect(await runTagSnapshotPass(db, owner, publisher)).toMatchObject({
      published: 0,
      unchanged: 0,
    });
    expect(snapshots).toHaveLength(1);
    expect(
      await createTagRegistryRepository(db).getSnapshotStatus(owner),
    ).toMatchObject({ stale: false, publishedRevision: 0, state: "PUBLISHED" });
  });

  it("coalesces mutation intents, preserves independent owner approvals and retries safely", async () => {
    const registry = createTagRegistryRepository(db);
    await registry.approveByOwner(owner, "zulu", { displayName: "Zürich" });
    await registry.approveByOwner(owner, "alpha", {});
    await registry.approveByOwner(other, "foreign", {});
    await registry.approveByOwner(owner, "alpha", {});
    expect(
      await db.tagSnapshotOutbox.findUnique({ where: { ownerSubject: owner } }),
    ).toMatchObject({ desiredRevision: 2, status: "PENDING", attemptCount: 0 });
    const captured = await createTagSnapshotRepository(db).readApproved(owner);
    expect(captured).toMatchObject({
      schema_version: 1,
      revision: 2,
      tags: [{ slug: "alpha" }, { slug: "zulu", display_name: "Zürich" }],
    });
    expect(JSON.stringify(captured)).not.toContain("foreign");
    const failing = {
      async publish(): Promise<{ hash: string; changed: boolean }> {
        throw new SnapshotPublishError("UNAVAILABLE");
      },
    };
    expect(await runTagSnapshotPass(db, owner, failing)).toMatchObject({
      retried: 1,
    });
    let state = await db.tagSnapshotOutbox.findUnique({
      where: { ownerSubject: owner },
    });
    expect(state).toMatchObject({
      status: "RETRY",
      attemptCount: 1,
      lastErrorCode: "UNAVAILABLE",
    });
    expect(await runTagSnapshotPass(db, owner, failing)).toMatchObject({
      retried: 0,
    });
    const successful = {
      async publish(input: ApprovedTagSnapshot) {
        expect(input.revision).toBe(2);
        return { hash: "b".repeat(64), changed: true };
      },
    };
    const next = new Date(state!.nextRetryAt!.getTime() + 1000);
    expect(
      await runTagSnapshotPass(db, owner, successful, randomUUID(), next),
    ).toMatchObject({ published: 1 });
    state = await db.tagSnapshotOutbox.findUnique({
      where: { ownerSubject: owner },
    });
    expect(state).toMatchObject({
      status: "PUBLISHED",
      publishedRevision: 2,
      publishedHash: "b".repeat(64),
    });
    expect(await registry.getSnapshotStatus(owner)).toMatchObject({
      stale: false,
      desiredRevision: 2,
      publishedRevision: 2,
    });
  });

  it("does not acknowledge an obsolete publish if an approval changes during the request", async () => {
    const registry = createTagRegistryRepository(db);
    await registry.unapproveByOwner(owner, "alpha");
    const stale = {
      async publish(snapshot: ApprovedTagSnapshot) {
        expect(snapshot.revision).toBe(3);
        await registry.approveByOwner(owner, "newly-approved", {});
        return { hash: "c".repeat(64), changed: true };
      },
    };
    expect((await runTagSnapshotPass(db, owner, stale)).published).toBe(0);
    expect(await registry.getSnapshotStatus(owner)).toMatchObject({
      stale: true,
      desiredRevision: 4,
      publishedRevision: 2,
      state: "PENDING",
    });
    const current = {
      async publish(snapshot: ApprovedTagSnapshot) {
        expect(snapshot.revision).toBe(4);
        return { hash: "d".repeat(64), changed: false };
      },
    };
    expect((await runTagSnapshotPass(db, owner, current)).unchanged).toBe(1);
    expect(await registry.getSnapshotStatus(owner)).toMatchObject({
      stale: false,
      publishedRevision: 4,
    });
  });
});
