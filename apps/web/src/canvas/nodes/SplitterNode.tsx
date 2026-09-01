// The Splitter buildables — Conveyor Splitter (`splitterVariant: "basic"`),
// Smart Splitter (`"smart"`), Programmable Splitter (`"programmable"`).
// Always 1 input (`in:*`, left) / 3 outputs (`out:*slot0/1/2`, right,
// top-to-bottom) — see satisfactory.wiki.gg/wiki/Conveyor_Splitter et al.
// Port shape is now FIXED by node kind rather than inferred from wiring
// (contrast the old `SplurgerNode.tsx`, deleted): every Splitter always
// shows the same 1-in/3-out card regardless of how it's actually wired.
//
// Smart/Programmable each output slot carries an independently configured
// rule (`canvas/nodes/splitMergeConfig.ts`'s `SplitterSlotConfig`) — Any /
// None / Item / Any Undefined / Overflow — edited inline per slot. Smart
// restricts an Item rule to exactly one part; Programmable allows several
// (soft-warned, not blocked, past the wiki's 64-total cap). A Conveyor
// Splitter (`"basic"`) has no rule UI at all — every output is plain "Any".
//
// See `workers/splitMergePassthrough.ts`'s header for exactly how a slot's
// rule becomes a solver priority rank.
import { ArrowRight, X } from "lucide-react";
import { memo } from "react";

import { defaultGameData } from "@scm/gamedata";
import { getNode, listEdges, removeEdge, setPriorityOrder, type EdgeRecord, type NodeRecord } from "@scm/ydoc";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { WILDCARD_PART, isValidDragCandidate } from "../edges/connectionLogic";
import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";
import {
  decodeSplitterConfig,
  encodeSplitterConfig,
  splitterSlotConfig,
  wildcardSlot,
  type SlotIndex,
  type SplitterRule,
  type SplitterSlotConfig,
} from "./splitMergeConfig";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

const VARIANT_LABELS: Record<string, string> = {
  basic: "Conveyor Splitter",
  smart: "Smart Splitter",
  programmable: "Programmable Splitter",
};

const RULE_LABELS: Record<SplitterRule, string> = {
  any: "Any",
  none: "None",
  item: "Item",
  undefined: "Any Undefined",
  overflow: "Overflow",
};

const SLOTS: readonly SlotIndex[] = [0, 1, 2];
const SLOT_LABELS: Record<SlotIndex, string> = { 0: "Left", 1: "Center", 2: "Right" };
const MAX_PROGRAMMABLE_ITEMS = 64;

const sortedPartNames = [...defaultGameData.parts].map((p) => p.name).sort((a, b) => a.localeCompare(b));

export const SplitterNode = memo(function SplitterNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const maybeNode = data.record;
  if (!maybeNode) return null;
  const node: NodeRecord = maybeNode;
  const readOnly = Boolean(data.readOnly);

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(sfmDoc, fromHandle, { nodeId: id, id: handleId, type });
  }

  const variant = node.splitterVariant ?? "basic";
  const configurable = variant === "smart" || variant === "programmable";
  const config = configurable ? decodeSplitterConfig(node.priorityOrder) : new Map<SlotIndex, SplitterSlotConfig>();

  const allEdges = listEdges(sfmDoc);
  const inRows = allEdges.filter((e) => e.toNode === id);
  const outRowsBySlot = new Map<SlotIndex, EdgeRecord[]>(SLOTS.map((slot) => [slot, []]));
  for (const edge of allEdges) {
    if (edge.fromNode !== id) continue;
    const part = edge.fromPort.slice(edge.fromPort.indexOf(":") + 1);
    for (const slot of SLOTS) {
      if (part === wildcardSlot(slot)) outRowsBySlot.get(slot)!.push(edge);
    }
  }
  const outRows = SLOTS.flatMap((slot) => outRowsBySlot.get(slot)!);

  const inParts = new Set(inRows.map((e) => e.part));
  const outParts = new Set(outRows.map((e) => e.part));
  const danglingParts = [...new Set([...inParts, ...outParts])].filter(
    (part) => inParts.has(part) !== outParts.has(part),
  );

  function neighborTitle(edge: EdgeRecord, direction: "in" | "out"): string {
    const neighborId = direction === "in" ? edge.fromNode : edge.toNode;
    return getNode(sfmDoc, neighborId)?.title || neighborId;
  }

  function updateSlot(slot: SlotIndex, next: SplitterSlotConfig) {
    const nextConfig = new Map(config);
    nextConfig.set(slot, next);
    setPriorityOrder(sfmDoc, node.id, encodeSplitterConfig(nextConfig));
  }

  const totalItems = SLOTS.reduce<number>((sum, slot) => sum + splitterSlotConfig(config, slot).items.length, 0);

  return (
    <div
      className={`relative w-72 rounded-lg border-2 border-[var(--splurger-border)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "outline outline-2 outline-offset-2 outline-[var(--accent)]" : ""
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--splurger)]/90 text-[var(--accent-contrast)] shadow-inner overflow-hidden"
        >
          {getIconUrl("Smart Splitter") ? (
            <img src={getIconUrl("Smart Splitter")} alt="" className="h-5 w-5 object-contain" />
          ) : (
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{node.title || VARIANT_LABELS[variant]}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">{VARIANT_LABELS[variant]}</p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-1.5 px-3 py-3">
        <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
          <PortIcon parts={[...new Set(inRows.map((e) => e.part))]} />
          <Handle
            type="target"
            position={Position.Left}
            id={`in:${WILDCARD_PART}`}
            className={`${handleClass} ${isHandleFaded(`in:${WILDCARD_PART}`, "target") ? handleFadeClass : ""}`}
          />
        </div>

        <div className="flex flex-1 flex-col gap-1.5">
          {SLOTS.map((slot) => {
            const handleId = `out:${wildcardSlot(slot)}`;
            const slotRows = outRowsBySlot.get(slot)!;
            const slotConfig = splitterSlotConfig(config, slot);
            return (
              <div key={slot} className="flex items-center gap-1.5">
                <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                  <PortIcon parts={[...new Set(slotRows.map((e) => e.part))]} />
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={handleId}
                    className={`${handleClass} ${isHandleFaded(handleId, "source") ? handleFadeClass : ""}`}
                  />
                </div>
                {configurable && !readOnly ? (
                  <SlotRuleEditor
                    slotLabel={SLOT_LABELS[slot]}
                    config={slotConfig}
                    onChange={(next) => updateSlot(slot, next)}
                  />
                ) : (
                  <span className="text-[10px] text-[var(--text-muted)]">{SLOT_LABELS[slot]}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {variant === "programmable" && totalItems > MAX_PROGRAMMABLE_ITEMS && (
        <p className="mx-2 mb-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          {totalItems} items configured — the real Programmable Splitter caps at {MAX_PROGRAMMABLE_ITEMS} total.
        </p>
      )}

      {danglingParts.length > 0 && (
        <p className="mx-2 mb-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          {danglingParts.join(", ")} wired on only one side — connect the other side or remove it.
        </p>
      )}

      {(inRows.length > 0 || outRows.length > 0) && !readOnly && (
        <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] py-0.5">
          {inRows.map((edge) => (
            <ConnectionRow
              key={edge.id}
              edge={edge}
              label={neighborTitle(edge, "in")}
              isDangling={danglingParts.includes(edge.part)}
              onDisconnect={() => removeEdge(sfmDoc, edge.id)}
            />
          ))}
          {outRows.map((edge) => (
            <ConnectionRow
              key={edge.id}
              edge={edge}
              label={neighborTitle(edge, "out")}
              isDangling={danglingParts.includes(edge.part)}
              onDisconnect={() => removeEdge(sfmDoc, edge.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function PortIcon({ parts }: { parts: readonly string[] }) {
  if (parts.length === 0) {
    return (
      <div
        className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)]"
        aria-hidden
      >
        <span className="h-3 w-3 rounded-full border border-current" />
      </div>
    );
  }
  return (
    <div
      className="relative flex h-8 w-8 items-center justify-center rounded border border-[var(--splurger-border)] bg-[var(--surface-sunken)]"
      title={parts.join(", ")}
    >
      {getIconUrl(parts[0]!) ? (
        <img src={getIconUrl(parts[0]!)} alt="" className="h-6 w-6 object-contain" />
      ) : (
        <span className="h-5 w-5 rounded-sm bg-[var(--surface-hover)]" aria-hidden />
      )}
      {parts.length > 1 && (
        <span className="absolute -right-1 -top-1 rounded-full bg-[var(--splurger)] px-1 text-[9px] font-medium text-[var(--accent-contrast)]">
          +{parts.length - 1}
        </span>
      )}
    </div>
  );
}

interface SlotRuleEditorProps {
  slotLabel: string;
  config: SplitterSlotConfig;
  onChange: (next: SplitterSlotConfig) => void;
}

/** Inline rule picker for one Smart/Programmable Splitter output — a rule `<select>`, plus an item-picker + chip list when the rule is `"item"`. */
function SlotRuleEditor({ slotLabel, config, onChange }: SlotRuleEditorProps) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <span className="w-11 shrink-0 text-[10px] text-[var(--text-muted)]">{slotLabel}</span>
        <select
          className="nodrag min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1 py-0.5 text-[10px] text-[var(--text-primary)]"
          value={config.rule}
          onChange={(e) => onChange({ rule: e.target.value as SplitterRule, items: [] })}
        >
          {(Object.keys(RULE_LABELS) as SplitterRule[]).map((rule) => (
            <option key={rule} value={rule}>
              {RULE_LABELS[rule]}
            </option>
          ))}
        </select>
      </div>
      {config.rule === "item" && (
        <div className="ml-12 mt-1 flex flex-wrap items-center gap-1">
          {config.items.map((item) => (
            <span
              key={item}
              className="flex items-center gap-0.5 rounded bg-[var(--surface-sunken)] px-1 py-0.5 text-[9px] text-[var(--text-primary)]"
            >
              {item}
              <button
                type="button"
                className="nodrag text-[var(--text-muted)] hover:text-[var(--danger)]"
                aria-label={`Remove ${item}`}
                onClick={() => onChange({ ...config, items: config.items.filter((i) => i !== item) })}
              >
                <X className="h-2.5 w-2.5" aria-hidden />
              </button>
            </span>
          ))}
          <select
            className="nodrag rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1 py-0.5 text-[9px] text-[var(--text-primary)]"
            value=""
            onChange={(e) => {
              const chosen = e.target.value;
              if (!chosen) return;
              const alreadyHas = config.items.includes(chosen);
              const items = alreadyHas ? config.items : [...config.items, chosen];
              onChange({ ...config, items });
            }}
          >
            <option value="">+ item…</option>
            {sortedPartNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

interface ConnectionRowProps {
  edge: EdgeRecord;
  label: string;
  isDangling: boolean;
  onDisconnect: () => void;
}

function ConnectionRow({ edge, label, isDangling, onDisconnect }: ConnectionRowProps) {
  const iconUrl = getIconUrl(edge.part);
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)] ${
        isDangling ? "bg-[var(--danger-soft)]" : ""
      }`}
      title={isDangling ? `${edge.part} has nothing on the other side — not routed` : undefined}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5" />
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
        {edge.part}
        <span className="ml-1 text-[var(--text-muted)]">({label})</span>
      </span>
      <button
        type="button"
        title="Disconnect"
        aria-label={`Disconnect ${edge.part} connection`}
        onClick={onDisconnect}
        className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
