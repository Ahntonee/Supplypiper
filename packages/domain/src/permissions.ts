/** Role permissions. The server is authoritative; the UI mirrors this table. */
export type OrgRole =
  | "owner" | "buyer_requester" | "buyer_approver" | "supplier_manager" | "supplier_staff" | "read_only_auditor";
export type OrgCapability = "buyer" | "supplier";

export type Permission =
  | "org.manage_members" | "org.view_members" | "audit.read" | "order.view"
  | "request.create" | "request.publish" | "approval.approve"
  | "quote.draft" | "quote.submit" | "catalogue.view" | "catalogue.manage" | "order.accept";

/** Permissions that only make sense for one side of the market. Role AND capability must both allow. */
const REQUIRES_CAPABILITY: Partial<Record<Permission, OrgCapability>> = {
  "request.create": "buyer", "request.publish": "buyer", "approval.approve": "buyer",
  "quote.draft": "supplier", "quote.submit": "supplier", "catalogue.view": "supplier",
  "catalogue.manage": "supplier", "order.accept": "supplier",
};

const ALL: Permission[] = [
  "org.manage_members", "org.view_members", "audit.read", "order.view", "request.create", "request.publish",
  "approval.approve", "quote.draft", "quote.submit", "catalogue.view", "catalogue.manage", "order.accept",
];

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  owner: ALL,
  buyer_requester: ["request.create", "request.publish", "order.view"],
  buyer_approver: ["approval.approve", "order.view"],
  supplier_manager: ["quote.draft", "quote.submit", "catalogue.view", "catalogue.manage", "order.accept", "order.view"],
  supplier_staff: ["quote.draft", "catalogue.view", "order.view"],
  read_only_auditor: ["audit.read", "order.view", "org.view_members"],
};

export function can(roles: readonly OrgRole[], capabilities: readonly OrgCapability[], permission: Permission): boolean {
  const need = REQUIRES_CAPABILITY[permission];
  if (need && !capabilities.includes(need)) return false;
  return roles.some((r) => ROLE_PERMISSIONS[r].includes(permission));
}
