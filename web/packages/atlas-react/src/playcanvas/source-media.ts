import type { Island } from '@exulanica/atlas-core';

/**
 * Presentation metadata for an evidence handle. The handle remains the authority: this catalog
 * only tells the renderer whether it may show a source fragment and where the caller exposes it.
 * Production can populate this from authenticated evidence URLs without moving evidence policy
 * into the renderer.
 */
export interface SourceMediaDescriptor {
  readonly evidenceRef: string;
  readonly title: string;
  readonly capturedLabel: string;
  readonly url: string | null;
  readonly available: boolean;
  readonly accent: string;
  readonly alt: string;
}

export type SourceMediaCatalog = ReadonlyMap<string, SourceMediaDescriptor>;

/** Distinct sources attached to a memory, preserving anchor/evidence order. */
export function sourceMediaForIsland(
  island: Island,
  catalog: SourceMediaCatalog,
): readonly SourceMediaDescriptor[] {
  const found: SourceMediaDescriptor[] = [];
  const seen = new Set<string>();
  for (const anchor of island.anchors) {
    for (const evidenceRef of anchor.evidence) {
      const descriptor = catalog.get(evidenceRef as string);
      if (descriptor === undefined) continue;
      const identity = descriptor.url ?? descriptor.evidenceRef;
      if (seen.has(identity)) continue;
      seen.add(identity);
      found.push(descriptor);
    }
  }
  return Object.freeze(found);
}
