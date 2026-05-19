import { describe, it, expect } from 'vitest';
import { resolveThreadId, resolveOrphanThreadId } from '../src/mail-threading';
import type { ParentRecord } from '../src/mail-threading';

// ---------------------------------------------------------------------------
// resolveThreadId
// ---------------------------------------------------------------------------

describe('resolveThreadId', () => {
  it('joins existing thread when parent is found (direct reply)', () => {
    const parentLookup = new Map<string, ParentRecord>([
      ['<parent@example.com>', { thread_id: 'thread-abc' }],
    ]);
    const result = resolveThreadId(
      { messageId: '<reply@example.com>', inReplyTo: '<parent@example.com>' },
      parentLookup,
      'fallback-id',
    );
    expect(result).toEqual({ threadId: 'thread-abc', needsRethreading: false });
  });

  it('uses inReplyTo as thread_id and flags needsRethreading when parent is not found (orphan)', () => {
    const result = resolveThreadId(
      { messageId: '<reply@example.com>', inReplyTo: '<missing-parent@example.com>' },
      new Map(),
      'fallback-id',
    );
    expect(result).toEqual({
      threadId: '<missing-parent@example.com>',
      needsRethreading: true,
    });
  });

  it('uses messageId as thread_id for a root message (no inReplyTo)', () => {
    const result = resolveThreadId(
      { messageId: '<root@example.com>', inReplyTo: null },
      new Map(),
      'fallback-id',
    );
    expect(result).toEqual({ threadId: '<root@example.com>', needsRethreading: false });
  });

  it('falls back to fallbackId when both messageId and inReplyTo are null', () => {
    const result = resolveThreadId(
      { messageId: null, inReplyTo: null },
      new Map(),
      'resend-email-id-xyz',
    );
    expect(result).toEqual({ threadId: 'resend-email-id-xyz', needsRethreading: false });
  });

  it('does not flag needsRethreading for a root message with no messageId', () => {
    const result = resolveThreadId(
      { messageId: null, inReplyTo: null },
      new Map(),
      'fallback-id',
    );
    expect(result.needsRethreading).toBe(false);
  });

  it('sibling out-of-order replies share the same orphan thread_id (inReplyTo value)', () => {
    const lookup = new Map<string, ParentRecord>();
    const r1 = resolveThreadId(
      { messageId: '<reply-1@example.com>', inReplyTo: '<root@example.com>' },
      lookup,
      'fb1',
    );
    const r2 = resolveThreadId(
      { messageId: '<reply-2@example.com>', inReplyTo: '<root@example.com>' },
      lookup,
      'fb2',
    );
    // Both orphans share the same provisional thread_id (the inReplyTo value)
    expect(r1.threadId).toBe('<root@example.com>');
    expect(r2.threadId).toBe('<root@example.com>');
    expect(r1.needsRethreading).toBe(true);
    expect(r2.needsRethreading).toBe(true);
  });

  it('does not flag needsRethreading when parent is found in lookup (duplicate delivery)', () => {
    const lookup = new Map<string, ParentRecord>([
      ['<parent@example.com>', { thread_id: 'thread-existing' }],
    ]);
    const r1 = resolveThreadId(
      { messageId: '<reply@example.com>', inReplyTo: '<parent@example.com>' },
      lookup,
      'fallback',
    );
    // Second delivery of the same reply — same result, no rethreading needed
    const r2 = resolveThreadId(
      { messageId: '<reply@example.com>', inReplyTo: '<parent@example.com>' },
      lookup,
      'fallback',
    );
    expect(r1).toEqual({ threadId: 'thread-existing', needsRethreading: false });
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// resolveOrphanThreadId
// ---------------------------------------------------------------------------

describe('resolveOrphanThreadId', () => {
  it('resolves parent via in_reply_to when present in lookup', () => {
    const lookup = new Map<string, ParentRecord>([
      ['<parent@example.com>', { thread_id: 'thread-xyz' }],
    ]);
    const result = resolveOrphanThreadId('<parent@example.com>', null, lookup);
    expect(result).toEqual({ thread_id: 'thread-xyz' });
  });

  it('resolves parent via references chain when in_reply_to is not in lookup', () => {
    const lookup = new Map<string, ParentRecord>([
      ['<root@example.com>', { thread_id: 'thread-root' }],
    ]);
    // in_reply_to is missing but references chain contains root
    const result = resolveOrphanThreadId(
      '<mid@example.com>',
      '<root@example.com> <mid@example.com>',
      lookup,
    );
    // References are walked in reverse; <mid@example.com> not in lookup,
    // then <root@example.com> is found.
    expect(result).toEqual({ thread_id: 'thread-root' });
  });

  it('prefers the most-recent ancestor in references (reverse order walk)', () => {
    const lookup = new Map<string, ParentRecord>([
      ['<msg-1@example.com>', { thread_id: 'thread-old' }],
      ['<msg-2@example.com>', { thread_id: 'thread-newer' }],
    ]);
    // References: oldest first (RFC 2822 order)
    const result = resolveOrphanThreadId(
      '<msg-3@example.com>',
      '<msg-1@example.com> <msg-2@example.com>',
      lookup,
    );
    // Walk reversed: msg-2 is found first → most-recent ancestor wins
    expect(result).toEqual({ thread_id: 'thread-newer' });
  });

  it('returns null when neither in_reply_to nor references are resolved', () => {
    const lookup = new Map<string, ParentRecord>();
    const result = resolveOrphanThreadId('<parent@example.com>', '<other@example.com>', lookup);
    expect(result).toBeNull();
  });

  it('returns null when references is null and in_reply_to is not in lookup', () => {
    const lookup = new Map<string, ParentRecord>();
    const result = resolveOrphanThreadId('<parent@example.com>', null, lookup);
    expect(result).toBeNull();
  });

  it('handles extra whitespace in references string', () => {
    const lookup = new Map<string, ParentRecord>([
      ['<root@example.com>', { thread_id: 'thread-root' }],
    ]);
    // References has leading/trailing spaces and multiple spaces between IDs
    const result = resolveOrphanThreadId(
      '<missing@example.com>',
      '  <root@example.com>  ',
      lookup,
    );
    expect(result).toEqual({ thread_id: 'thread-root' });
  });
});
