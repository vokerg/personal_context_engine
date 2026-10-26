import { describe, expect, it } from "vitest";
import {
  taskVerificationEnvironment,
  validateTaskTestDatabase,
} from "./verify-tasks.mjs";

describe("Task acceptance database boundary", () => {
  it("accepts only explicitly named disposable local databases", () => {
    for (const value of [
      "postgresql://pce_test@127.0.0.1/pce_test?schema=public",
      "postgresql://pce_tasks_test@localhost/pce_tasks_149?host=%2Ftmp%2Fpce-synthetic%2Fsocket",
      "postgres://test@[::1]/pce_tasks_acceptance",
    ])
      expect(validateTaskTestDatabase(value)).toBe(value);
  });
  it.each([
    undefined,
    "garbage",
    "https://localhost/pce_test",
    "postgresql://remote.example/pce_test",
    "postgresql://localhost/production",
    "postgresql://localhost/pce_test?host=remote.example",
    "postgresql://localhost/pce_test?host=%2Ftmp%2F..%2Frun",
    "postgresql://localhost/pce_test?schema=private",
    "postgresql://localhost/pce_test?schema=public&schema=private",
    "postgresql://localhost/pce_test?sslmode=require",
  ])(
    "rejects unsafe or ambiguous input case %# without echoing credentials",
    (value) => {
      expect(() => validateTaskTestDatabase(value)).toThrow(
        "Set PCE_DB_TEST_URL to a disposable loopback",
      );
    },
  );
  it("does not inherit service credentials, runtime gates or a different database", () => {
    const url = "postgresql://localhost/pce_tasks_synthetic";
    expect(
      taskVerificationEnvironment(
        {
          PATH: "/synthetic",
          DATABASE_URL: "private",
          OPENAI_API_KEY: "private",
          GITHUB_TOKEN: "private",
          PCE_TASKS_ENABLED: "true",
          NODE_OPTIONS: "--import=private",
        },
        url,
      ),
    ).toEqual({
      PATH: "/synthetic",
      NODE_ENV: "test",
      DATABASE_URL: url,
      PCE_DB_TEST_URL: url,
    });
  });
});
