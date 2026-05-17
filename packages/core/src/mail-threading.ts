import type { InboundMailEnvelope } from './mail-envelope';

/**
 * Minimal parent-row shape required for thread resolution.
 * Both the ingest path (worker) and the rethreading path (database cron) use
 * this interface so threading policy lives in a single place.
 */
export interface ParentRecord {
  thread_id: string;
}

/**
 * Resolves the thread_id and needsRethreading flag for an inbound message.
 *
 * This is a pure function — no DB calls, fully unit-testable.
 *
 * Strategy:
 *   1. If inReplyTo is set and a matching parent is found in parentLookup,
 *      join the existing thread (needsRethreading = false).
 *   2. If inReplyTo is set but no parent found (out-of-order delivery), use
 *      inReplyTo as thread_id and flag for re-threading once the parent arrives.
 *   3. Root message (no inReplyTo): start a new thread keyed on
 *      messageId ?? fallbackId.
 *
 * @param envelope      - Normalized inbound mail envelope.
 * @param parentLookup  - Map of message_id → parent row, built from a DB lookup
 *                        by the caller before invoking this function.
 * @param fallbackId    - External email ID used as thread_id when messageId is
 *                        absent (e.g. the provider-assigned email ID).
 */
export function resolveThreadId(
  envelope: Pick<InboundMailEnvelope, 'messageId' | 'inReplyTo'>,
  parentLookup: Map<string, ParentRecord>,
  fallbackId: string,
): { threadId: string; needsRethreading: boolean } {
  if (envelope.inReplyTo) {
    const parent = parentLookup.get(envelope.inReplyTo);
    if (parent) {
      return { threadId: parent.thread_id, needsRethreading: false };
    }
    // Parent not yet received — use In-Reply-To as a temporary thread_id so
    // sibling out-of-order replies are grouped together. Flag for re-threading.
    return { threadId: envelope.inReplyTo, needsRethreading: true };
  }
  // Root message — start a new thread.
  return { threadId: envelope.messageId ?? fallbackId, needsRethreading: false };
}

/**
 * Resolves the parent row for an orphaned email during the rethreading sweep.
 *
 * This is a pure function — no DB calls, fully unit-testable.
 *
 * Checks in_reply_to first, then walks the References chain (in reverse order,
 * most-recent ancestor first) until a matching parent is found in the combined
 * lookup map.
 *
 * Callers should build the lookup by merging the in_reply_to parent-map and the
 * references ancestor-map into a single Map before calling this function.
 *
 * @param inReplyTo  - The orphan's In-Reply-To header value.
 * @param references - The orphan's References header (space-separated), or null.
 * @param lookup     - Combined map of message_id → parent row.
 * @returns The resolved parent row, or null if no parent has arrived yet.
 */
export function resolveOrphanThreadId(
  inReplyTo: string,
  references: string | null,
  lookup: Map<string, ParentRecord>,
): ParentRecord | null {
  const parent = lookup.get(inReplyTo);
  if (parent) return parent;

  if (references) {
    const refs = references.trim().split(/\s+/).reverse();
    for (const ref of refs) {
      const ancestor = lookup.get(ref);
      if (ancestor) return ancestor;
    }
  }

  return null;
}
