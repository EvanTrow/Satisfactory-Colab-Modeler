// Pure, dependency-free port/slot model shared by the Splitter/Merger
// buildables' connection logic (`canvas/edges/connectionLogic.ts`), solver
// routing (`workers/splitMergePassthrough.ts`), and node UI
// (`canvas/nodes/SplitterNode.tsx`/`MergerNode.tsx`) — kept in its own module
// (rather than living in any one of those) specifically so none of them have
// to import from each other to share it (`connectionLogic.ts`'s connection
// legality gate and `splitMergePassthrough.ts`'s solver routing both need
// the exact same slot-parsing/config-decoding logic).

export type SlotIndex = 0 | 1 | 2;

/** A splitter's 3 output handles / a merger's 3 input handles — each its own wildcard sentinel (see `connectionLogic.ts`'s `isWildcardPart`), distinguishable by position rather than by tier the way the old Splurger's `*top`/`*bottom` were. */
export function wildcardSlot(slot: SlotIndex): string {
  return `*slot${slot}`;
}

export function parseWildcardSlot(part: string): SlotIndex | null {
  const match = /^\*slot([0-2])$/.exec(part);
  if (!match) return null;
  return Number(match[1]) as SlotIndex;
}

// ---------------------------------------------------------------------------
// Splitter output-port configuration.
// ---------------------------------------------------------------------------

export type SplitterRule = "any" | "none" | "item" | "undefined" | "overflow";

export interface SplitterSlotConfig {
  readonly rule: SplitterRule;
  /** Only meaningful for `rule === "item"` — the exact part name(s) this output accepts. Smart Splitter UI restricts this to length 1; Programmable Splitter allows several. */
  readonly items: readonly string[];
}

const DEFAULT_SPLITTER_SLOT: SplitterSlotConfig = { rule: "any", items: [] };

/** One `NodeRecord.priorityOrder` entry per configured slot: `"<slot>:any"`, `"<slot>:none"`, `"<slot>:undefined"`, `"<slot>:overflow"`, or `"<slot>:item:<Part A>,<Part B>,..."`. A slot with no entry defaults to `"any"`. */
export function decodeSplitterConfig(priorityOrder: readonly string[]): ReadonlyMap<SlotIndex, SplitterSlotConfig> {
  const config = new Map<SlotIndex, SplitterSlotConfig>();
  for (const token of priorityOrder) {
    const [slotStr, rule, itemsStr] = token.split(":");
    const slot = Number(slotStr);
    if (slot !== 0 && slot !== 1 && slot !== 2) continue;
    if (rule === "any" || rule === "none" || rule === "undefined" || rule === "overflow") {
      config.set(slot, { rule, items: [] });
    } else if (rule === "item") {
      const items = itemsStr ? itemsStr.split(",").filter((s) => s.length > 0) : [];
      config.set(slot, { rule: "item", items });
    }
  }
  return config;
}

export function encodeSplitterConfig(config: ReadonlyMap<SlotIndex, SplitterSlotConfig>): string[] {
  const entries: string[] = [];
  for (const slot of [0, 1, 2] as const) {
    const slotConfig = config.get(slot);
    if (!slotConfig) continue;
    if (slotConfig.rule === "item") {
      entries.push(`${slot}:item:${slotConfig.items.join(",")}`);
    } else {
      entries.push(`${slot}:${slotConfig.rule}`);
    }
  }
  return entries;
}

export function splitterSlotConfig(
  config: ReadonlyMap<SlotIndex, SplitterSlotConfig>,
  slot: SlotIndex,
): SplitterSlotConfig {
  return config.get(slot) ?? DEFAULT_SPLITTER_SLOT;
}

/** Programmable Splitter's wiki-documented defaults: center output Any, left/right None. Smart Splitter and both `"basic"` variants need no entries at all (the plain `DEFAULT_SPLITTER_SLOT` covers every slot). */
export function programmableSplitterDefaults(): ReadonlyMap<SlotIndex, SplitterSlotConfig> {
  return new Map([
    [0, { rule: "none", items: [] }],
    [1, { rule: "any", items: [] }],
    [2, { rule: "none", items: [] }],
  ]);
}

// ---------------------------------------------------------------------------
// Merger input-port configuration.
// ---------------------------------------------------------------------------

export type MergerPriority = "high" | "medium" | "low";

export const MERGER_PRIORITY_RANK: Record<MergerPriority, number> = { high: 0, medium: 1, low: 2 };

/** One `NodeRecord.priorityOrder` entry per configured slot: `"<slot>:high"` / `"medium"` / `"low"`. A slot with no entry defaults to `"medium"`. */
export function decodeMergerConfig(priorityOrder: readonly string[]): ReadonlyMap<SlotIndex, MergerPriority> {
  const config = new Map<SlotIndex, MergerPriority>();
  for (const token of priorityOrder) {
    const [slotStr, priority] = token.split(":");
    const slot = Number(slotStr);
    if (slot !== 0 && slot !== 1 && slot !== 2) continue;
    if (priority === "high" || priority === "medium" || priority === "low") config.set(slot, priority);
  }
  return config;
}

export function encodeMergerConfig(config: ReadonlyMap<SlotIndex, MergerPriority>): string[] {
  const entries: string[] = [];
  for (const slot of [0, 1, 2] as const) {
    const priority = config.get(slot);
    if (priority) entries.push(`${slot}:${priority}`);
  }
  return entries;
}

export function mergerSlotPriority(config: ReadonlyMap<SlotIndex, MergerPriority>, slot: SlotIndex): MergerPriority {
  return config.get(slot) ?? "medium";
}
