// Job 008: the React Flow canvas mounted for a single project, backed by a
// fresh, local, in-memory `@scm/ydoc` document. No fetch, no persistence —
// every reload starts a brand-new empty document (Job 015 adds loading a
// real one from the server). No game data, no Recipe Chooser, no real node
// visuals — see jobs/008-canvas-skeleton.md's Scope section.
import { useMemo } from "react";

import { type SfmDocument, addContainer, createDocument } from "@scm/ydoc";
import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CanvasDocContext, type CanvasDocContextValue } from "./CanvasDocContext";
import { DevNodeTools } from "./DevNodeTools";
import { useYjsSync } from "./useYjsSync";

interface CanvasViewProps {
  /** Route param identifying the project — display-only in this job; nothing is fetched from it yet (no backend involvement, per Job 008's scope). */
  projectTitle: string;
  projectShortId: string;
  onBack: () => void;
}

/**
 * Builds a brand-new local document plus its root container. Every node
 * created in this job's scope (there's no outpost UI yet — Job 013) lives
 * directly in this root container, so its id is threaded through
 * `CanvasDocContext` as `containerId` for `addNode` calls to use.
 */
function createLocalCanvasDocument(): CanvasDocContextValue {
  const sfmDoc = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, containerId: root.id };
}

export function CanvasView({ projectTitle, projectShortId, onBack }: CanvasViewProps) {
  // `useMemo` with no deps: exactly one document is created for the
  // lifetime of this component instance. (Not `useState(() => ...)` only
  // because nothing here ever needs to *replace* the document — a project
  // switch unmounts this component and mounts a new one via `App.tsx`'s
  // `key`-ed view switch, which is what should create a fresh doc.)
  const docContext = useMemo(createLocalCanvasDocument, []);
  const { sfmDoc } = docContext;

  // Dev-only escape hatch matching this job's acceptance criteria wording
  // ("verify by reading the doc state after a drag in a test or dev
  // console"): exposes the live document on `window` so `listNodes(window
  // .__sfmDoc)` (import `listNodes` from `@scm/ydoc` in the console, or just
  // inspect `window.__sfmDoc.nodes.toJSON()`) works without any extra
  // tooling. Stripped from production builds by Vite's `import.meta.env.DEV`
  // dead-code elimination.
  if (import.meta.env.DEV) {
    (window as unknown as { __sfmDoc?: SfmDocument }).__sfmDoc = sfmDoc;
  }

  const { nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop } = useYjsSync(sfmDoc);

  return (
    <CanvasDocContext.Provider value={docContext}>
      <div className="flex h-svh w-full flex-col">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div className="min-w-0">
            <button type="button" onClick={onBack} className="text-xs text-neutral-400 underline hover:text-neutral-200">
              ← Back to projects
            </button>
            <h2 className="truncate text-sm font-medium text-neutral-200">{projectTitle}</h2>
          </div>
          <span className="shrink-0 text-xs text-neutral-500">
            {projectShortId} · local in-memory document, not saved (Job 015)
          </span>
        </div>

        <div className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
            <DevNodeTools />
          </ReactFlow>
        </div>
      </div>
    </CanvasDocContext.Provider>
  );
}
