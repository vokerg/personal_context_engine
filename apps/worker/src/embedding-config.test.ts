import { describe, expect, it } from "vitest";
import { embeddingConfig } from "./embedding-config.js";

const env = {
  PCE_EMBEDDINGS_ENABLED: "true",
  PCE_EMBEDDING_EGRESS_APPROVED: "I_APPROVE_PRIVATE_TEXT_TO_OPENAI",
  PCE_EMBEDDING_OWNER_SUBJECT: "synthetic-owner",
  OPENAI_API_KEY: "synthetic",
  OPENAI_PROJECT_ID: "proj_synthetic",
  DATABASE_URL: "synthetic",
};
describe("embedding activation boundary", () => {
  it("requires both enablement and explicit private-text consent", () => {
    for (const flag of [
      "PCE_EMBEDDINGS_ENABLED",
      "PCE_EMBEDDING_EGRESS_APPROVED",
    ])
      for (const value of [undefined, "false", "true-but-not-approved"])
        expect(() => embeddingConfig({ ...env, [flag]: value })).toThrow(
          "egress",
        );
    expect(() => embeddingConfig({})).toThrow("egress");
  });
  it("defaults the model and validates trusted owner/cursor before opening DB", () => {
    expect(embeddingConfig(env).owner).toBe("synthetic-owner");
    expect(embeddingConfig(env, true).owner).toBe("synthetic-owner");
    expect(() =>
      embeddingConfig(
        { ...env, PCE_EMBEDDING_AFTER_NOTE_ID: "valid-cursor" },
        true,
      ),
    ).toThrow("cursor");
    for (const invalid of [
      { OPENAI_EMBEDDING_MODEL: "other-model" },
      { DATABASE_URL: "" },
      { PCE_EMBEDDING_OWNER_SUBJECT: "owner\nforged" },
      { PCE_EMBEDDING_AFTER_NOTE_ID: "not a cursor" },
    ])
      expect(() => embeddingConfig({ ...env, ...invalid })).toThrow();
  });
});
