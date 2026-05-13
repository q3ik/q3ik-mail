import { describe, it, expect } from 'vitest';
import {
  buildReferencesHeader,
  MAX_REFERENCES_IDS,
  MAX_REFERENCES_BYTES,
} from '../references';

describe('buildReferencesHeader', () => {
  it('returns null when replyToId is absent', () => {
    expect(buildReferencesHeader(undefined, '<root@example.com>')).toBeNull();
    expect(buildReferencesHeader(undefined)).toBeNull();
    expect(buildReferencesHeader('')).toBeNull();
  });

  it('uses replyToId alone when references is absent', () => {
    expect(buildReferencesHeader('<a@example.com>')).toBe('<a@example.com>');
  });

  it('appends replyToId to an existing chain', () => {
    expect(
      buildReferencesHeader('<c@example.com>', '<a@example.com> <b@example.com>')
    ).toBe('<a@example.com> <b@example.com> <c@example.com>');
  });

  it('deduplicates all IDs, not just root (first occurrence wins)', () => {
    // Root appears twice in tail, and a non-root ID also repeats.
    expect(
      buildReferencesHeader(
        '<d@example.com>',
        '<a@example.com> <b@example.com> <a@example.com> <b@example.com> <c@example.com>'
      )
    ).toBe('<a@example.com> <b@example.com> <c@example.com> <d@example.com>');
  });

  it('truncates to MAX_REFERENCES_IDS keeping root and most recent', () => {
    // Build a chain with 1 root + 13 middle IDs + 1 replyToId = 15 total.
    // MAX_REFERENCES_IDS = 12, so we keep root + 11 most-recent tail IDs.
    const root = '<root@example.com>';
    const mid = Array.from(
      { length: 13 },
      (_, i) => `<mid-${i + 1}@example.com>`
    );
    const replyToId = '<reply@example.com>';

    const result = buildReferencesHeader(replyToId, [root, ...mid].join(' '));

    // tail = [mid-1..mid-13, reply] (14 entries)
    // selectedTail = last 11 = tail[3..13] = [mid-4..mid-13, reply]
    // mid.slice(3) = [mid-4..mid-13] (10 entries from mid)
    const expectedTail = [...mid.slice(3), replyToId];
    expect(result).toBe([root, ...expectedTail].join(' '));
    expect(result!.split(' ')).toHaveLength(MAX_REFERENCES_IDS);
  });

  it('enforces byte-length cap stopping at first overflow (contiguous segment)', () => {
    // Each ID: "<" + "x".repeat(200) + "-" + 3-digit suffix + "@example.com" + ">"
    //        = 1 + 200 + 1 + 3 + 12 + 1 = 218 chars (ASCII, so 218 bytes).
    // 10 IDs total: 218 + 9*(1+218) = 218 + 9*219 = 2189 bytes > MAX_REFERENCES_BYTES.
    // 9 IDs total: 218 + 8*219 = 1970 bytes < MAX_REFERENCES_BYTES.
    // All 10 IDs are below MAX_REFERENCES_IDS (12), so only the byte cap fires.
    const makeId = (n: number) =>
      `<${'x'.repeat(200)}-${String(n).padStart(3, '0')}@example.com>`;

    const root = makeId(0);
    const tailIds = Array.from({ length: 8 }, (_, i) => makeId(i + 1));
    const replyToId = makeId(9);
    const references = [root, ...tailIds].join(' ');

    const result = buildReferencesHeader(replyToId, references);

    // makeId(1) is the oldest tail entry; the loop hits it last and breaks.
    // Expected: root + makeId(2)..makeId(9) = 9 IDs, 1970 bytes.
    const expected = [root, ...Array.from({ length: 8 }, (_, i) => makeId(i + 2))];
    expect(result).toBe(expected.join(' '));
    expect(result!.length).toBeLessThanOrEqual(MAX_REFERENCES_BYTES);
  });

  it('stops at first byte-cap overflow — older fitting IDs beyond the first violation are excluded (contiguous-segment invariant)', () => {
    // Chain: root, small-1, small-2, huge, small-3, small-4 + replyToId (small-5).
    // All small IDs are ~10 chars; huge is ~1994 chars.
    // Iterating newest→oldest: small-5, small-4, small-3 all fit;
    // huge does not → break. small-1 and small-2 are excluded even though they'd
    // individually fit, preserving a contiguous recent segment rather than a
    // sparse chain with gaps.
    const root = '<root@x.com>';                     // 12 chars
    const small = (n: number) => `<s${n}@x.com>`;   // 10 chars each
    const huge = `<${'x'.repeat(1986)}@x.com>`;      // 1994 chars (12 + 1 + 1994 > 2000)

    const replyToId = small(5);
    const references = `${root} ${small(1)} ${small(2)} ${huge} ${small(3)} ${small(4)}`;

    const result = buildReferencesHeader(replyToId, references);
    // Expected: root + small-3, small-4, small-5
    expect(result).toBe(`${root} ${small(3)} ${small(4)} ${small(5)}`);
  });
});
