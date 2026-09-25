import React from "react";
import { CheckCircle2, ShieldAlert, Wrench, DollarSign } from "lucide-react";
import { useAgentStore } from "../store/useAgentStore.js";

export const Dashboard: React.FC = () => {
  const metrics = useAgentStore(s => s.metrics);

  const statCards = [
    {
      title: "Completed Operational Goals",
      value: metrics.completedGoals,
      subtext: "100% technical verification",
      icon: CheckCircle2,
      color: "from-emerald-500/20 to-teal-500/5",
      borderColor: "border-emerald-500/30",
      iconColor: "text-emerald-400"
    },
    {
      title: "Recovered Inactive Pipeline",
      value: metrics.totalPipelineRecovered,
      subtext: "Across CRM & Email actions",
      icon: DollarSign,
      color: "from-indigo-500/20 to-purple-500/5",
      borderColor: "border-indigo-500/30",
      iconColor: "text-indigo-400"
    },
    {
      title: "Human Approval Center",
      value: `${metrics.pendingApprovalsCount} Action Required`,
      subtext: "High-risk policy protection",
      icon: ShieldAlert,
      color: "from-amber-500/20 to-orange-500/5",
      borderColor: "border-amber-500/30",
      iconColor: "text-amber-400"
    },
    {
      title: "Tools Orchestrated",
      value: "5 Tools Active",
      subtext: "CRM, Email, Calendar, Tasks, Analytics",
      icon: Wrench,
      color: "from-purple-500/20 to-pink-500/5",
      borderColor: "border-purple-500/30",
      iconColor: "text-purple-400"
    }
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {statCards.map((stat, idx) => {
        const Icon = stat.icon;
        return (
          <div
            key={idx}
            className={`glass-card p-5 rounded-2xl border ${stat.borderColor} bg-gradient-to-br ${stat.color} transition-all hover:translate-y-[-2px]`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{stat.title}</span>
              <div className={`p-2 rounded-xl bg-slate-900/60 border border-white/5 ${stat.iconColor}`}>
                <Icon className="h-5 w-5" />
              </div>
            </div>
            <div className="text-2xl font-extrabold text-white mb-1">{stat.value}</div>
            <div className="text-xs text-slate-400">{stat.subtext}</div>
          </div>
        );
      })}
    </div>
  );
};
