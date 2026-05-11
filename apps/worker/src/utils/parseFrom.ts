/**
 * Parse the RFC 5322 `From` header value into a display name and email address.
 *
 * Handles the following forms:
 *   "Smith, John" <john@example.com>   → { name: "Smith, John", address: "john@example.com" }
 *   Alice <alice@example.com>          → { name: "Alice",       address: "alice@example.com" }
 *   <alice@example.com>                → { name: null,          address: "alice@example.com" }
 *   alice@example.com                  → { name: null,          address: "alice@example.com" }
 *   "   " <alice@example.com>          → { name: null,          address: "alice@example.com" }
 *
 * Character classes ([^"]+, [^<]+, [^>]+) are used instead of lazy quantifiers
 * to avoid polynomial backtracking (ReDoS).
 *
 * Known limitation: RFC 2047 encoded words (=?UTF-8?Q?...?=) in display names
 * are returned as-is. Decode them at the presentation layer if needed.
 */
export function parseFrom(raw: string): { name: string | null; address: string } {
  // Quoted display name (handles commas and other special chars inside the quotes)
  const quotedMatch = raw.match(/^\s*"([^"]+)"\s*<([^>]+)>\s*$/);
  if (quotedMatch) {
    return { name: quotedMatch[1].trim() || null, address: quotedMatch[2].trim() };
  }
  // Unquoted or angle-bracket-only form: match everything before '<' (may be empty)
  // then the address inside '<...>'. When there is no display name, name becomes null.
  const unquotedMatch = raw.match(/^([^<]*)<([^>]+)>\s*$/);
  if (unquotedMatch) {
    return { name: unquotedMatch[1].trim() || null, address: unquotedMatch[2].trim() };
  }
  // Plain email address with no angle brackets
  return { name: null, address: raw.trim() };
}
