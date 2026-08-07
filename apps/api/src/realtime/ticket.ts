// Job 020 / PLAN.md §6: mints the short-lived (60s) HS256 JWT a client
// exchanges for a Hocuspocus WebSocket connection. `apps/realtime`'s
// `onAuthenticate` hook (`ticket.ts` over there) verifies what this mints —
// see `getRealtimeTicketSecret` in `./config.ts` for why the secret is a
// duplicated env-var read rather than a shared module.
import crypto from "node:crypto";

import type { ProjectMemberRole } from "@scm/db";
import jwt from "jsonwebtoken";

import { getRealtimeTicketSecret } from "./config.js";

/** Matches PLAN.md §6's "60-second HS256 JWT" exactly. */
export const REALTIME_TICKET_TTL_SECONDS = 60;

export interface MintRealtimeTicketInput {
  userId: string;
  projectId: string;
  role: ProjectMemberRole;
}

/**
 * Mints `{ sub: userId, projectId, role, jti }`, signed HS256, expiring in
 * `REALTIME_TICKET_TTL_SECONDS`. `jti` (a random UUID, unused for actual
 * revocation today — see this job's Handoff notes on why per-ticket
 * revocation isn't needed given the 60s TTL) is included because PLAN.md §6
 * names it explicitly in the ticket's shape.
 */
export function mintRealtimeTicket({ userId, projectId, role }: MintRealtimeTicketInput): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ sub: userId, projectId, role, jti }, getRealtimeTicketSecret(), {
    algorithm: "HS256",
    expiresIn: REALTIME_TICKET_TTL_SECONDS,
  });
}
