import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { CRMLead, DEFAULT_MIN_DEAL_VALUE, getActiveHighValueLeads, getInactiveHighValueLeads, resolveCRMContact, validateCRMLeads } from "./crmDomain.js";
import { emailAddress, nonEmpty, nonNegativeNumber, runValidated, ToolDomainError } from "./contract.js";
import { CRMRepository, crmRepository } from "./crmRepository.js";

export type CRMToolOptions = { clock?: () => Date; repository?: CRMRepository };
const cloneLead = (lead: CRMLead): CRMLead => ({ ...lead, lastContactedAt: new Date(lead.lastContactedAt), notes: [...lead.notes] });
const activeSchema = z.object({ minDealValue: nonNegativeNumber }).strict();
const inactiveSchema = z.object({ minDaysInactive: nonNegativeNumber.default(30), minDealValue: nonNegativeNumber.default(DEFAULT_MIN_DEAL_VALUE) }).strict();
const searchSchema = z.object({ query: z.string().trim().max(200).optional(), status: z.string().trim().min(1).optional(), minDealValue: nonNegativeNumber.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict();
const resolveSchema = z.object({ query: z.string().trim().min(1).max(200), company: z.string().trim().min(1).max(200).optional() }).strict();
const updateSchema = z.object({ leadId: nonEmpty, status: nonEmpty.optional(), dealValue: nonNegativeNumber.optional() }).strict();
const noteSchema = z.object({ leadId: nonEmpty, note: nonEmpty }).strict();

export class CRMToolService {
  /** Explicitly seeded development/test data is partitioned by workspace and never used by the production singleton. */
  private readonly fallbackByWorkspace = new Map<string, CRMLead[]>();
  private readonly clock: () => Date;
  private readonly repository: CRMRepository;
  constructor(options: CRMToolOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.repository = options.repository ?? crmRepository;
  }

  setLeads(rows: readonly Record<string, unknown>[], workspaceId: string, ownerUserId: string): void {
    if (!workspaceId.trim() || !ownerUserId.trim()) throw new Error("A workspace and owner are required to seed development CRM data.");
    this.fallbackByWorkspace.set(fallbackKey(workspaceId, ownerUserId), validateCRMLeads(rows));
  }

  listActiveHighValueLeads(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<CRMLead[]>> {
    return runValidated(activeSchema, params, context, async ({ minDealValue }) => getActiveHighValueLeads(await this.leadsFor(context), minDealValue).map(cloneLead));
  }

  listInactiveLeads(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<CRMLead[]>> {
    return runValidated(inactiveSchema, params, context, async ({ minDealValue, minDaysInactive }) =>
      getInactiveHighValueLeads(await this.leadsFor(context), minDealValue ?? DEFAULT_MIN_DEAL_VALUE, minDaysInactive ?? 30, this.clock()).map(cloneLead));
  }

  searchLeads(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<CRMLead[]>> {
    return runValidated(searchSchema, params, context, async ({ query, status, minDealValue, limit }) => {
      const needle = (query ?? "").toLocaleLowerCase("en-US");
      const matches = (await this.leadsFor(context)).filter((lead) =>
        (!status || lead.status?.toLocaleLowerCase("en-US") === status.toLocaleLowerCase("en-US")) &&
        (minDealValue === undefined || lead.dealValue >= minDealValue) &&
        (!needle || [lead.name, lead.company, lead.email].some((value) => value.toLocaleLowerCase("en-US").includes(needle)))
      );
      const score = (lead: CRMLead): number => {
        if (!needle) return 0;
        if (lead.email.toLocaleLowerCase("en-US") === needle) return 5;
        if (lead.name.toLocaleLowerCase("en-US") === needle) return 4;
        if (lead.company.toLocaleLowerCase("en-US") === needle) return 3;
        if (lead.name.toLocaleLowerCase("en-US").startsWith(needle)) return 2;
        return 1;
      };
      return matches.sort((left, right) => !needle ? 0 : score(right) - score(left) ||
        left.name.localeCompare(right.name, "en-US") || left.id.localeCompare(right.id, "en-US"))
        .slice(0, limit).map(cloneLead);
    });
  }

  resolveContact(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<ReturnType<typeof resolveCRMContact>>> {
    return runValidated(resolveSchema, params, context, async ({ query, company }) =>
      resolveCRMContact(await this.leadsFor(context), { query, ...(company ? { company } : {}) }));
  }

  updateLead(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<{ lead: CRMLead; updated: true }>> {
    return runValidated(updateSchema, params, context, async ({ leadId, status, dealValue }) => {
      const leads = await this.leadsFor(context);
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) throw new ToolDomainError("NOT_FOUND", `Lead '${leadId}' was not found.`);
      const updated = { ...lead, ...(status === undefined ? {} : { status }), ...(dealValue === undefined ? {} : { dealValue }) };
      await this.saveLeads(context.orgId, context.userId, leads.map((item) => item.id === leadId ? updated : item));
      return { lead: { ...updated, lastContactedAt: new Date(updated.lastContactedAt), notes: [...updated.notes] }, updated: true as const };
    });
  }

  addLeadNote(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<{ leadId: string; noteCount: number }>> {
    return runValidated(noteSchema, params, context, async ({ leadId, note }) => {
      const leads = await this.leadsFor(context);
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) throw new ToolDomainError("NOT_FOUND", `Lead '${leadId}' was not found.`);
      const updated = { ...lead, notes: [...lead.notes, note] };
      await this.saveLeads(context.orgId, context.userId, leads.map((item) => item.id === leadId ? updated : item));
      return { leadId, noteCount: updated.notes.length };
    });
  }

  private async leadsFor(context: ToolExecutionContext): Promise<CRMLead[]> {
    const stored = await this.repository.get(context.orgId, context.userId);
    if (stored) return stored.leads;
    return (this.fallbackByWorkspace.get(fallbackKey(context.orgId, context.userId)) ?? []).map(cloneLead);
  }

  private async saveLeads(workspaceId: string, ownerUserId: string, leads: CRMLead[]): Promise<void> {
    const stored = await this.repository.get(workspaceId, ownerUserId);
    if (stored) await this.repository.save(workspaceId, { ...stored, leads });
    else this.fallbackByWorkspace.set(fallbackKey(workspaceId, ownerUserId), leads.map(cloneLead));
  }
}

export const CRMTool = new CRMToolService();

function fallbackKey(workspaceId: string, ownerUserId: string): string {
  return `${workspaceId}\0${ownerUserId}`;
}
