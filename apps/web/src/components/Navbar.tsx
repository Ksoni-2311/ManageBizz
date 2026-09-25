import React from "react";
import { Cpu, ShieldCheck, Activity, PlusCircle, RefreshCw } from "lucide-react";
import { useAgentStore } from "../store/useAgentStore.js";

interface NavbarProps {
  onOpenCreateGoal: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenCreateGoal }) => {
  const currentState = useAgentStore(s => s.currentState);
  const pendingCount = useAgentStore(s => s.pendingApprovals.length);

  return (
    <header className="sticky top-0 z-40 w-full glass-card border-b border-white/10 px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        
        {/* Brand Logo */}
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Cpu className="h-6 w-6 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-100 to-indigo-200 bg-clip-text text-transparent">
                NexusOps
              </span>
              <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                Agentic v1.0
              </span>
            </div>
            <p className="text-xs text-slate-400">Agentic Business Operations Platform</p>
          </div>
        </div>

        {/* Live Status Indicators */}
        <div className="hidden md:flex items-center space-x-6">
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-900/60 border border-slate-800 text-xs">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="text-slate-300 font-medium">Agent State:</span>
            <span className="font-semibold text-indigo-400">{currentState}</span>
          </div>

          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-900/60 border border-slate-800 text-xs">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span className="text-slate-300">Policy Engine:</span>
            <span className="text-emerald-400 font-semibold">Active</span>
          </div>

          {pendingCount > 0 && (
            <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-xs text-amber-300 font-semibold animate-pulse">
              <Activity className="h-4 w-4 text-amber-400" />
              <span>{pendingCount} Pending Approval</span>
            </div>
          )}
        </div>

        {/* Action Button */}
        <button
          onClick={onOpenCreateGoal}
          className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/30 transition-all hover:scale-105 active:scale-95"
        >
          <PlusCircle className="h-4 w-4" />
          <span>New Business Goal</span>
        </button>
      </div>
    </header>
  );
};
