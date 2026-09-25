import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type CalendarConnection = {
  workspaceId: string;
  userId: string;
  encryptedRefreshToken: string;
  connectedAt: string;
};

export interface CalendarConnectionRepository {
  get(workspaceId: string, userId: string): Promise<CalendarConnection | undefined>;
  save(connection: CalendarConnection): Promise<void>;
  delete(workspaceId: string, userId: string): Promise<void>;
}

export class InMemoryCalendarConnectionRepository implements CalendarConnectionRepository {
  private readonly connections = new Map<string, CalendarConnection>();
  async get(workspaceId: string, userId: string): Promise<CalendarConnection | undefined> {
    const value = this.connections.get(key(workspaceId, userId));
    return value ? { ...value } : undefined;
  }
  async save(connection: CalendarConnection): Promise<void> {
    this.connections.set(key(connection.workspaceId, connection.userId), { ...connection });
  }
  async delete(workspaceId: string, userId: string): Promise<void> { this.connections.delete(key(workspaceId, userId)); }
}

export class JsonCalendarConnectionRepository implements CalendarConnectionRepository {
  constructor(private readonly directory = process.env.CALENDAR_DATA_DIR ?? path.resolve(process.cwd(), "uploads", "calendar")) {}
  async get(workspaceId: string, userId: string): Promise<CalendarConnection | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath(workspaceId, userId), "utf8")) as CalendarConnection;
      if (parsed.workspaceId !== workspaceId || parsed.userId !== userId) throw new Error("Calendar connection ownership mismatch.");
      return parsed;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return undefined;
      throw new Error("Calendar connection data could not be read or validated.");
    }
  }
  async save(connection: CalendarConnection): Promise<void> {
    if (!connection.workspaceId || !connection.userId) throw new Error("Calendar connection ownership is required.");
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(connection.workspaceId, connection.userId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(connection), { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  async delete(workspaceId: string, userId: string): Promise<void> {
    await rm(this.filePath(workspaceId, userId), { force: true });
  }
  private filePath(workspaceId: string, userId: string): string {
    const digest = createHash("sha256").update(`${workspaceId}\0${userId}`, "utf8").digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }
}

function key(workspaceId: string, userId: string): string { return `${workspaceId}\0${userId}`; }

export const calendarConnectionRepository: CalendarConnectionRepository = new JsonCalendarConnectionRepository();
