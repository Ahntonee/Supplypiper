import { describe, expect, it } from "vitest";
import { can } from "./permissions";

describe("permissions", () => {
  it("a buyer-only org owner cannot quote or accept orders (view switching grants nothing)", () => {
    expect(can(["owner"], ["buyer"], "quote.submit")).toBe(false);
    expect(can(["owner"], ["buyer"], "order.accept")).toBe(false);
    expect(can(["owner"], ["buyer"], "approval.approve")).toBe(true);
  });
  it("a supplier-only org cannot approve purchases", () => {
    expect(can(["owner"], ["supplier"], "approval.approve")).toBe(false);
  });
  it("requesters cannot approve; approvers cannot publish; auditors are read-only", () => {
    expect(can(["buyer_requester"], ["buyer"], "approval.approve")).toBe(false);
    expect(can(["buyer_approver"], ["buyer"], "request.publish")).toBe(false);
    expect(can(["read_only_auditor"], ["buyer", "supplier"], "request.create")).toBe(false);
    expect(can(["read_only_auditor"], ["buyer"], "audit.read")).toBe(true);
  });
  it("supplier staff draft but do not submit quotes", () => {
    expect(can(["supplier_staff"], ["supplier"], "quote.draft")).toBe(true);
    expect(can(["supplier_staff"], ["supplier"], "quote.submit")).toBe(false);
  });
});
