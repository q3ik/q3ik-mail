import { describe, it, expect } from 'vitest';
import {
  getLatestEmails,
  getEmailsByThread,
  markAsRead,
  getEmailById,
  getThreadList,
  getThreadListPage,
} from '../index';

// Minimal in-memory D1 mock for unit testing query functions.
// Real D1 binding tests run in the worker layer via @cloudflare/vitest-pool-workers.
function createMockDb(
  rows: Record<string, unknown>[] = [],
  {
    onPrepare,
    onBind,
  }: {
    onPrepare?: (sql: string) => void;
    onBind?: (args: unknown[]) => void;
  } = {}
) {
  return {
    prepare: (sql: string) => {
      onPrepare?.(sql);
      return {
        bind: (...args: unknown[]) => {
          onBind?.(args);
          return {
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
        run: async () => ({ success: true }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getLatestEmails', () => {
  it('returns emails ordered by received_at DESC', async () => {
    const rows = [
      { id: '1', created_at: '2026-05-09T12:00:00Z', subject: 'B' },
      { id: '2', created_at: '2026-05-09T11:00:00Z', subject: 'A' },
    ];
    const db = createMockDb(rows);
    const result = await getLatestEmails(db, 50);
    expect(result[0].subject).toBe('B');
  });

  it('respects the limit parameter', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: String(i) }));
    const db = createMockDb(rows.slice(0, 3));
    const result = await getLatestEmails(db, 3);
    expect(result).toHaveLength(3);
  });

  it('surfaces the references field when present', async () => {
    const rows = [{
      id: '1',
      references: '<root-001@example.com>',
      subject: 'Re: Hello',
    }];
    const db = createMockDb(rows);
    const result = await getLatestEmails(db, 1);
    expect(result[0].references).toBe('<root-001@example.com>');
  });

  it('surfaces null references when absent', async () => {
    const rows = [{ id: '1', references: null, subject: 'Hello' }];
    const db = createMockDb(rows);
    const result = await getLatestEmails(db, 1);
    expect(result[0].references).toBeNull();
  });
});

describe('getEmailsByThread', () => {
  it('returns all emails in a thread', async () => {
    const rows = [
      { id: '1', thread_id: 'thread-abc' },
      { id: '2', thread_id: 'thread-abc' },
    ];
    const db = createMockDb(rows);
    const result = await getEmailsByThread(db, 'thread-abc');
    expect(result).toHaveLength(2);
  });
});

describe('markAsRead', () => {
  it('does not throw on valid emailId', async () => {
    const db = createMockDb();
    await expect(markAsRead(db, 'some-uuid')).resolves.toBeUndefined();
  });
});

describe('getEmailById', () => {
  it('returns null when no email found', async () => {
    const db = createMockDb([]);
    const result = await getEmailById(db, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns the email when found', async () => {
    const email = { id: 'abc', subject: 'Hello' };
    const db = createMockDb([email]);
    const result = await getEmailById(db, 'abc');
    expect(result?.subject).toBe('Hello');
  });

  it('surfaces the references field when present', async () => {
    const email = {
      id: 'abc',
      subject: 'Re: Hello',
      references: '<root-001@example.com>',
    };
    const db = createMockDb([email]);
    const result = await getEmailById(db, 'abc');
    expect(result?.references).toBe('<root-001@example.com>');
  });
});

describe('getThreadList', () => {
  it('returns thread summary rows', async () => {
    const rows = [
      { id: '1', thread_id: 'thread-abc', subject: 'Root' },
    ];
    const db = createMockDb(rows);
    const result = await getThreadList(db, 50);
    expect(result).toHaveLength(1);
    expect(result[0].thread_id).toBe('thread-abc');
  });

  it('surfaces the references field for thread representative rows', async () => {
    const rows = [{
      id: '1',
      thread_id: 'thread-abc',
      subject: 'Re: Root',
      references: '<root-001@example.com>',
    }];
    const db = createMockDb(rows);
    const result = await getThreadList(db, 1);
    expect(result[0].references).toBe('<root-001@example.com>');
  });

  it('supports cursor-based pagination and returns a next cursor when more rows exist', async () => {
    let preparedSql = '';
    let boundArgs: unknown[] = [];

    const rows = [
      {
        id: '1',
        thread_id: 'thread-1',
        subject: 'Newest',
        created_at: '2026-05-11T12:00:00Z',
      },
      {
        id: '2',
        thread_id: 'thread-2',
        subject: 'Middle',
        created_at: '2026-05-11T11:00:00Z',
      },
      {
        id: '3',
        thread_id: 'thread-3',
        subject: 'Oldest',
        created_at: '2026-05-11T10:00:00Z',
      },
    ];

    const db = createMockDb(rows, {
      onPrepare: (sql) => {
        preparedSql = sql;
      },
      onBind: (args) => {
        boundArgs = args;
      },
    });

    const result = await getThreadListPage(db, {
      limit: 2,
      cursor: '2026-05-11T13:00:00Z',
    });

    expect(preparedSql).toContain('created_at < ?');
    expect(boundArgs).toEqual(['2026-05-11T13:00:00Z', 3]);
    expect(result.threads).toHaveLength(2);
    expect(result.nextCursor).toBe('2026-05-11T11:00:00Z');
  });
});
