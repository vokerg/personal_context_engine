import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  researchIngressCheckpointKey,
  researchIngressConfig,
  runResearchImportPass,
} from "./research-ingress.js";
import type {
  ContentFile,
  ResearchIngressStore,
} from "./content-store/port.js";

const note = "33333333-3333-4333-8333-333333333333";
const path = `research/inbox/${note}.json`;
const key = researchIngressCheckpointKey("owner-1", "owner/private", "main");

function fakeDb() {
  let cursor: string | null = null;
  let lastScanAt: Date | null = null;
  const db = {
    researchIngressAttempt: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    ingestionCheckpoint: {
      upsert: async () => ({ cursor }),
      update: async (args: {
        data: { cursor: string | null; lastScanAt: Date };
      }) => {
        cursor = args.data.cursor;
        lastScanAt = args.data.lastScanAt;
      },
    },
  } as unknown as PrismaClient;
  return { db, getCursor: () => cursor, getLastScan: () => lastScanAt };
}

describe("research ingress configuration", () => {
  it("is disabled unless separately opted in with private-reader credentials", () => {
    expect(researchIngressConfig({})).toBeNull();
    expect(
      researchIngressConfig({ PCE_RESEARCH_INGRESS_ENABLED: "false" }),
    ).toBeNull();
    expect(() =>
      researchIngressConfig({ PCE_RESEARCH_INGRESS_ENABLED: "enabled" }),
    ).toThrow();
    expect(() =>
      researchIngressConfig({
        PCE_RESEARCH_INGRESS_ENABLED: "true",
        PCE_RESEARCH_INGRESS_REPOSITORY: "owner/public?token=leak",
        PCE_RESEARCH_INGRESS_BRANCH: "main",
        PCE_RESEARCH_INGRESS_TOKEN: "fake",
      }),
    ).toThrow();
    expect(
      researchIngressConfig({
        PCE_RESEARCH_INGRESS_ENABLED: "true",
        PCE_RESEARCH_INGRESS_REPOSITORY: "owner/private",
        PCE_RESEARCH_INGRESS_BRANCH: "main",
        PCE_RESEARCH_INGRESS_TOKEN: "synthetic-not-real",
      }),
    ).toEqual({
      repository: "owner/private",
      branch: "main",
      token: "synthetic-not-real",
    });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toBe(
      researchIngressCheckpointKey("other-owner", "owner/private", "main"),
    );
  });
});

describe("bounded research import pass", () => {
  it("retains failed report input and retries after its parent note is imported", async () => {
    const { db, getCursor, getLastScan } = fakeDb();
    let parentAvailable = false;
    const imports: string[] = [];
    const store: ResearchIngressStore = {
      listResearch: async () => ({
        files: [{ path, revision: "sha-synthetic" }],
      }),
      readResearch: async (): Promise<ContentFile> => ({
        path,
        revision: "sha-synthetic",
        content: '{"schemaVersion":1}',
      }),
    };
    const run = () =>
      runResearchImportPass({
        db,
        store,
        ownerSubject: "owner-1",
        checkpointKey: key,
        importArtifact: async (owner, content, name) => {
          imports.push(owner + ":" + name + ":" + content);
          if (!parentAvailable) throw new Error("Synthetic missing parent");
          return { replayed: false };
        },
      });
    expect(await run()).toMatchObject({
      scanned: 1,
      imported: 0,
      deferred: 1,
      hasMore: false,
    });
    expect(getCursor()).toBeNull();
    parentAvailable = true;
    expect(await run()).toMatchObject({
      scanned: 1,
      imported: 1,
      deferred: 0,
    });
    expect(imports).toHaveLength(2);
    expect(getLastScan()).toBeInstanceOf(Date);
  });

  it("checks observed source revisions, scans with durable cursors, and distinguishes replay", async () => {
    const { db, getCursor } = fakeDb();
    const next = "44444444-4444-4444-8444-444444444444";
    const other = `research/inbox/${next}.json`;
    const calls: (string | undefined)[] = [];
    const store: ResearchIngressStore = {
      listResearch: async (options) => {
        calls.push(options?.cursor);
        return options?.cursor
          ? { files: [{ path: other, revision: "b" }] }
          : { files: [{ path, revision: "a" }], nextCursor: path };
      },
      readResearch: async (name) => ({
        path: name,
        revision: name === path ? "old-a" : "b",
        content: "{}",
      }),
    };
    const run = () =>
      runResearchImportPass({
        db,
        store,
        ownerSubject: "owner-1",
        checkpointKey: key,
        limit: 1,
        importArtifact: async () => ({ replayed: true }),
      });
    expect(await run()).toMatchObject({
      scanned: 1,
      deferred: 1,
      replayed: 0,
      hasMore: true,
    });
    expect(getCursor()).toBe(path);
    expect(await run()).toMatchObject({
      scanned: 1,
      replayed: 1,
      deferred: 0,
      hasMore: false,
    });
    expect(getCursor()).toBeNull();
    expect(calls).toEqual([undefined, path]);
  });

  it("bounds work, guards owner scope and hides exception detail", async () => {
    const { db } = fakeDb();
    const store: ResearchIngressStore = {
      listResearch: async () => ({ files: [{ path, revision: "sha" }] }),
      readResearch: async () => {
        throw new TypeError("Private URL");
      },
    };
    const args = { db, store, ownerSubject: "owner-1", checkpointKey: key };
    await expect(
      runResearchImportPass({ ...args, limit: 101 }),
    ).rejects.toThrow("Invalid research pass limit");
    await expect(
      runResearchImportPass({ ...args, ownerSubject: "../bad" }),
    ).rejects.toThrow("Invalid research scope");
    expect(await runResearchImportPass(args)).toMatchObject({
      scanned: 1,
      invalid: 1,
      imported: 0,
    });
  });
});
