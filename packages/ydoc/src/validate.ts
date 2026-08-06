// Runtime shape validators. Used directly in this package's tests, and
// intended as the foundation the integrity reducer (Job 022) validates
// against before/while repairing a document — PLAN.md §5 lists "delete
// edges whose fromNode/toNode no longer exists," "clamp shards," etc., all
// of which start from knowing *which* records are malformed. This module
// only detects problems; it deliberately does not repair anything (that
// repair logic, including the `origin: 'integrity'`-tagged transaction, is
// Job 022's scope).
import { z } from "zod";
import type { DocumentSnapshot } from "./document";
import {
  ContainerSchema,
  EdgeRecordSchema,
  MetaSchema,
  NodeRecordSchema,
  SettingsSchema,
} from "./schema";

export function validateMeta(value: unknown) {
  return MetaSchema.safeParse(value);
}

export function validateSettings(value: unknown) {
  return SettingsSchema.safeParse(value);
}

export function validateContainer(value: unknown) {
  return ContainerSchema.safeParse(value);
}

export function validateNodeRecord(value: unknown) {
  return NodeRecordSchema.safeParse(value);
}

export function validateEdgeRecord(value: unknown) {
  return EdgeRecordSchema.safeParse(value);
}

export interface DocumentIssue {
  /** Dot/bracket path identifying the offending record, e.g. `nodes[3].limitMode` or `edges[1].fromNode`. */
  path: string;
  message: string;
}

export interface DocumentValidationResult {
  valid: boolean;
  issues: DocumentIssue[];
}

function zodIssuesToDocumentIssues(prefix: string, error: z.ZodError): DocumentIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? `${prefix}.${issue.path.join(".")}` : prefix,
    message: issue.message,
  }));
}

/**
 * Validates a whole document snapshot: shape-checks every record, plus the
 * referential-integrity checks PLAN.md §5 names explicitly (dangling edge
 * endpoints, orphaned containers/nodes, edges pointing at nonexistent
 * containers). Returns every issue found rather than throwing/short-
 * circuiting, since the integrity reducer needs the full list to repair in
 * one pass.
 */
export function validateDocumentSnapshot(snapshot: DocumentSnapshot): DocumentValidationResult {
  const issues: DocumentIssue[] = [];

  const metaResult = MetaSchema.safeParse(snapshot.meta);
  if (!metaResult.success) {
    issues.push(...zodIssuesToDocumentIssues("meta", metaResult.error));
  }

  const settingsResult = SettingsSchema.safeParse(snapshot.settings);
  if (!settingsResult.success) {
    issues.push(...zodIssuesToDocumentIssues("settings", settingsResult.error));
  }

  const containerIds = new Set(snapshot.containers.map((container) => container.id));
  snapshot.containers.forEach((container, index) => {
    const result = ContainerSchema.safeParse(container);
    if (!result.success) {
      issues.push(...zodIssuesToDocumentIssues(`containers[${index}]`, result.error));
    }
    if (container.parentId !== null && !containerIds.has(container.parentId)) {
      issues.push({
        path: `containers[${index}].parentId`,
        message: `parentId "${container.parentId}" does not reference an existing container`,
      });
    }
  });

  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  snapshot.nodes.forEach((node, index) => {
    const result = NodeRecordSchema.safeParse(node);
    if (!result.success) {
      issues.push(...zodIssuesToDocumentIssues(`nodes[${index}]`, result.error));
    }
    if (!containerIds.has(node.containerId)) {
      issues.push({
        path: `nodes[${index}].containerId`,
        message: `containerId "${node.containerId}" does not reference an existing container`,
      });
    }
  });

  snapshot.edges.forEach((edge, index) => {
    const result = EdgeRecordSchema.safeParse(edge);
    if (!result.success) {
      issues.push(...zodIssuesToDocumentIssues(`edges[${index}]`, result.error));
    }
    if (!containerIds.has(edge.containerId)) {
      issues.push({
        path: `edges[${index}].containerId`,
        message: `containerId "${edge.containerId}" does not reference an existing container`,
      });
    }
    if (!nodeIds.has(edge.fromNode)) {
      issues.push({
        path: `edges[${index}].fromNode`,
        message: `fromNode "${edge.fromNode}" does not reference an existing node`,
      });
    }
    if (!nodeIds.has(edge.toNode)) {
      issues.push({
        path: `edges[${index}].toNode`,
        message: `toNode "${edge.toNode}" does not reference an existing node`,
      });
    }
  });

  return { valid: issues.length === 0, issues };
}
