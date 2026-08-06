import crypto from "node:crypto";

import type { NewSession, Session, User } from "@scm/db";

import { db } from "../db.js";

/** Cookie name for the opaque session token, per PLAN.md §6. */
export const SESSION_COOKIE_NAME = "sfm_session";

/** 30 days, matching PLAN.md §6's `Max-Age=2592000`. */
export const SESSION_TTL_MS = 2592000 * 1000;

/** Postgres unique_violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export function generateSessionToken(): string {
  // 32 random bytes, base64url-encoded, per PLAN.md §6.
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 of the opaque cookie value, as a Buffer — matches `sessions.token_hash`'s `bytea` column. */
export function hashSessionToken(token: string): Buffer {
  return crypto.createHash("sha256").update(token).digest();
}

export interface CreateSessionInput {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}

export interface CreatedSession {
  /** The raw token to set in the cookie. Never stored — only its hash is. */
  token: string;
  session: Session;
}

/**
 * Creates a session row for `userId` and returns the raw (unhashed) token
 * to set as the `sfm_session` cookie value. Only `sha256(token)` is ever
 * written to the database.
 *
 * `sessions.token_hash` is `unique not null` (Job 004's handoff note): a
 * collision is astronomically unlikely with 32 random bytes, but per that
 * note we don't assume it can't happen — a unique-violation on insert is
 * caught and retried with a freshly generated token, up to a few times,
 * rather than surfacing as an unhandled error.
 */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const values: NewSession = {
      token_hash: tokenHash,
      user_id: input.userId,
      expires_at: expiresAt,
      user_agent: input.userAgent ?? null,
      ip: input.ip ?? null,
    };

    try {
      const session = await db
        .insertInto("sessions")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { token, session };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws — but keeps TypeScript
  // happy about a guaranteed return value.
  throw new Error("failed to create a session after retrying token generation");
}

export interface ResolvedSession {
  user: User;
  session: Session;
}

/**
 * Looks up a session by the raw cookie token (hashing it first — the raw
 * token is never sent to the database in a query), and returns the session
 * and its user if the session exists and has not expired. Returns `null`
 * for an unknown token OR an expired one — the caller doesn't need to
 * distinguish the two, both mean "not logged in."
 */
export async function findValidSession(token: string): Promise<ResolvedSession | null> {
  const tokenHash = hashSessionToken(token);

  const session = await db
    .selectFrom("sessions")
    .selectAll()
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at) <= new Date()) {
    return null;
  }

  const user = await db.selectFrom("users").selectAll().where("id", "=", session.user_id).executeTakeFirst();

  if (!user) {
    // Shouldn't happen (sessions.user_id cascades on user delete), but a
    // session pointing at a since-deleted user is not a valid login.
    return null;
  }

  return { user, session };
}

/**
 * Sliding-window refresh threshold: once a session is more than halfway
 * through its 30-day TTL, an authenticated request extends it back out to
 * a full 30 days from now and bumps `users.last_seen_at`. This keeps
 * active users logged in indefinitely without writing to the database on
 * literally every request (PLAN.md doesn't specify this; kept simple per
 * the job's own guidance).
 */
const REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2;

export async function touchSession(resolved: ResolvedSession): Promise<void> {
  const now = new Date();
  const remainingMs = new Date(resolved.session.expires_at).getTime() - now.getTime();

  const updates: Promise<unknown>[] = [
    db.updateTable("users").set({ last_seen_at: now }).where("id", "=", resolved.user.id).execute(),
  ];

  if (remainingMs < REFRESH_THRESHOLD_MS) {
    updates.push(
      db
        .updateTable("sessions")
        .set({ expires_at: new Date(now.getTime() + SESSION_TTL_MS) })
        .where("id", "=", resolved.session.id)
        .execute(),
    );
  }

  await Promise.all(updates);
}

/** Deletes the session matching a raw cookie token, if any. Used by logout. */
export async function deleteSessionByToken(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token);
  await db.deleteFrom("sessions").where("token_hash", "=", tokenHash).execute();
}
