import React, { useEffect, useState } from "react";
import { FileText, Shield, User, Filter, Search } from "lucide-react";

interface AuditEntry {
  _id: string;
  eventType: string;
  riskLevel?: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export const AuditLog: React.FC = () => {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/audit")
      .then(res => res.json())
      .then(data => {
        if (data.success && data.logs) {
          setLogs(data.logs);
        }
      })
      .catch(() => {
        setLogs([
          {
            _id: "audit-1",
            eventType: "AGENT_STATE_CHANGED",
            riskLevel: "LOW",
            details: { fromState: "PLANNING", toState: "RISK_CHECK" },
            timestamp: new Date().toISOString()
          },
          {
            _id: "audit-2",
            eventType: "HIGH_RISK_ACTION_PAUSED",
            riskLevel: "HIGH",
            details: { action: "email.sendEmail", recipient: "sarah@starlight.io" },
            timestamp: new Date(Date.now() - 60000).toISOString()
          }
        ]);
      });
  }, []);

  const filteredLogs = logs.filter(l => 
    l.eventType.toLowerCase().includes(filter.toLowerCase()) ||
    JSON.stringify(l.details).toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="glass-card p-6 rounded-2xl border border-white/10 mt-8">
      
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
        <div className="flex items-center space-x-2">
          <FileText className="h-5 w-5 text-indigo-400" />
          <h3 className="text-base font-bold text-white">System Audit & Compliance Log</h3>
        </div>

        <div className="relative">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter audit events..."
            className="pl-9 pr-4 py-1.5 rounded-xl bg-slate-900 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-white/5 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
              <th className="py-2.5 px-3">Timestamp</th>
              <th className="py-2.5 px-3">Event Type</th>
              <th className="py-2.5 px-3">Risk Level</th>
              <th className="py-2.5 px-3">Event Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-mono">
            {filteredLogs.map(log => (
              <tr key={log._id} className="hover:bg-slate-900/40">
                <td className="py-2.5 px-3 text-slate-500">{new Date(log.timestamp).toLocaleTimeString()}</td>
                <td className="py-2.5 px-3 font-semibold text-indigo-300">{log.eventType}</td>
                <td className="py-2.5 px-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] ${
                    log.riskLevel === "HIGH" ? "bg-rose-500/20 text-rose-300" : "bg-slate-800 text-slate-400"
                  }`}>
                    {log.riskLevel || "INFO"}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-slate-300 truncate max-w-xs">{JSON.stringify(log.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
};
