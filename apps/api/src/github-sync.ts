import type { FastifyInstance } from "fastify";
import {
  GitHubSyncResultSchema,
  GitHubSyncStatusSchema,
  type GitHubSyncResult,
  type GitHubSyncStatus,
} from "@pce/contracts";
import { requireSessionScope, type SessionAuth } from "./session-auth.js";
export interface GitHubSyncService {
  allowedOwner: string;
  status(owner: string): Promise<GitHubSyncStatus>;
  acquire(owner: string): Promise<GitHubSyncResult>;
}
export function registerGitHubSyncRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  service: GitHubSyncService,
) {
  let running = false;
  let nextAllowed = 0;
  app.get(
    "/api/v1/github-sync/status",
    {
      preHandler: (req, reply) =>
        requireSessionScope(req, reply, auth, "notes:read"),
    },
    async (req, reply) => {
      if (req.authenticatedPrincipal!.subject !== service.allowedOwner)
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      if (Object.keys(req.query as object).length)
        return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
      return GitHubSyncStatusSchema.parse(
        await service.status(req.authenticatedPrincipal!.subject),
      );
    },
  );
  app.post(
    "/api/v1/github-sync",
    {
      bodyLimit: 1024,
      preHandler: (req, reply) =>
        requireSessionScope(req, reply, auth, "capture:write"),
    },
    async (req, reply) => {
      const owner = req.authenticatedPrincipal!.subject;
      if (owner !== service.allowedOwner)
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      if (
        (req.body !== undefined &&
          (typeof req.body !== "object" ||
            req.body === null ||
            Array.isArray(req.body) ||
            Object.keys(req.body).length)) ||
        Object.keys(req.query as object).length
      )
        return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
      const status = await service.status(owner);
      if (!status.enabled)
        return reply.code(503).send({ error: { code: "SERVICE_UNAVAILABLE" } });
      if (running || Date.now() < nextAllowed)
        return reply
          .header("Retry-After", "5")
          .code(429)
          .send({ error: { code: "RATE_LIMITED" } });
      running = true;
      nextAllowed = Date.now() + 5000;
      try {
        return GitHubSyncResultSchema.parse(await service.acquire(owner));
      } catch {
        return reply.code(503).send({ error: { code: "SERVICE_UNAVAILABLE" } });
      } finally {
        running = false;
      }
    },
  );
}
