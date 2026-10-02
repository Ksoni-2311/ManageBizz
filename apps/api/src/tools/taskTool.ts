import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { nonEmpty, requireApprovedAction, runValidated, ToolDomainError } from "./contract.js";
import { TaskRepository, taskRepository } from "./taskRepository.js";

const priorities = ["LOW", "MEDIUM", "HIGH"] as const;
const statuses = ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
const createSchema = z.object({ title: nonEmpty, leadId: nonEmpty.optional(), priority: z.enum(priorities).default("MEDIUM") }).strict();
const completeSchema = z.object({ taskId: nonEmpty }).strict();
const listSchema = z.object({ leadId: nonEmpty.optional() }).strict();
export type Task = { id: string; workspaceId: string; ownerUserId: string; title: string; leadId?: string; priority: typeof priorities[number]; status: typeof statuses[number] };

/** Task service preserves the tool contract while delegating persistence and ownership checks to its repository. */
export class TaskToolService {
  constructor(private readonly repository: TaskRepository = taskRepository) {}

  createTask(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<{ task: Task; created: true }>> {
    return runValidated(createSchema, params, context, async ({ title, leadId, priority }) => {
      requireApprovedAction(context);
      const id = `task-${context.actionId}`;
      const tasks = await this.repository.list(context.orgId, context.userId);
      const existing = tasks.find((task) => task.id === id);
      if (existing) {
        if (existing.title !== title || existing.leadId !== leadId || existing.priority !== (priority ?? "MEDIUM") || existing.status !== "OPEN") {
          throw new ToolDomainError("ACTION_ID_CONFLICT", "The task action ID is already associated with different task details.");
        }
        return { task: { ...existing }, created: true as const };
      }
      const task: Task = { id, workspaceId: context.orgId, ownerUserId: context.userId, title, ...(leadId ? { leadId } : {}), priority: priority ?? "MEDIUM", status: "OPEN" };
      await this.repository.save(task);
      // Read the persisted record back before returning success. A proposal or
      // successful write call alone is not evidence that the task now exists.
      const verified = (await this.repository.list(context.orgId, context.userId)).find((item) =>
        item.id === task.id && item.workspaceId === context.orgId && item.ownerUserId === context.userId &&
        item.title === task.title && item.leadId === task.leadId && item.status === "OPEN"
      );
      if (!verified) throw new ToolDomainError("VERIFICATION_FAILED", "The task was saved but could not be read back and verified.");
      return { task: { ...verified }, created: true as const };
    });
  }

  completeTask(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<{ task: Task; updated: true }>> {
    return runValidated(completeSchema, params, context, async ({ taskId }) => {
      requireApprovedAction(context);
      const current = (await this.repository.list(context.orgId, context.userId)).find((task) => task.id === taskId);
      if (!current) throw new ToolDomainError("NOT_FOUND", `Task '${taskId}' was not found.`);
      const task = { ...current, status: "COMPLETED" as const };
      await this.repository.save(task);
      return { task: { ...task }, updated: true as const };
    });
  }

  listOpenTasks(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Task[]>> {
    return runValidated(listSchema, params, context, async ({ leadId }) => (await this.repository.list(context.orgId, context.userId))
      .filter((task) => task.status === "OPEN" && (!leadId || task.leadId === leadId))
      .map((task) => ({ ...task })));
  }
}

export const TaskTool = new TaskToolService();
