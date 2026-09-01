// The Splitter/Merger buildables' own routing logic, built on top of the
// generic engine in `passthroughRouting.ts`. Covers:
//   - Conveyor Splitter / Conveyor Merger (`splitterVariant`/`mergerVariant`
//     `"basic"`): no per-port configuration at all, every port shares one
//     fair pool (rank 0) — the plain max-min-fair split/merge the wiki
//     describes ("splits items between its outputs in sequence"/"merges...
//     evenly").
//   - Smart Splitter / Programmable Splitter (`"smart"`/`"programmable"`):
//     each of the 3 output slots independently rules Any / None / Item /
//     Any Undefined / Overflow. Every rule except Overflow gets rank 0
//     (drains first); Overflow gets rank 1 (only what rank 0 couldn't take).
//     `"none"` slots never carry an edge at all (blocked at connect time by
//     `canvas/edges/connectionLogic.ts`'s `isSplitterMergerConnectionAllowed`),
//     so they never appear in a part-group to rank.
//
//     SIMPLIFICATION, documented rather than hidden: the wiki's Item rule
//     claims its item EXCLUSIVELY away from Any/Any-Undefined outputs (an
//     Any output gets zero of an item some other output's Item rule already
//     claims). This module does not model that cross-port exclusivity — an
//     output's rank depends only on ITS OWN rule, not on what other outputs
//     are configured for the same part. In the overwhelmingly common case
//     (exactly one wire per distinct part, landing on whichever single
//     output is actually configured for it) this is behaviorally identical;
//     it only under-models the unusual case of the SAME part being wired to
//     both an Item output and a separate Any/Undefined output at once, which
//     would fair-share between them here instead of routing 100% to the Item
//     output. Flagged as a known scope simplification, not attempted here.
//   - Priority Merger (`"priority"`): each of the 3 input slots
//     independently set to High/Medium/Low, ranks 0/1/2 respectively —
//     genuine 3-tier lexicographic draining (`@scm/solver`'s N-ary
//     `PriorityTier`).
//
// No `@scm/ydoc`/React import — plain data in, plain data out, matching
// `passthroughRouting.ts`'s own discipline. Slot parsing/config decoding
// itself lives in `canvas/nodes/splitMergeConfig.ts` (shared, dependency-free)
// so this module and `connectionLogic.ts`'s connection-legality gate don't
// need to import from each other.
import {
  decodeMergerConfig,
  decodeSplitterConfig,
  MERGER_PRIORITY_RANK,
  mergerSlotPriority,
  parseWildcardSlot,
  splitterSlotConfig,
  type MergerPriority,
  type SlotIndex,
} from "../canvas/nodes/splitMergeConfig";
import type { PassthroughEdgeLike, PassthroughNode } from "./passthroughRouting";

export interface SplitterNodeLike {
  readonly id: string;
  readonly splitterVariant: "basic" | "smart" | "programmable" | null;
  readonly priorityOrder: readonly string[];
}

export interface MergerNodeLike {
  readonly id: string;
  readonly mergerVariant: "basic" | "priority" | null;
  readonly priorityOrder: readonly string[];
}

/** `fromPort`/`toPort` are full handle ids (`"out:*slot1"`, `"in:*slot0"`) — strip the `"<dir>:"` prefix before parsing the slot itself. */
function slotOfPort(port: string): SlotIndex | null {
  return parseWildcardSlot(port.slice(port.indexOf(":") + 1));
}

export function splitterPassthroughNode(node: SplitterNodeLike): PassthroughNode {
  const config =
    node.splitterVariant === "smart" || node.splitterVariant === "programmable"
      ? decodeSplitterConfig(node.priorityOrder)
      : null;

  return {
    id: node.id,
    resolveRanks(_part: string, inputs: readonly PassthroughEdgeLike[], outputs: readonly PassthroughEdgeLike[]) {
      // Structurally a splitter only ever has 1 input port, but defensively
      // guard the crossbar shape same as every other passthrough node.
      if (inputs.length > 1 && outputs.length > 1) return "unsupported";
      const inputRanks = new Map(inputs.map((e) => [e.id, 0]));
      const outputRanks = new Map<string, number>();
      for (const output of outputs) {
        if (!config) {
          outputRanks.set(output.id, 0);
          continue;
        }
        const slot = slotOfPort(output.fromPort);
        const rule = slot !== null ? splitterSlotConfig(config, slot).rule : "any";
        outputRanks.set(output.id, rule === "overflow" ? 1 : 0);
      }
      return { inputRanks, outputRanks };
    },
  };
}

export function mergerPassthroughNode(node: MergerNodeLike): PassthroughNode {
  const config = node.mergerVariant === "priority" ? decodeMergerConfig(node.priorityOrder) : null;

  return {
    id: node.id,
    resolveRanks(_part: string, inputs: readonly PassthroughEdgeLike[], outputs: readonly PassthroughEdgeLike[]) {
      if (inputs.length > 1 && outputs.length > 1) return "unsupported";
      const outputRanks = new Map(outputs.map((e) => [e.id, 0]));
      const inputRanks = new Map<string, number>();
      for (const input of inputs) {
        if (!config) {
          inputRanks.set(input.id, 0);
          continue;
        }
        const slot = slotOfPort(input.toPort);
        const priority: MergerPriority = slot !== null ? mergerSlotPriority(config, slot) : "medium";
        inputRanks.set(input.id, MERGER_PRIORITY_RANK[priority]);
      }
      return { inputRanks, outputRanks };
    },
  };
}
