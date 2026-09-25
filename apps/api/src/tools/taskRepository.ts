import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskRecord } from "../domain/businessData.js";

export interface TaskRepository {
  list(workspaceId: string, ownerUserId: string): Promise<TaskRecord[]>;
  save(task: TaskRecord): Promise<void>;
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly records = new Map<string, TaskRecord>();
  async list(workspaceId: string, ownerUserId: string): Promise<TaskRecord[]> {
    return [...this.records.values()].filter((task) => task.workspaceId === workspaceId && task.ownerUserId === ownerUserId).map(clone);
  }
  async save(task: TaskRecord): Promise<void> {
    const workspaceOwner = [...this.records.values()].find((record) => record.workspaceId === task.workspaceId)?.ownerUserId;
    if (workspaceOwner && workspaceOwner !== task.ownerUserId) throw new Error("Task workspace ownership cannot be changed.");
    this.records.set(`${task.workspaceId}:${task.id}`, clone(task));
  }
}

/** File-backed adapter for the MVP. The repository contract is storage-vendor neutral. */
export class JsonTaskRepository implements TaskRepository {
  private readonly directory: string;
  constructor(directory = process.env.TASK_DATA_DIR ?? path.resolve(process.cwd(), "uploads", "tasks")) {
    this.directory = path.resolve(directory);
  }

  async list(workspaceId: string, ownerUserId: string): Promise<TaskRecord[]> {
    const all = await this.readWorkspace(workspaceId);
    return all.filter((task) => task.workspaceId === workspaceId && task.ownerUserId === ownerUserId);
  }

  async save(task: TaskRecord): Promise<void> {
    if (!task.workspaceId || !task.ownerUserId) throw new Error("Task ownership is required.");
    const all = await this.readWorkspace(task.workspaceId);
    if (all.some((record) => record.ownerUserId !== task.ownerUserId)) throw new Error("Task workspace ownership cannot be changed.");
    const index = all.findIndex(({ id }) => id === task.id);
    if (index >= 0 && (all[index]!.workspaceId !== task.workspaceId || all[index]!.ownerUserId !== task.ownerUserId)) {
      throw new Error("Task ownership cannot be changed.");
    }
    if (index >= 0) all[index] = clone(task); else all.push(clone(task));
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(task.workspaceId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(all), { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readWorkspace(workspaceId: string): Promise<TaskRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath(workspaceId), "utf8")) as TaskRecord[];
      if (!Array.isArray(parsed) || parsed.some((task) => task.workspaceId !== workspaceId || typeof task.ownerUserId !== "string")) {
        throw new Error("Task ownership validation failed.");
      }
      return parsed.map(clone);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return [];
      throw new Error("Stored task data could not be read or validated.");
    }
  }

  private filePath(workspaceId: string): string {
    const digest = createHash("sha256").update(workspaceId, "utf8").digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }
}

function clone(task: TaskRecord): TaskRecord { return { ...task }; }

export const taskRepository: TaskRepository = new JsonTaskRepository();
