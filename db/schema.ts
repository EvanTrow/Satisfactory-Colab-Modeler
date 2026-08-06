// Kysely `Database` interface describing the tables created by the
// migrations in `db/migrations/`. Kept in this package (rather than in
// `apps/api`) so the migration files and the types that describe their
// result live next to each other and can't drift apart.
//
// This mirrors PLAN.md section 4 "Identity, projects, sharing" exactly.
// Scope note: only the five relational tables from that subsection
// (`users`, `sessions`, `projects`, `project_members`, `project_invites`)
// are defined here. The CRDT persistence tables (`project_doc_state`,
// `project_doc_updates`, `project_versions` — Job 015) and the read-only
// relational projection (`proj_nodes`, `proj_edges` — Job 025) are out of
// scope for this job and deliberately not declared yet.
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Postgres `inet` values round-trip through `postgres.js`/Kysely as plain strings. */
type Inet = string;

export interface UsersTable {
  id: Generated<string>;
  /** Discord snowflake; the stable join key. */
  discord_id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
  created_at: Generated<ColumnType<Date, string | Date | undefined, never>>;
  last_seen_at: Date | string | null;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export interface SessionsTable {
  id: Generated<string>;
  /** SHA-256 hash of the opaque session cookie value — never the raw token. */
  token_hash: Buffer;
  user_id: string;
  expires_at: Date | string;
  created_at: Generated<ColumnType<Date, string | Date | undefined, never>>;
  user_agent: string | null;
  ip: Inet | null;
}

export type Session = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;
export type SessionUpdate = Updateable<SessionsTable>;

export type ProjectVisibility = "private" | "link" | "public";

export interface ProjectsTable {
  id: Generated<string>;
  /** URL-friendly id, e.g. `/p/k3n9wq2`. */
  short_id: string;
  owner_id: string;
  title: Generated<string>;
  visibility: Generated<ProjectVisibility>;
  /** Which `game_data.json` revision this project targets. */
  game_data_version: string;
  /** Solver mode, multipliers, grid, number formats — free-form settings blob. */
  doc_settings: Generated<unknown>;
  created_at: Generated<ColumnType<Date, string | Date | undefined, never>>;
  updated_at: Generated<ColumnType<Date, string | Date | undefined, Date | string>>;
  /** Soft delete. */
  deleted_at: Date | string | null;
}

export type Project = Selectable<ProjectsTable>;
export type NewProject = Insertable<ProjectsTable>;
export type ProjectUpdate = Updateable<ProjectsTable>;

export type ProjectMemberRole = "owner" | "editor" | "viewer";

export interface ProjectMembersTable {
  project_id: string;
  user_id: string;
  role: ProjectMemberRole;
  invited_by: string | null;
  created_at: Generated<ColumnType<Date, string | Date | undefined, never>>;
}

export type ProjectMember = Selectable<ProjectMembersTable>;
export type NewProjectMember = Insertable<ProjectMembersTable>;
export type ProjectMemberUpdate = Updateable<ProjectMembersTable>;

export type ProjectInviteRole = "editor" | "viewer";

export interface ProjectInvitesTable {
  id: Generated<string>;
  project_id: string;
  token_hash: Buffer;
  role: ProjectInviteRole;
  expires_at: Date | string | null;
  max_uses: number | null;
  uses: Generated<number>;
  created_by: string;
}

export type ProjectInvite = Selectable<ProjectInvitesTable>;
export type NewProjectInvite = Insertable<ProjectInvitesTable>;
export type ProjectInviteUpdate = Updateable<ProjectInvitesTable>;

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  project_invites: ProjectInvitesTable;
}
