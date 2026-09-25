import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CRMLead, validateCRMLeads } from "./crmDomain.js";

export type StoredCRM = {
  workspaceId: string;
  ownerUserId: string;
  sourceName: string;
  importedAt: string;
  leads: CRMLead[];
};

export interface CRMRepository {
  get(workspaceId: string, ownerUserId: string): Promise<StoredCRM | undefined>;
  save(workspaceId: string, crm: StoredCRM): Promise<void>;
}

/** Deterministic repository for tests and services with explicitly process-local storage. */
export class InMemoryCRMRepository implements CRMRepository {
  private readonly workspaces = new Map<string, StoredCRM>();

  async get(workspaceId: string, ownerUserId: string): Promise<StoredCRM | undefined> {
    const value = this.workspaces.get(workspaceId);
    return value?.ownerUserId === ownerUserId ? cloneCRM(value) : undefined;
  }

  async save(workspaceId: string, crm: StoredCRM): Promise<void> {
    if (crm.workspaceId !== workspaceId) throw new Error("CRM workspace does not match the storage key.");
    const existing = this.workspaces.get(workspaceId);
    if (existing && existing.ownerUserId !== crm.ownerUserId) throw new Error("CRM ownership cannot be changed.");
    this.workspaces.set(workspaceId, cloneCRM(crm));
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(workspaceId) || workspaceId.includes("..")) {
    throw new Error("Invalid CRM workspace identifier.");
  }
}

/** Local JSON storage keeps imported workspaces isolated and survives API restarts. */
export class JsonCRMRepository implements CRMRepository {
  private readonly directory: string;

  constructor(directory = process.env.CRM_DATA_DIR ?? path.resolve(process.cwd(), "uploads", "crm")) {
    this.directory = path.resolve(directory);
  }

  async get(workspaceId: string, ownerUserId: string): Promise<StoredCRM | undefined> {
    assertWorkspaceId(workspaceId);
    try {
      const text = await readFile(this.filePath(workspaceId), "utf8");
      const parsed = JSON.parse(text) as Omit<StoredCRM, "leads"> & { leads: Array<Record<string, unknown>> };
      if (parsed.workspaceId !== workspaceId || typeof parsed.ownerUserId !== "string" || !parsed.ownerUserId) {
        throw new Error("Stored CRM ownership validation failed.");
      }
      if (parsed.ownerUserId !== ownerUserId) return undefined;
      const leads = validateCRMLeads(parsed.leads.map((lead) => ({
        ...lead,
        lastContactedAt: new Date(String(lead.lastContactedAt))
      })));
      return { ...parsed, leads };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new Error("Stored CRM data could not be read or validated.");
    }
  }

  async save(workspaceId: string, crm: StoredCRM): Promise<void> {
    assertWorkspaceId(workspaceId);
    if (crm.workspaceId !== workspaceId || !crm.ownerUserId) throw new Error("CRM workspace ownership does not match the storage key.");
    const validated = validateCRMLeads(crm.leads as unknown as Array<Record<string, unknown>>);
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(workspaceId);
    const current = await this.get(workspaceId, crm.ownerUserId);
    if (!current) {
      try {
        const existing = JSON.parse(await readFile(target, "utf8")) as { ownerUserId?: string };
        if (existing.ownerUserId && existing.ownerUserId !== crm.ownerUserId) throw new Error("CRM ownership cannot be changed.");
      } catch (error) {
        if (!isNotFound(error) && error instanceof Error && error.message === "CRM ownership cannot be changed.") throw error;
        if (!isNotFound(error)) throw error;
      }
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...crm, leads: validated }), { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private filePath(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    const storageKey = createHash("sha256").update(workspaceId, "utf8").digest("hex");
    return path.join(this.directory, `${storageKey}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function cloneCRM(crm: StoredCRM): StoredCRM {
  return {
    ...crm,
    leads: crm.leads.map((lead) => ({ ...lead, lastContactedAt: new Date(lead.lastContactedAt), notes: [...lead.notes] }))
  };
}

export const crmRepository: CRMRepository = new JsonCRMRepository();
