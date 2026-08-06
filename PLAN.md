# Satisfactory Collaborative Modeler — Architecture & Roadmap

**Status:** Planning complete, awaiting review. No implementation has begun.

## Context

The goal is a browser-based reimplementation of **Satisfactory Modeler** — a closed-source desktop tool (Steam/itch.io) for planning Satisfactory factories — with Google-Docs-style real-time multiplayer editing that the desktop original cannot offer.

Satisfactory Modeler describes itself as "a visual calculator that allows quick planning and calculations for any custom layout": you place one node per recipe, wire outputs to inputs, add limits to a few nodes, and it solves the whole graph for how many machines you need and how parts flow. Its distinguishing strengths over web planners are (a) exact rational arithmetic with no rounding, (b) genuine splitter/merger flow modeling including priority splitters, and (c) outposts — nested sub-factories that keep large builds navigable.

What it lacks is collaboration. It is a single-user desktop app whose sharing story is exporting a `.sfmd` file. This project keeps that modeling workflow and interaction model, wraps it in the visual polish of [Ferrumium](https://ferrumium.com), and adds concurrent multi-user editing.

**Confirmed decisions** (from planning Q&A): React Flow for the canvas; a single container host with managed Postgres; Manual + Basic calculators in the MVP with Full deferred to its own phase; local IndexedDB caching but online-to-edit.

---

## 1. Resource Inventory

`resources/` is a clean extraction of the shipped desktop app's data directory. It contains **no source code** — it is data, art, and localization only. The app is closed-source with no plans to change that ([FAQ](https://satisfactorymodeler.github.io/docs/faq/faq.html)), so this is a clean-room reimplementation from data + public documentation.

| Path | Contents | Use |
|---|---|---|
| `resources/game_data/game_data.json` | 136 KB. `Machines` (32), `MultiMachines` (7), `Parts` (170), `Recipes` (332) | **Directly reusable** as the game database |
| `resources/images/icons/` | 204 PNGs — one per part and machine, plus `Conveyor_Merger` and `Smart_Splitter` | **Directly reusable** as node/part icons |
| `resources/images/custom_icons/` | `anypart.png`, `Blueprint.png`, `Outpost.png` | Icons for the three abstract node types |
| `resources/images/ui_icons/` | 43 UI glyphs (`clockspeed`, `somersloop`, `waypoints`, `limit`, `align`, `summary`, `popout`, …) | Reference for the toolbar/feature surface; we'll likely use a modern icon set instead |
| `resources/languages/languages.json` + `translations/*.json` | 55 locales; `en-US.json` has ~600 keys | **The single most valuable file** — the complete UI string table, which reveals the entire feature surface |

### Icon coverage is exactly complete

170 parts + 32 machines + 2 logistics icons = 204 files, with **zero** parts or machines missing an icon and zero orphan icons. Filenames are the display name with spaces → underscores (`Iron Ore` → `Iron_Ore.png`), so lookup is a pure function with no mapping table needed.

### The data model is unusually clean

```jsonc
// Recipe: ONE Parts array with SIGNED amounts. Negative = input, positive = output.
{ "Name": "Iron Alloy Ingot", "Machine": "Foundry", "BatchTime": "12",
  "Alternate": true, "Tier": "3-3",
  "Parts": [ { "Part": "Iron Ore",   "Amount": "-8" },
             { "Part": "Copper Ore", "Amount": "-2" },
             { "Part": "Iron Ingot", "Amount": "15" } ] }
```

Findings that shape the implementation:

- **All numbers are exact rational strings**, not floats: `"12/5"`, `"1/2"`, `"-9/5"`, `"1321929/1000000"`. This is the tool's core promise — the docs state limits accept "whole numbers, decimals, fractions (including mixed numbers)" and it "calculates exact numbers with no rounding," with hover tooltips showing the exact fraction. **Exact rational arithmetic is a hard requirement, not a nicety.**
- **`Recipe.Machine` resolves against a union namespace** of `Machines` and `MultiMachines`. Five names (`Miner`, `Oil Extractor`, `Resource Well Extractor`, `Geothermal Generator`, `Space Elevator`) resolve to MultiMachines; the rest to plain Machines. No collisions.
- **`MultiMachines` model variant + node purity.** A `Miner` has machine variants (Mk.1/2/3 at `PartsRatio` 60/120/240) crossed with capacities (Impure `1/2`, Normal `1`, Pure `2`). Verifies exactly: Mk.3 on Pure = 1 × 240 × 2 = 480/min. `Geothermal Generator` uses `PowerRatio` instead of `PartsRatio` because it yields power, not parts.
- **Generators are recipes with no positive parts** (23 of them). They consume fuel and produce nothing; power comes from the machine's positive `AveragePower`. Sign convention: `AveragePower` positive = generates (Nuclear `2500`), negative = consumes (Manufacturer `-55`).
- **Somersloop boost is data-driven.** `MaxProductionShards` / `ProductionShardMultiplier` / `ProductionShardPowerExponent` — e.g. Manufacturer is 4 / `1/4` / `2`, so 4 slugs give `1 + 4×(1/4) = 2×` output at `2² = 4×` power.
- **All 32 machines carry a build `Cost`** array, which powers the "Cost To Build" summary.
- `Tier` is a `"tier-milestone"` string (`"0-0"` … `"9-5"`) on parts, recipes, and machines, for progression filtering.
- 110 of 332 recipes are `Alternate`; 15 parts are `Fluid`; 16 recipes are `Ficsmas`.
- `IgnoreInputMultiplier` (44 recipes) and `SpaceElevatorMultiplier` (5) exempt/opt-in recipes to the global cost-multiplier settings used for modded games.

> ⚠️ **One place exactness breaks down.** `OverclockPowerExponent` is `1321929/1000000`, used as an *exponent*: `power = base × clock^1.321929`. That is irrational for most inputs. So **part rates stay exact rationals; power is necessarily floating-point.** This is why the original shows rates as fractions but power as decimals, and the reimplementation must do the same.

### Feature surface revealed by `en-US.json`

The string table exposes the whole app without needing the binary. Highlights: four solver modes with help text; outposts and blueprints; priority splitters/mergers/splurgers; storage-container fill modes; auto-round; waypoints with documented double-click gestures; per-location number formatting (fraction vs decimal, digits, rounding mode); scoped operations (`Everything` / `Current Outpost` / `Current Outpost & Below` / `Selected` / `Selected & Below` / `Selected + Connected`); red/orange validity highlighting; undo/redo; and a summary panel of made/used/unmade/unused/sunk/points/power.

**Sources:** [itch.io page](https://satisfactorymodeler.itch.io/satisfactorymodeler) · [Official docs](https://satisfactorymodeler.github.io/docs/) · [Quick Start](https://satisfactorymodeler.github.io/docs/quick_start/quick_start.html) · [Specialty Machines](https://satisfactorymodeler.github.io/docs/specialty_machines/specialty_machines.html) · [Calculators](https://satisfactorymodeler.github.io/docs/calculators/calculators.html) · [FAQ](https://satisfactorymodeler.github.io/docs/faq/faq.html)

---

## 2. The Interaction Model to Reproduce

Characterized from the official docs plus the string table. **This is the part we copy; Ferrumium supplies only the visual language.**

| Action | Interaction |
|---|---|
| Add a machine | **Double-click or right-click the empty canvas** → Recipe Chooser opens. Two lists: specialty machines on the left, filterable recipes on the right. |
| Connect | **Drag from an output port to an input port, or input→output** (both directions work). Remove by re-dragging or right-clicking the part label. |
| Pan / zoom | Drag the background to pan; scroll wheel to zoom. |
| Select | Click a machine; **right-click-drag a marquee** for multi-select. Standard cut/copy/paste/delete keybinds. |
| Set a limit | A field at the bottom of the machine node. Miners and AWESOME Sinks default to parts-per-minute; everything else defaults to machine count. |
| Clock speed | Numeric field plus **± buttons that snap the clock so the machine count lands on a whole number** (minus rounds count up, plus rounds it down, capped at 250%). |
| Auto-round | Toggle that continuously solves clock speed so machine count is a whole number. Manually touching clock or limit switches it off. Signalled by black field backgrounds. |
| Waypoints | Double-left-click a connection label or waypoint to add one; double-right-click a waypoint to delete it; double-right-click a bare label to delete the connection. Waypoints are draggable and stay put when their machine moves. |
| Outposts | Nested containers, "like folders." Drill in to edit contents; from outside, the outpost is a single node with input/output ports. |
| Blueprints | An outpost whose contents are *duplicable*. Put a limit on something inside to define one copy; the blueprint's calculated value is how many copies to build. |

**Critical modeling philosophy** (stated in Planning Basics): the tool is *a visual calculator, not a layout planner*. The correct usage is **one node per recipe**, letting the solver compute quantities — not one node per physical machine. This keeps node counts moderate (tens to low hundreds per outpost), which is what makes DOM-based rendering viable.

**Specialty node types:** Outpost · Blueprint · Splurger (explicit splitter/merger; usually unnecessary since "all connection points act as splitters or mergers by default") · Priority Splurger / Priority Splitter / Priority Merger (two priority tiers — top drains first, bottom takes overflow) · AWESOME Sink (with belt-tier cap) · Storage Container (four modes: Partially Full / Full / Empty / Input = Output) · Dimensional Depot Uploader · Space Elevator phases · Any Part (wildcard).

**The four calculators:**

| Mode | Entered values are… | Models splitter/merger preference? | Speed |
|---|---|---|---|
| **Full** (default) | Limits | Yes — even-split preference **and** priority nodes | Can be slow; cancellable |
| **Basic** | Limits | No | Always fast |
| **Manual** | *The final values you want* (spreadsheet-like) | No | Always fast |
| **None** | Nothing computed | — | Instant |

---

## 3. Feature Scope

### MVP

**Canvas & editing** — infinite pan/zoom canvas; Recipe Chooser on double/right-click with filtering by name, machine, tier, and alternate-recipe toggle; recipe nodes with title, machine icon, per-part input/output rows, limit field, clock-speed field with ± snapping, and somersloop count; drag-to-connect between typed ports; marquee select; cut/copy/paste/delete; **per-user undo/redo**; snap-to-grid for machines and waypoints; connection waypoints with the documented double-click gestures.

**Structure** — outposts with drill-in navigation and breadcrumbs; port mapping on the outpost node at the parent level.

**Calculation** — exact rational engine; **Manual**, **Basic**, and **None** modes; results computed in a cancellable Web Worker; red highlighting for invalid values and orange for non-matching; summary panel with made/used/unmade/unused, power made/used/net, sink points, and cost-to-build, scoped to Everything / Current Outpost / Selected.

**Multiplayer** — concurrent editing with live node/edge updates; presence avatars, per-user cursors, and selection highlighting; soft field-level indicators when someone else is typing in a field; per-project roles (owner / editor / viewer); share-by-link with a role.

**Platform** — Discord OAuth2 login; project list with create/rename/duplicate/soft-delete; autosave; dark and light themes; number-format settings (fraction/decimal, digits, rounding).

### Later phases

Full calculator with splitter/merger priority · blueprints (duplicable outposts) · auto-round mode · version history with restore and named snapshots · `.sfmd` import/export (requires reverse-engineering the format — see Open Questions) · 55-locale i18n (string tables are already in the repo) · comments/annotations on nodes · minimap · tier-gated recipe filtering by save progression · custom node colors and styles · connection style options (Direct/Curves/Horizontal/Vertical) · pop-out summary windows · public project gallery.

### Explicitly out of scope

Physical/3D layout planning, Satisfactory save-file (`.sav`) import, and belt-splitter ratio calculators. None are part of Satisfactory Modeler's model.

---

## 4. Data Model (Postgres)

Two layers with distinct jobs: **relational tables** own identity, ownership, and permissions; the **CRDT document** owns canvas state. Mixing them is the classic mistake — per-node rows can't express concurrent intent, and a CRDT blob can't answer "which projects can this user see?"

### Identity, projects, sharing

```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  discord_id    text unique not null,          -- Discord snowflake; the stable join key
  username      text not null,
  global_name   text,
  avatar_hash   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
-- Discord access/refresh tokens are deliberately NOT stored: we need identity only
-- at login, so discarding them removes an encryption-at-rest obligation entirely.

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  token_hash   bytea unique not null,          -- SHA-256 of the opaque cookie value
  user_id      uuid not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  user_agent   text,
  ip           inet
);
create index on sessions (user_id);

create table projects (
  id                uuid primary key default gen_random_uuid(),
  short_id          text unique not null,      -- URL-friendly, e.g. /p/k3n9wq2
  owner_id          uuid not null references users(id),
  title             text not null default 'Untitled Factory',
  visibility        text not null default 'private'
                    check (visibility in ('private','link','public')),
  game_data_version text not null,             -- which game_data.json revision it targets
  doc_settings      jsonb not null default '{}'::jsonb,  -- solver mode, multipliers, grid, formats
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz                -- soft delete
);
create index on projects (owner_id) where deleted_at is null;

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('owner','editor','viewer')),
  invited_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index on project_members (user_id);

create table project_invites (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  token_hash  bytea unique not null,
  role        text not null check (role in ('editor','viewer')),
  expires_at  timestamptz,
  max_uses    int,
  uses        int not null default 0,
  created_by  uuid not null references users(id)
);
```

### Canvas state: snapshot + incremental log

This is the part of the brief about supporting "both current-state snapshots and incremental real-time edits." Yjs gives us both natively, so the schema stores each in the shape it's good at.

```sql
-- Compacted snapshot. One row per project. Fast to load.
create table project_doc_state (
  project_id   uuid primary key references projects(id) on delete cascade,
  ydoc         bytea not null,        -- Y.encodeStateAsUpdate(doc)
  state_vector bytea not null,        -- lets clients sync a delta instead of the whole doc
  seq          bigint not null,       -- highest update id folded into this snapshot
  compacted_at timestamptz not null default now()
);

-- Append-only incremental log. Written on every debounced flush; cheap.
create table project_doc_updates (
  id            bigserial primary key,
  project_id    uuid not null references projects(id) on delete cascade,
  update        bytea not null,       -- a Yjs update blob
  actor_user_id uuid references users(id),
  created_at    timestamptz not null default now()
);
create index on project_doc_updates (project_id, id);
```

**Load** = snapshot + every log row with `id > seq`, merged. **Write** = append one row (no rewriting the document). A background job folds logs into the snapshot once the log exceeds ~200 rows, then deletes them. This keeps writes O(change) instead of O(document) while a crash loses at most one debounce window.

```sql
-- Named/auto version history for restore.
create table project_versions (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  ydoc       bytea not null,
  label      text,
  kind       text not null check (kind in ('auto','manual','import','pre_restore')),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
```

### Relational projection (read-only, Phase 6)

Materialized from the CRDT on a debounce so the server can query factories without instantiating Yjs — needed for search, a public gallery, and analytics. **Never written by the client; never a source of truth.**

```sql
create table proj_nodes (
  project_id   uuid not null references projects(id) on delete cascade,
  node_id      text not null,
  container_id text not null,
  kind         text not null,          -- 'recipe' | 'splurger' | 'storage' | 'outpost' | ...
  recipe_name  text,
  machine_name text,                   -- resolved MultiMachine variant, e.g. 'Miner Mk.2'
  pos_x        double precision,
  pos_y        double precision,
  limit_exact  text,                   -- canonical rational 'n/d' — lossless
  limit_approx double precision,       -- for sorting/filtering only
  clock_exact  text,
  shards       smallint,
  purity       text,
  belt_tier    text,
  storage_mode text,
  primary key (project_id, node_id)
);

create table proj_edges (
  project_id uuid not null references projects(id) on delete cascade,
  edge_id    text not null,
  part       text not null,
  from_node  text not null, from_port text not null,
  to_node    text not null, to_port   text not null,
  waypoints  jsonb not null default '[]'::jsonb,
  primary key (project_id, edge_id)
);
```

> **Rational storage:** Postgres has no rational type, and `numeric` cannot represent `1/3` exactly. Store the canonical `"n/d"` string as the lossless value, with a `double precision` companion column for ordering only. Never compute from the approximate column.

### The CRDT document schema

```
Y.Doc
├─ meta        Y.Map    { schemaVersion, title, gameDataVersion }
├─ settings    Y.Map    { solverMode, inputMultiplier, powerMultiplier,
│                         spaceElevatorMultiplier, snapMachines, gridMachine{x,y},
│                         snapWaypoints, gridWaypoint{x,y}, numberFormats, connectionStyle }
├─ containers  Y.Map<containerId, Y.Map>
│     { id, kind: 'root'|'outpost'|'blueprint', parentId, title, color, x, y, copiesLimit }
├─ nodes       Y.Map<nodeId, Y.Map>
│     { id, containerId, kind, recipe, machine, x, y, title, color,
│       limit, limitMode: 'machines'|'ppm', clock, autoRound, shards,
│       purity, beltTier, storageMode, priorityOrder: Y.Array<portId> }
└─ edges       Y.Map<edgeId, Y.Map>
      { id, containerId, part, fromNode, fromPort, toNode, toPort,
        waypoints: Y.Array<Y.Map{x,y}>, style, labelPos }
```

Three deliberate choices:

1. **Each node is its own `Y.Map`, not a JSON blob.** Two users editing different fields of the same machine merge cleanly per field. A blob would make every edit last-writer-wins over the whole node.
2. **`edgeId` is a deterministic hash of `(fromNode, fromPort, toNode, toPort)`.** If two users draw the same connection simultaneously they write the *same key* and merge into one edge, instead of producing a duplicate. This eliminates a whole conflict class for free.
3. **No solver output lives in the CRDT.** Calculated values are derived state, recomputed locally from the document. Syncing them would multiply traffic for data every client can compute itself, and would make the log useless for version history.

---

## 5. Real-Time Sync Architecture

**Recommendation: Yjs CRDT, served by Hocuspocus over WebSocket, cached in IndexedDB.**

### Why CRDT over the alternatives

| Approach | Verdict for this app |
|---|---|
| **Yjs (CRDT)** ✅ | Convergence is a property of the data structure, not of server logic. Presence, per-user undo, offline buffering, and delta sync all come with it. The document is a bounded node/edge graph — thousands of small values, not a million-character text buffer — which is Yjs's comfortable middle. |
| **Custom OT layer** ❌ | OT over a nested tree/graph needs a hand-written transform for every operation *pair* (move×delete, connect×delete, reparent×reparent) plus a central sequencer. Months of work and a long tail of convergence bugs, for no advantage a CRDT doesn't already give. |
| **Server-authoritative broadcast** ⚠️ | Simplest to reason about and enforces invariants centrally — but every edit costs a round trip, so dragging a node feels laggy, and you must build conflict resolution and multi-user undo by hand. |

The honest tradeoff: **a CRDT guarantees convergence, not correctness.** Two clients always reach the same state, but that state can violate application invariants — the classic case being user A deleting a machine while user B connects an edge to it, which converges to an edge pointing at nothing.

### Integrity reducer

The fix is an explicit repair pass, run after every transaction on both client and server, inside a Yjs transaction tagged `origin: 'integrity'` so it never pollutes anyone's undo stack:

- Delete edges whose `fromNode` or `toNode` no longer exists.
- **Reparent** orphaned nodes to the root container rather than deleting them (concurrent-delete-of-container should not destroy a collaborator's work).
- Clamp `shards` to the machine's `MaxProductionShards`; drop ports that the current recipe doesn't have (someone changed the recipe while someone else wired it).
- Deduplicate edges — a no-op given deterministic `edgeId`, kept as a backstop.

Running it on the server too means a malicious or buggy client can't persist a corrupt document.

### Presence

Yjs **Awareness** — ephemeral, never persisted, never touches Postgres:

```ts
{ userId, displayName, avatarUrl, color,        // color derived from userId hash
  cursor: { x, y, containerId } | null,          // containerId scopes cursors to an outpost
  selection: string[],                           // node ids, drawn as a colored halo
  editingField: { nodeId, field } | null }       // soft indicator, not a lock
```

Field-level editing is a **soft** indicator (colored ring + avatar on the field), never a hard lock — hard locks in a CRDT tend to strand fields when a client disconnects uncleanly.

### Server

**Hocuspocus** rather than raw `y-websocket`, because it ships exactly the hooks we need: `onAuthenticate` (ticket validation and role resolution), `onLoadDocument` / `onStoreDocument` (debounced Postgres persistence), per-connection `readOnly` for viewers, and a Redis extension for cross-instance awareness when we outgrow one container.

### The multiplayer-specific hazard: the solver

Five people editing while every keystroke retriggers a full solve will melt the app. Mitigations, in order of importance:

1. Solver runs in a **Web Worker**, debounced ~150 ms, and is **cancellable** — the original's `STOP` button is the same affordance.
2. **Dirty-subgraph solving**: partition the graph into connected components, cache per-component results, and re-solve only components touched by an edit. Outposts already partition the graph, so this maps naturally.
3. Show the last result greyed/stale while recomputing rather than blanking values.
4. Every client computes the same answer from the same CRDT state, so results need no syncing — **provided the algorithm is deterministic.** The Basic calculator "may produce inconsistent results when multiple valid solutions exist," so we must pin a fixed variable ordering and a deterministic pivot rule, or collaborators will see different numbers for identical state. This is a real correctness requirement, not a polish item.

---

## 6. Discord OAuth2 Flow

Authorization Code flow with PKCE. Discord is a confidential client here (the secret lives server-side), so PKCE is belt-and-braces, but it costs nothing.

```
1. GET /auth/discord/login
   → generate `state` (32B random) + PKCE verifier/challenge
   → store both in a short-lived signed httpOnly cookie (5 min)
   → 302 to https://discord.com/oauth2/authorize
        ?client_id=…&redirect_uri=…&response_type=code
        &scope=identify&state=…&code_challenge=…&code_challenge_method=S256

2. GET /auth/discord/callback?code=…&state=…
   → verify `state` matches the cookie (CSRF); clear it
   → POST https://discord.com/api/oauth2/token   (code + verifier + client_secret)
   → GET  https://discord.com/api/users/@me      (Bearer) → { id, username, global_name, avatar }
   → DISCARD the Discord tokens — identity is all we need
   → upsert users ON CONFLICT (discord_id)
   → create session: 32B random token; store SHA-256 hash in `sessions`
   → Set-Cookie: sfm_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
   → 302 to the app
```

`scope=identify` only. Requesting `email` adds a consent-screen field and a PII-retention duty for something the app never needs.

### Tying sessions to the WebSocket layer

Browsers cannot set headers on a WebSocket handshake. Cookies *are* sent on a same-origin handshake, and the chosen deployment is same-origin — but a **short-lived ticket** keeps us portable if the frontend later moves to a CDN, and avoids the WS layer depending on cookie semantics:

```
GET /api/realtime/ticket?projectId=…     (authenticated by the session cookie)
  → resolve role from project_members / visibility
  → return a 60-second HS256 JWT { sub: userId, projectId, role, jti }

wss://…/collab/<projectId>?ticket=<jwt>
  → Hocuspocus onAuthenticate: verify signature + TTL + projectId match,
    then RE-CHECK the role against Postgres so revocations apply at connect time
  → attach { userId, role } to connection context; role 'viewer' ⇒ readOnly: true
```

Long-lived connections still need revocation. When membership changes, publish an invalidation on a Redis channel (or an in-process bus while single-instance) and force-disconnect affected sockets; belt-and-braces, re-verify roles hourly.

---

## 7. Project Structure

pnpm workspaces + Turborepo. The split exists so the solver and game data stay pure and testable, independent of React, Yjs, and the network.

```
satisfactory-colab-modeler/
├── apps/
│   ├── web/                    # Vite + React + TS + Tailwind
│   │   └── src/
│   │       ├── canvas/         # React Flow setup, node & edge components, waypoints
│   │       ├── panels/         # recipe chooser, summary panel, settings
│   │       ├── collab/         # Yjs provider, awareness, presence UI
│   │       ├── workers/        # solver worker host
│   │       └── routes/
│   ├── api/                    # Fastify: auth, projects, sharing, tickets
│   └── realtime/               # Hocuspocus server (co-deployed with api in one container)
├── packages/
│   ├── rational/               # BigInt exact rational arithmetic + parser/formatter
│   ├── gamedata/               # game_data.json → typed, indexed, validated; icon manifest
│   ├── solver/                 # the calculators. Pure functions. No DOM, no Yjs, no network.
│   ├── ydoc/                   # CRDT schema, mutation helpers, integrity reducer, migrations
│   └── shared/                 # zod schemas + types shared by web and api
├── resources/                  # reference material, unchanged
├── db/migrations/
├── infra/                      # Dockerfile, compose, deploy config
└── PLAN.md
```

Two boundaries worth defending:

- **`packages/solver` takes a plain snapshot and returns plain results.** No Yjs import, no DOM. That is what lets it run identically in a Web Worker, in Node tests, and — if we ever need it — on the server.
- **`packages/ydoc` is the only place that knows the CRDT shape.** Both `apps/web` and `apps/realtime` import it, so the client and the server's integrity pass can never drift apart.

### Key libraries

| Concern | Choice |
|---|---|
| Canvas | `@xyflow/react` (React Flow v12) |
| CRDT | `yjs`, `@hocuspocus/server`, `@hocuspocus/provider`, `y-indexeddb` |
| API | Fastify + `zod` |
| DB | `postgres.js` + Kysely (typed SQL, no heavy ORM over `bytea` blobs) |
| Styling | Tailwind CSS |
| State | Zustand for ephemeral UI state only — the document lives in Yjs |
| Rationals | Custom `BigInt`-backed type in `packages/rational` |

> **Why a custom rational type:** the solver needs exact `+ − × ÷` and comparison over arbitrary-precision fractions, with parsing of user input like `2 1/3` and canonical `n/d` formatting for storage. That is a small, well-understood, heavily-testable module — and depending on a library that quietly falls back to doubles would silently break the tool's central promise.

---

## 8. Phased Roadmap

**The single most important sequencing decision: build the canvas on a local Yjs document from day one** (Phase 2), with no server. Retrofitting a CRDT under an established Zustand store means rewriting every mutation, so paying the (small) cost upfront turns Phase 5 into mostly plumbing.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 · Foundations** | Monorepo, Vite/Tailwind/Fastify scaffold, Docker Compose with Postgres. `packages/rational` with full test coverage. `packages/gamedata` parsing `game_data.json` into typed indices (recipes-by-part, recipes-by-machine, MultiMachine resolution) with icon manifest. | `pnpm dev` runs; rational and gamedata suites green. |
| **1 · Auth & projects** | Discord OAuth2 end to end, sessions, `users`/`sessions`/`projects`/`project_members` migrations, project list UI, create/rename/delete. | Log in with Discord; create a project; see it after a restart. |
| **2 · Solo canvas editor** | React Flow canvas over a **local Yjs doc**. Recipe Chooser (double/right-click). Recipe nodes with ports, limit, clock ±, shards. Drag-to-connect. Marquee select, cut/copy/paste/delete. `Y.UndoManager` for undo/redo. Snap-to-grid. Waypoints with the documented gestures. Outposts with drill-in + breadcrumbs. Ferrumium-inspired visual pass, dark + light. | Build a multi-outpost factory in-browser; refresh loses it (no persistence yet). |
| **3 · Persistence** | Yjs ↔ Postgres: `project_doc_state` + `project_doc_updates`, debounced flush, compaction job, `y-indexeddb` cache, autosave indicator, `project_versions` snapshots. | Factory survives reload and server restart; a version can be restored. |
| **4 · Calculators** | `packages/solver`: **Manual**, **Basic**, **None** over exact rationals. Cancellable Web Worker + debounce + dirty-subgraph caching. Summary panel with scope selector. Red/orange value highlighting. Number-format settings. | Golden-value tests pass against known Satisfactory ratios; a ~200-node factory solves under 200 ms. |
| **5 · Multiplayer** | Hocuspocus server, ticket auth, roles, share-by-link + invites, presence avatars/cursors/selection, soft field indicators, integrity reducer on both ends, connection-status UI. | Two browsers edit one factory concurrently; concurrent delete-vs-connect converges with no dangling edges. |
| **6 · Full calculator** | Splitter/merger even-split preference and priority splitters/mergers as an exact-rational LP. Priority Splurger node type. Progress + STOP UI. Relational projection tables. | Full-mode results match the desktop tool on a shared benchmark set. |
| **7 · Polish & deploy** | Blueprints, auto-round, connection styles, minimap, i18n wiring (55 locales already in `resources/`), accessibility pass, production deploy, backups, error tracking. | Deployed, monitored, backed up. |

Phases 0–5 are the MVP. A rough sizing, assuming one developer: Phase 2 and Phase 5 are the two large ones, Phase 6 is the highest-variance.

---

## 9. Verification

- **Rationals** — property tests: `(a/b + c/d) − c/d == a/b` exactly; canonical form always reduced; round-trips through parse/format for `"2 1/3"`, `"-9/5"`, `"0.125"`.
- **Solver golden values** — assert against known-correct Satisfactory ratios computed by hand from `game_data.json`: 30 Iron Ore/min → 30 Iron Ingot/min; Miner Mk.3 on a Pure node = 480/min; Manufacturer with 4 somersloops = 2× output at 4× power; a Coal Generator chain's water draw. These are the tests that prove we read the data model correctly.
- **CRDT convergence fuzzing** — generate random concurrent operation sequences across N in-memory docs, apply in randomized orders, then assert (a) all docs are byte-identical and (b) every integrity invariant holds (no dangling edges, no orphaned nodes, shards within range).
- **Multiplayer end-to-end** — two browser contexts (Playwright, or the Browser MCP tools) on one project: concurrent node drags, simultaneous edits to different fields of the same machine, and the delete-vs-connect race. Assert convergence and that presence appears and clears.
- **Auth** — a Discord application with `http://localhost:5173/auth/discord/callback` registered; verify state mismatch is rejected, sessions expire, and a viewer's WebSocket is genuinely read-only (attempted writes must be dropped server-side, not merely hidden in the UI).
- **Performance budget** — a synthetic 500-node / 800-edge factory: interaction stays at 60 fps, Basic solve under 200 ms, and a Yjs update flush under 20 ms.

---

## 10. Open Questions

Decided in planning: **React Flow** for the canvas · **container host + managed Postgres** (Fly.io/Railway/Render) · **Manual + Basic first, Full in Phase 6** · **IndexedDB cache, online to edit**.

Still open — none block Phase 0, but the starred ones should be settled before the phase that needs them:

1. **★ Guest access (needed by Phase 1).** Ferrumium offers "try without registering." Do we want anonymous projects that later claim to a Discord account? It's cheap now (a nullable `owner_id` plus a claim flow) and awkward to retrofit once sharing exists.
2. **★ Node visual density (needed by Phase 2).** Satisfactory Modeler's nodes are dense — every part row shows a live number. Ferrumium's are cleaner cards. Do you want the full dense readout by default, or a compact node that expands on selection/hover? This is the single biggest UI-feel decision.
3. **★ Blueprint semantics (Phase 7, but affects the Phase 2 schema).** Blueprints multiply their contents by a solved copy count. Confirm the copy count should participate in the same solve rather than being a post-multiply — it changes whether the container needs a variable in the solver.
4. **`.sfmd` import.** Would let people bring existing desktop models over, and would be the strongest possible adoption lever. But the format is undocumented and the app is closed-source, so it means reverse-engineering a binary/serialized format from sample files. Worth it only if you have models to migrate — and I'd want a few sample `.sfmd` files to assess feasibility before committing.
5. **Game-data updates.** `game_data.json` is versioned per Satisfactory patch. When it changes, existing projects may reference recipes that no longer exist. Pin each project to a `game_data_version` (already in the schema) and offer an explicit migration, or auto-upgrade and flag broken nodes?
6. **Real-time comments/annotations.** In scope as a later phase, or not wanted?
7. **Attribution footer.** Community tools conventionally carry a short "not affiliated with Coffee Stain Studios" line alongside game-asset attribution. Want one?
8. **Project scale ceiling.** What's the largest factory you'd expect anyone to model? It sets the performance budget and decides whether the level-of-detail fallback is Phase 2 work or Phase 7 work.
