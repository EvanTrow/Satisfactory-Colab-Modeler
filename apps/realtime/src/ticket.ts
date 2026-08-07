// Job 020 / PLAN.md §6: verifies the ticket a client presents when opening
// a Hocuspocus connection — "Hocuspocus onAuthenticate: verify signature +
// TTL + projectId match." Mirrors (does not import — see this repo's
// apps-don't-import-each-other's-src convention) the shape
// `apps/api/src/realtime/ticket.ts` mints.
import type { ProjectMemberRole } from "@scm/db";
import jwt from "jsonwebtoken";

import { getRealtimeConfig } from "./config.js";

export interface RealtimeTicketPayload {
  sub: string;
  projectId: string;
  role: ProjectMemberRole;
  jti: string;
}

/** Thrown by `verifyRealtimeTicket` for any rejection reason — expired, bad signature, malformed payload, or a `projectId` mismatch. */
export class TicketError extends Error {}

function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

/**
 * Verifies `token` was signed by `apps/api` (HS256, shared secret), has not
 * expired (`jwt.verify` checks the `exp` claim it was minted with —
 * PLAN.md's "60-second" TTL), and was minted specifically for
 * `expectedProjectId` — the third check `onAuthenticate` needs beyond plain
 * signature/TTL validity, since a still-valid ticket for project A must not
 * authenticate a connection to project B within the same 60-second window.
 * Throws `TicketError` on any failure; never returns a partially-valid
 * payload.
 */
export function verifyRealtimeTicket(token: string, expectedProjectId: string): RealtimeTicketPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, getRealtimeConfig().ticketSecret, { algorithms: ["HS256"] });
  } catch (err) {
    throw new TicketError(`invalid or expired realtime ticket: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof decoded !== "object" || decoded === null) {
    throw new TicketError("malformed ticket payload");
  }
  const payload = decoded as Record<string, unknown>;
  if (
    typeof payload.sub !== "string" ||
    typeof payload.projectId !== "string" ||
    typeof payload.jti !== "string" ||
    !isProjectMemberRole(payload.role)
  ) {
    throw new TicketError("malformed ticket payload");
  }
  if (payload.projectId !== expectedProjectId) {
    throw new TicketError("ticket was minted for a different project");
  }

  return { sub: payload.sub, projectId: payload.projectId, role: payload.role, jti: payload.jti };
}
