// Job 026 (Blueprints, PLAN.md §10.3): how a `kind: "blueprint"` container
// renders from *outside* itself — a close sibling of `OutpostNode.tsx`
// (Job 013), not a redesign: a blueprint IS an outpost underneath (same
// `Container.kind` union, same derived port-mapping mechanism —
// `data.ports` is `outposts/portMapping.ts`'s `computeOutpostPorts`,
// unchanged from what a plain outpost already uses), so this file only
// adds what's actually DIFFERENT: the `--blueprint` teal accent (see
// `index.css`'s token comment) instead of `--outpost` amber, and the
// computed COPY COUNT readout + an editable `copiesLimit` cap field.
//
// The copy count itself comes from `useSolverResult()`'s `nodeResultById`,
// looked up by `blueprintCompoundNodeId(container.id)` — see
// `apps/web/src/workers/blueprintCollapse.ts`'s header for the full "how
// PLAN.md §10.3 was resolved" writeup. This card never computes anything
// itself; it just displays whatever the live solve already produced, same
// as `RecipeNode.tsx` does for a real node's machine count.
import { memo, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { formatRational, parseRational, toFractionString } from "@scm/rational";
import { updateContainer } from "@scm/ydoc";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { getBlueprintIconUrl } from "../../assets/icons";
import { useRemotePresence } from "../../collab";
import { blueprintCompoundNodeId } from "../../workers";
import { useCanvasDoc } from "../CanvasDocContext";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";

const blueprintIconUrl = getBlueprintIconUrl();

const inHandleClass = "!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--blueprint)]";
const outHandleClass = "!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--blueprint)]";

/** A tiny committed-on-blur/Enter numeric field for `Container.copiesLimit` — mirrors `RecipeNode.tsx`'s `useCommittedTextField` pattern (local text while focused, commit on blur/Enter, revert on a failed parse) at a scale not worth extracting a shared hook for two call sites. */
function useCopiesLimitField(container: { id: string; copiesLimit: number | null }, sfmDoc: Parameters<typeof updateContainer>[0]) {
  const displayText = container.copiesLimit === null ? "" : String(container.copiesLimit);
  const [text, setText] = useState(displayText);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(displayText);
  }, [displayText]);

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      updateContainer(sfmDoc, container.id, { copiesLimit: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      setText(displayText); // revert — same "don't leave garbage behind" convention as RecipeNode's limit/clock fields.
      return;
    }
    updateContainer(sfmDoc, container.id, { copiesLimit: n });
  }

  return {
    value: text,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      commit(text);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        setText(displayText);
        event.currentTarget.blur();
      }
    },
  };
}

export const BlueprintNode = memo(function BlueprintNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc, navigateToContainer, awareness } = useCanvasDoc();
  const remotePresence = useRemotePresence(awareness);
  const remoteSelectors = remotePresence.filter((peer) => peer.state.selection.includes(id));
  const { nodeResultById, staleness } = useSolverResult();
  const numberFormats = useSettings(sfmDoc).numberFormats;
  const container = data.container;
  // Defensive only — `containerToBlueprintFlowNode` always sets `data.container` for a `type: "blueprint"` node.
  if (!container) return null;
  const ports = data.ports ?? [];

  const copiesResult = nodeResultById.get(blueprintCompoundNodeId(container.id));
  const copiesLimitField = useCopiesLimitField(container, sfmDoc);

  function open() {
    navigateToContainer(container!.id);
  }

  return (
    <div
      className={`w-60 cursor-grab rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors active:cursor-grabbing ${
        selected ? "border-[var(--accent)]" : "border-[var(--blueprint-border)]"
      } ${staleness === "stale-recomputing" ? "opacity-60" : ""}`}
      style={
        remoteSelectors.length > 0
          ? { boxShadow: `0 0 0 3px ${remoteSelectors[0]!.state.color}` }
          : undefined
      }
      onDoubleClick={open}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        {blueprintIconUrl ? (
          <img
            src={blueprintIconUrl}
            alt=""
            className="h-6 w-6 shrink-0 rounded-md bg-black/20 object-contain p-0.5 shadow-inner"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--blueprint)]/90 text-xs font-bold text-[var(--accent-contrast)] shadow-inner"
          >
            BP
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{container.title || "Blueprint"}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">Blueprint · double-click to open</p>
        </div>
        <button
          type="button"
          className="nodrag shrink-0 rounded-md border border-[var(--blueprint-border)] bg-[var(--blueprint-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--node-header-text)] hover:brightness-110"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
          title="Open this blueprint"
        >
          Open →
        </button>
      </div>

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {ports.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
            No connections cross this blueprint&apos;s boundary yet.
          </p>
        ) : (
          ports.map((port) => (
            <div
              key={port.id}
              className="relative flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)]"
            >
              {port.direction === "in" && (
                <Handle type="target" position={Position.Left} id={port.id} className={inHandleClass} />
              )}
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                {port.direction === "in" ? "→ " : ""}
                {port.part}
                {port.direction === "out" ? " →" : ""}
              </span>
              {port.direction === "out" && (
                <Handle type="source" position={Position.Right} id={port.id} className={outHandleClass} />
              )}
            </div>
          ))
        )}
      </div>

      <div
        className="space-y-1.5 border-t border-[var(--border-subtle)] px-2 py-1.5 text-[11px]"
        title={
          copiesResult
            ? `Exact copy count: ${toFractionString(parseRational(copiesResult.machineCount))}`
            : "No solve result yet — switch to Basic or Full mode and connect a boundary port to see the computed copy count."
        }
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-secondary)]">Copies</span>
          <span className="tabular-nums font-medium text-[var(--blueprint)]">
            {copiesResult
              ? `${formatRational(parseRational(copiesResult.machineCount), numberFormats)}${
                  copiesResult.resolved ? "" : " (unresolved — defaulted)"
                }`
              : "—"}
          </span>
        </div>
        <label className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-secondary)]" title="Container.copiesLimit — caps how many copies may be placed; leave blank for no cap.">
            Copies limit
          </span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="none"
            className="nodrag w-14 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-right text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            {...copiesLimitField}
            // The card's own root div has `onDoubleClick={open}` (drill in,
            // same gesture `OutpostNode.tsx` uses) — a double/triple-click
            // while editing this field (e.g. to select-all before typing) is
            // a genuine risk since a double-click event bubbles right past
            // this input to that handler. Discovered live in this job's own
            // manual browser verification: a triple-click on this field
            // navigated INTO the blueprint mid-edit instead of selecting its
            // text. `RecipeNode.tsx`'s fields never needed this — its card
            // has no double-click-to-navigate gesture at all.
            onDoubleClick={(event) => event.stopPropagation()}
          />
        </label>
      </div>
    </div>
  );
});
