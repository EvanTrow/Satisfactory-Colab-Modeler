// Job 020: `packages/doc-storage` — the Yjs<->Postgres persistence module
// (Job 015/016) plus the Postgres connection/role-resolution plumbing it
// needs, promoted from `apps/api`-internal code into a real shared
// workspace package so `apps/realtime` (this job) can reuse it verbatim
// instead of reimplementing the load/append/compact algorithm.
//
// *** Why a new package, and why this one, of the options considered ***
//
// `apps/api`/`apps/realtime` don't import each other's `src/` — this repo's
// convention (per Job 001's scaffold) is that only `packages/*` are shared
// between workspace members; each `apps/*` is a standalone deployable. Job
// 015 built `docStorage.ts` inside `apps/api` with an explicit forward-
// looking note ("Keep the persistence module's interface transport-
// agnostic... since Job 020 will likely want the same logic accessible from
// apps/realtime"), and flagged promoting it verbatim to a package as "the
// expected move" once a second caller existed. That's exactly this job.
//
// The alternative this job considered and rejected: duplicating
// `docStorage.ts` into `apps/realtime` directly. Rejected because the
// load/append/compact algorithm is exactly the kind of logic PLAN.md §4
// itself is precise about (snapshot+log merge order, the lossless-
// compaction guarantee, the "wholesale replace, not merge" restore
// semantics) — two independent copies would drift the instant either one
// got a bugfix, and Job 022's integrity reducer is *also* going to need to
// run "on both client and server" per PLAN.md §5, meaning inside
// `apps/realtime` too. A single shared package is the only way future jobs
// don't have to remember to patch two places.
//
// This package also carries the Kysely/Postgres connection setup (`db.ts`,
// moved from `apps/api/src/db.ts`) and role resolution (`roles.ts`, the
// query half of `apps/api/src/projects/roles.ts`) — not just
// `docStorage.ts` itself — because `onLoadDocument`/`onStoreDocument` need a
// `db` to query, and `onAuthenticate`'s mandatory re-check ("RE-CHECK the
// role against Postgres so revocations apply at connect time," PLAN.md §6)
// needs `resolveRole`. Splitting those into yet another package would add
// indirection for no real benefit — nothing outside `apps/api`/
// `apps/realtime` needs a Postgres connection at all (`apps/web` never
// touches Postgres directly), so one package covering "server-side data
// access needed by more than one app" is the right grain here, named after
// its original and still-primary concern (`doc-storage`) rather than
// something more generic — a rename is cheap later if this package grows
// enough unrelated concerns to warrant it, which it hasn't yet.
//
// `apps/api/src/db.ts` and `apps/api/src/projects/roles.ts` now re-export
// from here rather than duplicating, so every existing `apps/api` file's
// `import ... from "../db.js"` / `"./roles.js"` continues to work unchanged.
// `apps/realtime` imports directly.
export * from "./db.js";
export * from "./docStorage.js";
export * from "./projection.js";
export * from "./roles.js";
