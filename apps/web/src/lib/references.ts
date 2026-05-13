/** Maximum number of Message-IDs to include in a References header (RFC 2822). */
export const MAX_REFERENCES_IDS = 12;

/** Maximum byte length for the References header value. */
export const MAX_REFERENCES_BYTES = 2000;

/**
 * Builds the RFC 2822 References header value for a reply.
 *
 * The References chain must be contiguous — mail clients rely on it to
 * reconstruct thread trees. The algorithm therefore:
 *   1. Preserves the root (first) Message-ID unconditionally.
 *   2. Deduplicates the full chain (order-preserving, first occurrence wins).
 *   3. Trims the tail to at most MAX_REFERENCES_IDS − 1 entries (most recent).
 *   4. Walks backward from newest to oldest and stops on the first ID that
 *      would exceed MAX_REFERENCES_BYTES — "first violation terminates" keeps
 *      the retained segment contiguous, which is preferable to a sparse chain
 *      for threading clients.
 *
 * Byte counting uses String.prototype.length because RFC 5322 §3.6.4
 * restricts Message-ID production to printable US-ASCII characters, making
 * the UTF-16 code unit count equal to the byte count.
 *
 * @internal Used by buildEmailHeaders in route.ts; not part of the public API.
 */
export function buildReferencesHeader(
  replyToId?: string,
  references?: string
): string | null {
  if (!replyToId) return null;
  // Append replyToId to the existing chain, or seed the chain when there is
  // no prior References value (e.g. the parent is the thread root).
  const chain = references
    ? `${references} ${replyToId}`
    : replyToId;

  // Deduplicate while preserving order (first occurrence wins). This handles
  // both root-in-tail duplicates and any repeated non-root Message-IDs that
  // may appear due to buggy upstream clients.
  const seen = new Set<string>();
  const ids = chain.split(/\s+/).filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (ids.length === 0) return null;

  const rootId = ids[0];
  const tail = ids.slice(1);

  const maxTailIds = Math.max(0, MAX_REFERENCES_IDS - 1);
  const selectedTail = maxTailIds > 0 ? tail.slice(-maxTailIds) : [];

  // Walk newest → oldest; stop on the first ID that would overflow the cap.
  // "First violation terminates" is intentional: it keeps the retained segment
  // contiguous rather than producing a sparse chain with gaps, which would
  // confuse threading clients that reconstruct the tree by following the chain
  // in order.
  let byteCount = rootId.length;
  const cappedTail: string[] = [];
  for (let i = selectedTail.length - 1; i >= 0; i--) {
    const next = 1 + selectedTail[i].length; // space + id
    if (byteCount + next > MAX_REFERENCES_BYTES) break;
    cappedTail.unshift(selectedTail[i]);
    byteCount += next;
  }

  return [rootId, ...cappedTail].join(' ');
}
