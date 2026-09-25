import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { CRMLead, DEFAULT_MIN_DEAL_VALUE, getActiveHighValueLeads, getInactiveHighValueLeads, validateCRMLeads } from "./crmDomain.js";
import { emailAddress, nonEmpty, nonNegativeNumber, runValidated, ToolDomainError } from "./contract.js";
import { CRMRepository, crmRepository } from "./crmRepository.js";

export type CRMToolOptions = { clock?: () => Date; repository?: CRMRepository };
const cloneLead = (lead: CRMLead): CRMLead => ({ ...lead, lastContactedAt: new Date(lead.lastContactedAt), notes: [...lead.notes] });
const activeSchema = z.object({ minDealValue: nonNegativeNumber }).strict();
const inactiveSchema = z.object({ minDaysInactive: nonNegativeNumber.default(30), minDealValue: nonNegativeNumber.default(DEFAULT_MIN_DEAL_VALUE) }).strict();
const searchSchema = z.object({ query: z.string().trim().optional(), status: z.string().trim().min(1).optional() }).strict();
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

  setLeads(rows: readonly Record<string, unknown>[], workspaceId: string): void {
    if (!workspaceId.trim()) throw new Error("A workspace is required to seed development CRM data.");
    this.fallbackByWorkspace.set(workspaceId, validateCRMLeads(rows));
  }

  listActiveHighValueLeads(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<CRMLead[]>> {
    return runValidated(activeSchema, params, context, async ({ minDealValue }) => getActiveHighValueLeads(await this.leadsFor(context), minDealValue).map(cloneLead));
  }

  listInactiveLeads(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<CRMLead[]>> {
    return runValidated(inactiveSchema, params, context, async ({ minDealValue, minDaysInactive }) =>
      getInactiveHighValueLeads(await this.leadsFor(context), minDealValue ?? DEFAULT_MIN_DEAL_VALUE, minDaysInactive ?? 30, this.clock()).map(cloneLead));
  }

  searchLeads(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<CRMLead[]>> {
    return runValidated(searchSchema, params, context, async ({ query, status }) => {
      const needle = (query ?? "").toLocaleLowerCase("en-US");
      return (await this.leadsFor(context)).filter((lead) =>
        (!status || lead.status?.toLocaleLowerCase("en-US") === status.toLocaleLowerCase("en-US")) &&
        (!needle || [lead.name, lead.company, lead.email].some((value) => value.toLocaleLowerCase("en-US").includes(needle)))
      ).map(cloneLead);
    });
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
    return (this.fallbackByWorkspace.get(context.orgId) ?? []).map(cloneLead);
  }

  private async saveLeads(workspaceId: string, ownerUserId: string, leads: CRMLead[]): Promise<void> {
    const stored = await this.repository.get(workspaceId, ownerUserId);
    if (stored) await this.repository.save(workspaceId, { ...stored, leads });
    else this.fallbackByWorkspace.set(workspaceId, leads.map(cloneLead));
  }
}

export const CRMTool = new CRMToolService();
