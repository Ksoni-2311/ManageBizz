/** Authenticated ownership identity passed from the API boundary to services. */
export type BusinessOwner = {
  userId: string;
  organizationId: string;
  workspaceId: string;
};

export type User = { id: string; email?: string };
export type Workspace = { id: string; organizationId: string; ownerUserId: string; name: string };
export type CRMSource = { id: string; fileName: string; importedAt: string };
export type Lead = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  email: string;
  company: string;
  dealValue: number;
  lastContactedAt: Date;
};
export type TaskRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  title: string;
  leadId?: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
};

/** A stable workspace is derived server-side from verified identity, never from a browser-supplied ID. */
export function workspaceIdFor(organizationId: string, userId: string): string {
  if (!organizationId.trim() || !userId.trim()) throw new Error("Authenticated organization and user are required.");
  return `ws:${encodeURIComponent(organizationId)}:${encodeURIComponent(userId)}`;
}
