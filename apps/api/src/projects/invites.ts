// Job 022: `project_invites` — created by Job 004's migration
// (`db/migrations/0005_project_invites.ts`), unused since. Follows the same
// "store only a hash, never the raw token" pattern
// `apps/api/src/auth/session.ts` established for `sessions.token_hash`:
// a 32-random-byte, base64url-encoded token is handed to the caller exactly
// once (at creation, embedded in the shareable link); only `sha256(token)`
// is ever written to Postgres.
import crypto from "node:crypto";

import type { ProjectInvite, ProjectInviteRole } from "@scm/db";
import { sql } from "kysely";

import { db } from "../db.js";

/** Postgres unique_violation SQLSTATE — same constant used elsewhere (`store.ts`, `session.ts`). */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/** 32 random bytes, base64url-encoded — same shape/strength as `session.ts`'s `generateSessionToken`, just a distinct namespace (an invite token and a session token are never interchangeable, even though they're generated the same way). */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 of the opaque invite token, as a `Buffer` — matches `project_invites.token_hash`'s `bytea` column, same convention as `sessions.token_hash`. */
export function hashInviteToken(token: string): Buffer {
  return crypto.createHash("sha256").update(token).digest();
}

export interface CreateInviteInput {
  projectId: string;
  role: ProjectInviteRole;
  createdBy: string;
  /** `null`/`undefined` — no expiry. */
  expiresAt?: Date | null;
  /** `null`/`undefined` — unlimited uses. */
  maxUses?: number | null;
}

export interface CreatedInvite {
  /** The raw token — embed this in the shareable link. Never stored, never retrievable again after this call returns. */
  token: string;
  invite: ProjectInvite;
}

const MAX_TOKEN_ATTEMPTS = 5;

/**
 * Creates an invite row and returns the raw (unhashed) token to embed in the
 * shareable link. `token_hash` is `unique not null` (same as
 * `sessions.token_hash`) — a collision is astronomically unlikely with 32
 * random bytes, but a unique-violation on insert is caught and retried with
 * a freshly generated token rather than assumed impossible, mirroring
 * `createSession`'s own retry loop.
 */
export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt++) {
    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);

    try {
      const invite = await db
        .insertInto("project_invites")
        .values({
          project_id: input.projectId,
          token_hash: tokenHash,
          role: input.role,
          expires_at: input.expiresAt ?? null,
          max_uses: input.maxUses ?? null,
          created_by: input.createdBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return { token, invite };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_TOKEN_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new Error("failed to create an invite after retrying token generation");
}

/** Lists a project's invites (no token/hash — those never leave `createInvite`'s return value). Newest first. */
export async function listInvites(projectId: string): Promise<ProjectInvite[]> {
  return db
    .selectFrom("project_invites")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("id", "desc")
    .execute();
}

/** Deletes an invite outright — "revoke" is just "this token can never be redeemed again," there's no soft-delete/disabled state in the schema. Scoped to `projectId` so an invite id from a *different* project can never be revoked cross-project. */
export async function revokeInvite(projectId: string, inviteId: string): Promise<boolean> {
  const result = await db
    .deleteFrom("project_invites")
    .where("id", "=", inviteId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

export type InviteLookupResult =
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "exhausted" }
  | { status: "valid"; invite: ProjectInvite };

/**
 * Looks up an invite by its raw token (hashing first — the raw token never
 * touches a query) and reports whether it's currently redeemable, WITHOUT
 * mutating anything — used by the public "preview this invite" route
 * (`GET /api/invites/:token`) so an unauthenticated visitor can see what
 * they're being invited to (project title, role) before logging in.
 * `redeemInvite` below re-validates atomically at the moment of actual
 * redemption rather than trusting this snapshot, since time (and concurrent
 * redemptions) can pass between the two calls.
 */
export async function lookupInviteByToken(token: string): Promise<InviteLookupResult> {
  const tokenHash = hashInviteToken(token);
  const invite = await db
    .selectFrom("project_invites")
    .selectAll()
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!invite) return { status: "not_found" };
  if (invite.expires_at && new Date(invite.expires_at) <= new Date()) return { status: "expired" };
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return { status: "exhausted" };
  return { status: "valid", invite };
}

export type RedeemInviteResult =
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "exhausted" }
  | { status: "redeemed"; projectId: string; role: ProjectInviteRole; alreadyMember: boolean };

/**
 * Atomically redeems an invite for `userId`: increments `uses` (only if the
 * invite is still within `max_uses`/`expires_at` at the exact moment of the
 * update — the classic "two people click the last-use link at once" race)
 * and, in the same transaction, grants `userId` membership on the invite's
 * project.
 *
 * The concurrency-safe part is the `uses = uses + 1 where uses < max_uses`
 * conditional update: Postgres evaluates the `WHERE` clause against the
 * current row under the transaction's own read, and a second concurrent
 * `UPDATE` targeting the same row blocks until the first commits (ordinary
 * row-level locking), so two simultaneous redemptions of a `max_uses: 1`
 * invite can never both succeed — the second one's `WHERE` re-evaluates
 * against the now-incremented `uses` and matches zero rows.
 *
 * If `userId` is already a member of the project, this still counts as a
 * successful redemption (the invite's `uses` is still incremented — the
 * link "worked" from the redeemer's point of view) but their EXISTING role
 * is left untouched rather than possibly downgraded by an old/lesser
 * invite link — `alreadyMember: true` on the result lets the route surface
 * that distinction if useful.
 */
export async function redeemInvite(token: string, userId: string): Promise<RedeemInviteResult> {
  const tokenHash = hashInviteToken(token);

  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("project_invites")
      .set({ uses: sql`uses + 1` })
      .where("token_hash", "=", tokenHash)
      .where(({ eb, or }) =>
        or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]),
      )
      .where(({ eb, or, ref }) =>
        or([eb("max_uses", "is", null), eb("uses", "<", ref("max_uses"))]),
      )
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      // The conditional update matched nothing — find out why (not found at
      // all, vs. found but expired/exhausted) for a precise error, via a
      // plain read inside the same transaction.
      const existing = await trx
        .selectFrom("project_invites")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (!existing) return { status: "not_found" };
      if (existing.expires_at && new Date(existing.expires_at) <= new Date()) return { status: "expired" };
      return { status: "exhausted" };
    }

    const existingMember = await trx
      .selectFrom("project_members")
      .select("role")
      .where("project_id", "=", updated.project_id)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    if (!existingMember) {
      await trx
        .insertInto("project_members")
        .values({ project_id: updated.project_id, user_id: userId, role: updated.role, invited_by: updated.created_by })
        .execute();
    }

    return {
      status: "redeemed",
      projectId: updated.project_id,
      role: updated.role,
      alreadyMember: existingMember !== undefined,
    };
  });
}
