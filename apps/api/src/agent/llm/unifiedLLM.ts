import { ParsedGoal, PlanStep } from "@nexusops/shared-types";
import { z } from "zod";
import { AGENT_INTEGRITY_INSTRUCTIONS } from "../policies/dataIntegrity.js";

export interface ILLMProvider {
  parseGoal(prompt: string): Promise<ParsedGoal>;
  generatePlan(parsedGoal: ParsedGoal, observationData: Record<string, unknown>, instructions: string): Promise<Omit<PlanStep, "status">[]>;
}

/** Deterministic placeholder adapter. It parses only the supplied goal and never invents actions or records. */
export class MockLLMProvider implements ILLMProvider {
  async parseGoal(prompt: string): Promise<ParsedGoal> {
    const objective = z.string().trim().min(1).parse(prompt);
    const dayMatch = objective.match(/\b(\d+)\s+days?\b/i);
    const timeWindowDays = dayMatch ? Number(dayMatch[1]) : 30;
    return {
      objective,
      timeWindowDays,
      constraints: [],
      successCriteria: []
    };
  }

  async generatePlan(_parsedGoal: ParsedGoal, _observationData: Record<string, unknown>, _instructions: string): Promise<Omit<PlanStep, "status">[]> {
    if (_instructions !== AGENT_INTEGRITY_INSTRUCTIONS) throw new Error("Required agent integrity instructions are missing.");
    throw new Error("No planning model is configured. No plan or business actions were generated.");
  }
}

export function getLLMProvider(): ILLMProvider {
  return new MockLLMProvider();
}
