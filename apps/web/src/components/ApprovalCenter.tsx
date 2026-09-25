import React, { useState } from "react";
import { ShieldAlert, Check, X, Edit3, AlertTriangle, Mail, Send, AlertOctagon } from "lucide-react";
import { useAgentStore } from "../store/useAgentStore.js";
import { submitApprovalApi } from "../services/api.js";

export const ApprovalCenter: React.FC = () => {
  const pendingApprovals = useAgentStore(s => s.pendingApprovals);
  const activeRunId = useAgentStore(s => s.activeRunId);
  const resolveApproval = useAgentStore(s => s.resolveApproval);
  
  const [modifyingId, setModifyingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);

  if (pendingApprovals.length === 0) return null;

  const handleDecision = async (approvalId: string, stepId: string, decision: "APPROVE" | "REJECT" | "MODIFY") => {
    setLoading(true);
    try {
      if (activeRunId) {
        await submitApprovalApi(approvalId, activeRunId, stepId, decision, feedback);
      }
      resolveApproval(approvalId, decision);
      setModifyingId(null);
      setFeedback("");
    } catch (err) {
      console.error("Failed to submit approval decision:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-card p-6 rounded-2xl border-2 border-amber-500/40 bg-amber-950/20 glow-amber mb-8 animate-in slide-in-from-top-4 duration-300">
      
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-amber-500/30 mb-6">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40">
            <ShieldAlert className="h-6 w-6 animate-pulse" />
          </div>
          <div>
            <h3 className="text-lg font-extrabold text-white flex items-center space-x-2">
              <span>Human Approval Required</span>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-rose-500/30 text-rose-300 border border-rose-500/40 uppercase font-mono">
                High Risk Action Blocked
              </span>
            </h3>
            <p className="text-xs text-amber-200/70">
              NexusOps Safety Policy Engine paused execution to prevent unauthorized external action.
            </p>
          </div>
        </div>
      </div>

      {/* Pending Approvals List */}
      <div className="space-y-6">
        {pendingApprovals.map((approval) => (
          <div
            key={approval.id}
            className="p-5 rounded-2xl bg-slate-900/90 border border-white/10 space-y-4 shadow-xl"
          >
            {/* Tool & Action Bar */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center space-x-2">
                <span className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                  <Mail className="h-4 w-4" />
                </span>
                <span className="text-sm font-bold text-white uppercase tracking-wider">
                  [{approval.tool}] {approval.action}
                </span>
              </div>
              <span className="text-xs font-mono px-3 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 font-semibold">
                RISK LEVEL: HIGH
              </span>
            </div>

            {/* Rationale & Rationale details */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-white/5 space-y-2 text-xs">
              <div className="flex items-center space-x-2 text-amber-300 font-semibold">
                <AlertTriangle className="h-4 w-4" />
                <span>Action Rationale:</span>
              </div>
              <p className="text-slate-300 pl-6">{approval.reason}</p>
            </div>

            {/* Target & Content Preview */}
            <div className="p-4 rounded-xl bg-indigo-950/30 border border-indigo-500/20 text-xs space-y-2">
              <span className="font-semibold text-indigo-300 uppercase tracking-wider text-[10px]">Action Payload Preview:</span>
              <div className="font-mono text-slate-300 bg-slate-950/80 p-3 rounded-lg border border-white/5 overflow-x-auto">
                {JSON.stringify(approval.params, null, 2)}
              </div>
            </div>

            {/* Modify Feedback Box */}
            {modifyingId === approval.id && (
              <div className="space-y-2 pt-2">
                <label className="block text-xs font-medium text-slate-300">
                  Provide Modification Instructions for Agent Re-planning:
                </label>
                <textarea
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                  rows={2}
                  placeholder="e.g. Change email tone to be more formal and suggest a call next Tuesday."
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                />
              </div>
            )}

            {/* Decision Actions */}
            <div className="flex items-center justify-end space-x-3 pt-3 border-t border-white/10">
              <button
                onClick={() => handleDecision(approval.id, approval.stepId, "REJECT")}
                disabled={loading}
                className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 text-xs font-semibold transition-all"
              >
                <X className="h-3.5 w-3.5" />
                <span>Reject Action</span>
              </button>

              <button
                onClick={() => {
                  if (modifyingId === approval.id) {
                    handleDecision(approval.id, approval.stepId, "MODIFY");
                  } else {
                    setModifyingId(approval.id);
                  }
                }}
                disabled={loading}
                className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 text-xs font-semibold transition-all"
              >
                <Edit3 className="h-3.5 w-3.5" />
                <span>{modifyingId === approval.id ? "Submit Re-plan" : "Modify Plan"}</span>
              </button>

              <button
                onClick={() => handleDecision(approval.id, approval.stepId, "APPROVE")}
                disabled={loading}
                className="flex items-center space-x-1.5 px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/30 transition-all hover:scale-105"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Approve & Execute</span>
              </button>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
};
