import { describe, expect, it } from "vitest";
import { McpCaptureRequestSchema, TextCaptureRequestSchema } from "./index.js";

describe("plain-text MCP capture contract", () => {
  it("needs only original text and a retry key, preserving literal whitespace", () => {
    const input = {
      idempotencyKey: "fixture-1",
      text: "\nПривет\r\n## Original input\n  ",
    };
    expect(McpCaptureRequestSchema.parse(input)).toEqual(input);
    expect(TextCaptureRequestSchema.parse(input)).toEqual(input);
    expect(
      TextCaptureRequestSchema.parse({
        idempotencyKey: "bom",
        text: "\ufeffLiteral source",
      }).text,
    ).toBe("\ufeffLiteral source");
    expect(
      McpCaptureRequestSchema.parse({
        idempotencyKey: "legacy",
        notes: ["legacy document"],
      }).notes,
    ).toHaveLength(1);
  });
  it.each([
    {},
    { text: " " },
    { text: "\0" },
    { text: "\ud800" },
    { text: "ы".repeat(60001) },
    { text: "text", title: "two\nlines" },
    { text: "text", summary: "two\nlines" },
    { text: "text", kind: "research" },
    { text: "text", source: "import" },
    { text: "text", tags: ["Not a slug"] },
    { text: "text", ownerSubject: "forged" },
    { text: "text", capturedAt: "invented" },
    { text: "text", notes: ["also legacy"] },
    { notes: ["legacy"], title: "mixed" },
  ])(
    "rejects invalid or ambiguous input without relaxing the legacy format: %j",
    (fields) => {
      expect(
        McpCaptureRequestSchema.safeParse({
          idempotencyKey: "fixture",
          ...fields,
        }).success,
      ).toBe(false);
    },
  );
});
