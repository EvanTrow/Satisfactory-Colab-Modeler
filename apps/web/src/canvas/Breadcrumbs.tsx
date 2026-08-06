// Job 013: the breadcrumb trail ("drill in to edit contents... a
// breadcrumb trail" per this job's own Scope wording). Pure presentation —
// all the actual path-walking logic lives in `outposts/breadcrumbs.ts`'s
// `computeBreadcrumbPath`, unit-tested on its own.
import type { Container } from "@scm/ydoc";

import { computeBreadcrumbPath } from "./outposts";

export interface BreadcrumbsProps {
  /** The whole document's containers — `computeBreadcrumbPath` walks a `parentId` chain that isn't limited to what's currently rendered. */
  containers: Container[];
  currentContainerId: string;
  onNavigate: (containerId: string) => void;
}

export function Breadcrumbs({ containers, currentContainerId, onNavigate }: BreadcrumbsProps) {
  const path = computeBreadcrumbPath(currentContainerId, containers);

  return (
    <nav className="flex min-w-0 items-center gap-1 text-xs" aria-label="Container breadcrumb">
      {path.map((container, index) => {
        const isCurrent = container.id === currentContainerId;
        return (
          <span key={container.id} className="flex shrink-0 items-center gap-1">
            {index > 0 && <span className="text-neutral-600">/</span>}
            <button
              type="button"
              onClick={() => onNavigate(container.id)}
              disabled={isCurrent}
              className={
                isCurrent
                  ? "rounded px-1.5 py-0.5 font-medium text-neutral-100"
                  : "rounded px-1.5 py-0.5 text-neutral-400 hover:text-neutral-200 hover:underline"
              }
            >
              {container.title || (container.kind === "root" ? "Root" : "Outpost")}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
