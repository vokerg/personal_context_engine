import {
  ApiRequestError,
  ApiTransportError,
  changeTask,
  createTask,
  type AuthenticatedRequestOptions,
  type Task,
  type TaskCreate,
  type TaskMutation,
} from "@pce/api-client";

export function taskFailure(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "Session expired. Sign in again.";
    if (error.status === 403)
      return "Reconnect with Task read/write permissions to use this feature.";
    if (error.status === 404)
      return "This Task is unavailable, or Tasks are not enabled on the API.";
    if (error.status === 409)
      return "The Task changed. The list was refreshed; choose a new change.";
  }
  if (error instanceof ApiTransportError && error.code === "TIMEOUT")
    return "Request timed out. Retry the same request to confirm its result.";
  return "Could not reach Tasks. Check your connection and retry.";
}

/** In-memory retry receipts, not an offline queue; never infer actions or dates. */
export class TaskRequests {
  private command: { taskId: string; input: TaskMutation } | null = null;
  private creation: TaskCreate | null = null;
  changing = false;
  creating = false;
  constructor(
    private readonly options: AuthenticatedRequestOptions,
    private readonly id: () => string,
  ) {}
  get pendingTaskId() {
    return this.command?.taskId ?? null;
  }
  get pendingCreation() {
    return this.creation !== null;
  }
  async change(task?: Task) {
    if (this.changing || (this.command && task)) return null;
    if (!this.command && task)
      this.command = {
        taskId: task.taskId,
        input: {
          commandId: this.id(),
          expectedRevision: task.revision,
          status: task.status === "OPEN" ? "COMPLETED" : "OPEN",
        },
      };
    if (!this.command) return null;
    this.changing = true;
    try {
      const result = await changeTask(
        this.options,
        this.command.taskId,
        this.command.input,
      );
      this.command = null;
      return result;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409)
        this.command = null;
      throw error;
    } finally {
      this.changing = false;
    }
  }
  async create(input: { title: string; description?: string }) {
    if (this.creating) return null;
    if (!this.creation)
      this.creation = {
        taskId: this.id(),
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
      };
    this.creating = true;
    try {
      const result = await createTask(this.options, this.creation);
      this.creation = null;
      return result;
    } finally {
      this.creating = false;
    }
  }
}
