import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type EmailConnectionHealth = "verified" | "reauthorization_required" | "access_denied" | "unavailable";
export type EmailConnection = { workspaceId: string; userId: string; encryptedRefreshToken: string; connectedAt: string; tokenVersion?: string; health?: EmailConnectionHealth };
export interface EmailConnectionRepository {
  get(workspaceId: string, userId: string): Promise<EmailConnection | undefined>;
  save(connection: EmailConnection): Promise<void>;
  delete(workspaceId: string, userId: string): Promise<void>;
}

export class InMemoryEmailConnectionRepository implements EmailConnectionRepository {
  private values = new Map<string, EmailConnection>();
  async get(workspaceId: string, userId: string) { const value = this.values.get(key(workspaceId, userId)); return value ? { ...value } : undefined; }
  async save(value: EmailConnection) { this.values.set(key(value.workspaceId, value.userId), { ...value }); }
  async delete(workspaceId: string, userId: string) { this.values.delete(key(workspaceId, userId)); }
}

export class JsonEmailConnectionRepository implements EmailConnectionRepository {
  constructor(private readonly directory = process.env.GMAIL_DATA_DIR ?? path.resolve(process.cwd(), "uploads", "gmail")) {}
  async get(workspaceId: string, userId: string): Promise<EmailConnection | undefined> {
    try {
      const connection = JSON.parse(await readFile(this.filePath(workspaceId, userId), "utf8")) as EmailConnection;
      if (connection.workspaceId !== workspaceId || connection.userId !== userId) throw new Error("Gmail connection ownership mismatch.");
      return connection;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as {code?: string}).code === "ENOENT") return undefined;
      throw new Error("Gmail connection data could not be read or validated.");
    }
  }
  async save(connection: EmailConnection): Promise<void> {
    if (!connection.workspaceId || !connection.userId) throw new Error("Gmail connection ownership is required.");
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(connection.workspaceId, connection.userId);
    const temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(connection), { encoding: "utf8", flag: "wx" }); await rename(temp, target); }
    catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
  async delete(workspaceId: string, userId: string) { await rm(this.filePath(workspaceId, userId), { force: true }); }
  private filePath(workspaceId: string, userId: string) {
    return path.join(this.directory, `${createHash("sha256").update(`${workspaceId}\0${userId}`).digest("hex")}.json`);
  }
}
function key(workspaceId: string, userId: string) { return `${workspaceId}\0${userId}`; }
export const emailConnectionRepository: EmailConnectionRepository = new JsonEmailConnectionRepository();
