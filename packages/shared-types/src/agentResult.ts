import { z } from "zod";

export const EvidenceStatusSchema = z.enum([
  "SUPPORTED",
  "NOT_FOUND",
  "INSUFFICIENT_EVIDENCE",
  "AMBIGUOUS",
  "CONFLICTING",
  "SOURCE_UNAVAILABLE",
  "INTEGRATION_NOT_CONNECTED",
  "AUTHORIZATION_DENIED",
  "TOOL_FAILURE"
]);

export const GroundedClaimSchema = z.object({
  claimId: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(["supported", "unsupported", "uncertain"])
}).strict();

export const GroundedRecommendationSchema = z.object({
  statement: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  expectedOutcome: z.string().trim().min(1).max(500)
}).strict();

export const EvidenceSourceCoverageSchema = z.object({
  source: z.enum(["crm", "gmail", "calendar", "analytics", "tasks"]),
  status: EvidenceStatusSchema,
  retrievalStatus: z.enum(["RETRIEVED", "NO_MATCH", "NOT_ATTEMPTED", "FAILED"]),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(500)
}).strict();

export const EvidenceConflictSchema = z.object({
  field: z.string().trim().min(1).max(80),
  values: z.array(z.object({
    source: z.enum(["crm", "gmail", "calendar", "analytics", "tasks"]),
    value: z.string().trim().min(1).max(200),
    evidenceRef: z.string().trim().min(1).max(200)
  }).strict()).min(2).max(10)
}).strict();

export const EvidenceBundleSchema = z.object({
  sufficiency: EvidenceStatusSchema,
  items: z.array(z.object({
    evidenceRef: z.string().trim().min(1).max(200),
    source: z.enum(["crm", "gmail", "calendar", "analytics", "tasks"]),
    statement: z.string().trim().min(1).max(1_000),
    recordRefs: z.array(z.string().trim().min(1).max(200)).max(500),
    resolvedEntityRefs: z.array(z.string().trim().min(1).max(200)).max(500),
    matchingCriteria: z.array(z.string().trim().min(1).max(200)).max(20),
    timestamp: z.string().datetime().optional(),
    sourceMatches: z.array(z.object({
      source: z.enum(["crm", "gmail", "calendar"]),
      recordRef: z.string().trim().min(1).max(200),
      resolvedEntityRef: z.string().trim().min(1).max(200).optional(),
      matchedBy: z.string().trim().min(1).max(100),
      confidence: z.number().min(0).max(1),
      timestamp: z.string().datetime().optional(),
      summary: z.string().trim().min(1).max(500),
      relevantFields: z.record(z.union([z.string().max(200), z.number().finite(), z.boolean()])).optional()
    }).strict()).max(500)
  }).strict()).max(500),
  resolvedEntities: z.array(z.object({
    entityRef: z.string().trim().min(1).max(200),
    type: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200).optional(),
    company: z.string().trim().min(1).max(200).optional()
  }).strict()).max(500),
  sourceCoverage: z.array(EvidenceSourceCoverageSchema).max(5),
  conflicts: z.array(EvidenceConflictSchema).max(20),
  limitations: z.array(z.string().trim().min(1).max(500)).max(50)
}).strict();

export const GroundedAnswerSchema = z.object({
  status: EvidenceStatusSchema,
  answer: z.string().trim().min(1).max(5_000),
  claims: z.array(GroundedClaimSchema).max(50),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(100),
  limitations: z.array(z.string().trim().min(1).max(500)).max(50),
  confidence: z.number().min(0).max(1).optional(),
  recommendedNextStep: z.object({
    text: z.string().trim().min(1).max(500),
    evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(20)
  }).strict().optional(),
  recommendations: z.array(GroundedRecommendationSchema).max(20)
}).strict();

export const ActionProposalSchema = z.object({
  id: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(200),
  goalId: z.string().trim().min(1).max(200),
  stepId: z.string().trim().min(1).max(200),
  actionType: z.string().trim().min(1).max(120),
  tool: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(80),
  target: z.object({
    description: z.string().trim().min(1).max(300),
    identityRef: z.string().trim().min(1).max(200).optional()
  }).strict().optional(),
  params: z.record(z.unknown()),
  rationale: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(20),
  expectedOutcome: z.string().trim().min(1).max(500),
  requiredPermissions: z.array(z.string().trim().min(1).max(100)).max(10),
  approvalRequired: z.literal(true),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  paramsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  riskLevel: z.string().trim().min(1).max(50),
  approvalStatus: z.string().trim().min(1).max(50),
  lifecycle: z.enum([
    "PROPOSED", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "EXECUTED", "COMPLETED",
    "FAILED", "REJECTED", "EXPIRED", "VERIFYING", "VERIFIED", "VERIFICATION_FAILED"
  ]),
  proposedAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decidedById: z.string().trim().min(1).max(200).optional(),
  feedback: z.string().max(1_000).optional(),
  result: z.object({
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    metadata: z.record(z.unknown()).optional()
  }).strict().optional(),
  verification: z.enum(["PENDING", "VERIFIED", "FAILED"]).optional()
}).strict();

export const AgentCRMRecordSchema = z.object({
  recordRef: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  dealValue: z.number().finite().nonnegative().optional(),
  status: z.string().trim().min(1).max(100).optional(),
  lastContactedAt: z.string().datetime().optional()
}).strict();

export const AgentCRMRecordsResultSchema = z.object({
  resultType: z.literal("crm_records"),
  source: z.literal("crm"),
  title: z.string().trim().min(1).max(100),
  count: z.number().int().nonnegative(),
  records: z.array(AgentCRMRecordSchema).max(500),
  omittedCount: z.number().int().nonnegative(),
  truncatedCount: z.number().int().nonnegative(),
  matchingCriteria: z.array(z.string().trim().min(1).max(120)).max(10)
}).strict().superRefine((result, context) => {
  if (result.count !== result.records.length + result.omittedCount + result.truncatedCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["count"],
      message: "Count must equal displayed, invalid, and truncated records."
    });
  }
});

export type AgentCRMRecord = z.infer<typeof AgentCRMRecordSchema>;
export type AgentCRMRecordsResult = z.infer<typeof AgentCRMRecordsResultSchema>;
export type AgentStructuredResult = AgentCRMRecordsResult;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type GroundedClaim = z.infer<typeof GroundedClaimSchema>;
export type GroundedRecommendation = z.infer<typeof GroundedRecommendationSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export type GroundedAnswer = z.infer<typeof GroundedAnswerSchema>;
export type AgentActionProposal = z.infer<typeof ActionProposalSchema>;
