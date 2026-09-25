import React from "react";
import { Activity, CheckCircle2, AlertCircle, Clock, Shield, Wrench, ChevronRight } from "lucide-react";
import { useAgentStore } from "../store/useAgentStore.js";
import { RiskLevel, StepStatus } from "@nexusops/shared-types";

export const AgentTimeline: React.FC = () => {
  const currentState = useAgentStore(s => s.currentState);
  const rawPrompt = useAgentStore(s => s.rawPrompt);
  const timeline = useAgentStore(s => s.timeline);
  const planSteps = useAgentStore(s => s.planSteps);

  const getRiskBadge = (risk: RiskLevel) => {
    switch (risk) {
      case RiskLevel.HIGH:
        return "bg-rose-500/20 text-rose-300 border-rose-500/30";
      case RiskLevel.MEDIUM:
        return "bg-amber-500/20 text-amber-300 border-amber-500/30";
      default:
        return "bg-slate-800 text-slate-300 border-slate-700";
    }
  };

  const getStepStatusBadge = (status: StepStatus) => {
    switch (status) {
      case StepStatus.COMPLETED:
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case StepStatus.EXECUTING:
        return "bg-indigo-500/20 text-indigo-300 border-indigo-500/30 animate-pulse";
      case StepStatus.APPROVED:
        return "bg-blue-500/20 text-blue-300 border-blue-500/30";
      case StepStatus.SKIPPED:
        return "bg-slate-800 text-slate-400 border-slate-700";
      default:
        return "bg-amber-500/20 text-amber-300 border-amber-500/30";
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Current Goal Box */}
      {rawPrompt && (
        <div className="glass-card p-5 rounded-2xl border border-indigo-500/20 bg-indigo-950/20">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2">
              <Activity className="h-4 w-4 text-indigo-400" />
              <span className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Active Execution Goal</span>
            </div>
            <span className="text-xs font-mono font-medium px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              {currentState}
            </span>
          </div>
          <p className="text-sm font-semibold text-white">{rawPrompt}</p>
        </div>
      )}

      {/* Structured Multi-Step Action Plan */}
      {planSteps.length > 0 && (
        <div className="glass-card p-6 rounded-2xl border border-white/10">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/10">
            <div className="flex items-center space-x-2">
              <Wrench className="h-5 w-5 text-indigo-400" />
              <h3 className="text-base font-bold text-white">Generated Action Plan</h3>
            </div>
            <span className="text-xs text-slate-400">{planSteps.length} Steps Formulated</span>
          </div>

          <div className="space-y-3">
            {planSteps.map((step) => (
              <div
                key={step.id}
                className={`p-4 rounded-xl border transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                  step.status === StepStatus.EXECUTING
                    ? "bg-indigo-900/30 border-indigo-500/50 glow-purple"
                    : "bg-slate-900/50 border-white/5 hover:border-white/10"
                }`}
              >
                <div className="flex items-start space-x-3">
                  <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-slate-800 text-xs font-bold text-indigo-400 border border-slate-700">
                    {step.stepNumber}
                  </span>
                  <div>
                    <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                      <span className="text-sm font-bold text-slate-100 uppercase tracking-wider">
                        [{step.tool}] {step.action}
                      </span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${getRiskBadge(step.riskLevel)}`}>
                        {step.riskLevel} RISK
                      </span>
                      {step.requiresApproval && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center space-x-1">
                          <Shield className="h-3 w-3" />
                          <span>Requires Approval</span>
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{step.reasoning}</p>
                    <div className="text-[11px] font-mono text-slate-500 mt-1">
                      params: {JSON.stringify(step.params)}
                    </div>
                  </div>
                </div>

                <div className="flex items-center space-x-2 self-end md:self-center">
                  <span className={`text-xs font-semibold px-3 py-1 rounded-lg border ${getStepStatusBadge(step.status)}`}>
                    {step.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Real-time Agent Event Feed */}
      <div className="glass-card p-6 rounded-2xl border border-white/10">
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/10">
          <div className="flex items-center space-x-2">
            <Clock className="h-5 w-5 text-purple-400" />
            <h3 className="text-base font-bold text-white">Live Execution Timeline</h3>
          </div>
          <span className="text-xs text-slate-400">{timeline.length} Events Logged</span>
        </div>

        {timeline.length === 0 ? (
          <div className="text-center py-8 text-slate-500 text-sm">
            No agent run currently active. Click "New Business Goal" to start.
          </div>
        ) : (
          <div className="space-y-4 relative before:absolute before:inset-0 before:left-3.5 before:w-0.5 before:bg-slate-800">
            {timeline.map((event) => (
              <div key={event.id} className="relative flex items-start space-x-4 pl-8">
                <div className="absolute left-1 top-1 h-5 w-5 rounded-full bg-slate-900 border-2 border-indigo-500 flex items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                </div>
                <div className="flex-1 p-3.5 rounded-xl bg-slate-900/60 border border-white/5 text-xs">
                  <div className="flex items-center justify-between text-slate-400 mb-1">
                    <span className="font-semibold text-indigo-300">{event.title}</span>
                    <span className="font-mono text-[10px] text-slate-500">{event.timestamp}</span>
                  </div>
                  {event.details && <p className="text-slate-300 font-sans">{event.details}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
};
