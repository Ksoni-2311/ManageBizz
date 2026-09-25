import React, { useState } from "react";
import { X, Sparkles, Send, Calendar, ShieldCheck, ArrowRight } from "lucide-react";
import { createGoalApi } from "../services/api.js";
import { useAgentStore } from "../store/useAgentStore.js";

interface CreateGoalModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PRESET_DEMO_GOALS = [
  "Recover our inactive high-value leads from the last 30 days.",
  "Schedule Q4 review meetings with all tier-1 clients who have open tasks.",
  "Audit sales metrics and follow up with leads stuck in discovery call status."
];

export const CreateGoalModal: React.FC<CreateGoalModalProps> = ({ isOpen, onClose }) => {
  const [prompt, setPrompt] = useState("Recover our inactive high-value leads from the last 30 days.");
  const [timeWindow, setTimeWindow] = useState(30);
  const [loading, setLoading] = useState(false);
  const setActiveRun = useAgentStore(s => s.setActiveRun);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    try {
      const result = await createGoalApi(prompt, timeWindow);
      if (result.success) {
        setActiveRun(result.runId, result.goal.id, prompt);
        onClose();
      }
    } catch (err) {
      console.error("Failed to submit goal:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
      <div className="glass-card w-full max-w-2xl rounded-3xl p-6 border border-white/15 shadow-2xl animate-in fade-in zoom-in duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-6">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/20 border border-indigo-500/30 text-indigo-400">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Create Business Goal</h2>
              <p className="text-xs text-slate-400">Natural Language Operational Intent Parser</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-all"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          
          {/* Preset Suggestions */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Preset Scenarios (Click to load)
            </label>
            <div className="space-y-2">
              {PRESET_DEMO_GOALS.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setPrompt(preset)}
                  className={`w-full text-left p-3 rounded-xl border text-xs transition-all flex items-center justify-between ${
                    prompt === preset
                      ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-200 font-medium"
                      : "bg-slate-900/50 border-white/5 text-slate-400 hover:text-slate-200 hover:border-white/10"
                  }`}
                >
                  <span>{preset}</span>
                  <ArrowRight className="h-3.5 w-3.5 opacity-60" />
                </button>
              ))}
            </div>
          </div>

          {/* Goal Prompt Input */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Business Intent Prompt
            </label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Recover our inactive high-value leads from the last 30 days."
              className="w-full px-4 py-3 rounded-2xl bg-slate-900/80 border border-white/10 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/80 transition-all resize-none font-sans"
              required
            />
          </div>

          {/* Configuration Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3.5 rounded-2xl bg-slate-900/50 border border-white/5 flex items-center space-x-3">
              <Calendar className="h-5 w-5 text-indigo-400" />
              <div>
                <span className="block text-xs font-medium text-slate-400">Time Window</span>
                <span className="text-sm font-semibold text-white">{timeWindow} Days Inactivity</span>
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-900/50 border border-white/5 flex items-center space-x-3">
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
              <div>
                <span className="block text-xs font-medium text-slate-400">Safety Policy</span>
                <span className="text-sm font-semibold text-emerald-400">Human Approval Required</span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end space-x-3 pt-4 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl border border-white/10 text-slate-300 hover:bg-white/5 text-sm font-medium transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              <span>{loading ? "Parsing Goal..." : "Initialize Agent Run"}</span>
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};
