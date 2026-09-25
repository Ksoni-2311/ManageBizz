import { RiskLevel } from "@nexusops/shared-types";

export class PolicyEngine {
  /**
   * Classify risk level of proposed action according to NexusOps Safety Guidelines
   */
  static classifyRisk(tool: string, action: string, params: Record<string, unknown>): RiskLevel {
    // HIGH RISK: Sending external email, bulk actions, deletions
    if (tool === "email" && action === "sendEmail") {
      return RiskLevel.HIGH;
    }
    if (action.toLowerCase().includes("delete") || action.toLowerCase().includes("purge")) {
      return RiskLevel.HIGH;
    }
    if (params.bulk === true) {
      return RiskLevel.HIGH;
    }

    // MEDIUM RISK: Updating CRM lead info, creating external calendar meetings
    if (tool === "crm" && action === "updateLead") {
      return RiskLevel.MEDIUM;
    }
    if (tool === "calendar" && action === "createMeeting") {
      return RiskLevel.MEDIUM;
    }
    if (tool === "tasks" && (action === "createTask" || action === "completeTask")) {
      return RiskLevel.MEDIUM;
    }

    // LOW RISK: Read-only CRM/Analytics queries, drafting emails, listing tasks
    return RiskLevel.LOW;
  }

  /**
   * Determine if human approval is required for a step
   */
  static requiresApproval(riskLevel: RiskLevel): boolean {
    return riskLevel !== RiskLevel.LOW;
  }
}
