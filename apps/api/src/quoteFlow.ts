import { authorityValid } from "./agentVerification";
import { ApiError } from "./errors";
import type { Tx } from "./helpers";

/** The request must have been addressed to this supplier and still be taking quotes. */
export async function invitedOpenRequest(tx: Tx, orgId: string, requestId: string) {
  const rec = await tx.requestRecipient.findUnique({ where: { requestId_supplierOrgId: { requestId, supplierOrgId: orgId } }, include: { request: true } });
  if (!rec) throw new ApiError(404, "NOT_FOUND", "Request not found");
  const q = rec.request;
  if (!["published", "collecting"].includes(q.state)) throw new ApiError(409, "REQUEST_CLOSED", "This request is no longer accepting quotes");
  if (q.responseDeadline && q.responseDeadline <= new Date()) throw new ApiError(409, "RESPONSE_DEADLINE_PASSED", "The response deadline has passed");
  return q;
}

export async function finishSubmit(tx: Tx, quoteId: string, requestId: string) {
  await tx.quote.update({ where: { id: quoteId }, data: { state: "submitted" } });
  const rq = await tx.procurementRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (rq.state === "published") await tx.procurementRequest.update({ where: { id: requestId }, data: { state: "collecting" } });
}

/** An agent-sourced quote may only exist for an agent registered to THIS organisation and currently authorised by it. */
export async function assertAgentMayQuote(tx: Tx, agentId: string | null, orgId: string): Promise<void> {
  const reg = agentId ? await tx.agentRegistration.findFirst({ where: { id: agentId, orgId } }) : null;
  if (!reg || !authorityValid(reg)) throw new ApiError(409, "AGENT_NOT_AUTHORISED", "The agent behind this quote is not currently authorised by your organisation");
}
