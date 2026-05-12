
// TODO: !!! Possibly broken after merge conflict resolution
import { describe, it, expect, vi } from 'vitest';
import { getLatestEmails, 
        getEmailsByThread, 
        markAsRead, 
        getEmailById, 
        getThreadList, 
        getThreadListPage,
        resolveOrphanedThreads 
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
            all: async () => {
              let results = [...rows];

              if (sql.includes('created_at < ?') && args.length >= 4) {
                const [createdAt, equalCreatedAt, id] = args as [
                  string,
                  string,
                  string,
                  number,
                ];

                results = results.filter((row) => {
                  const rowCreatedAt = row.created_at;
                  const rowId = row.id;

                  return (
                    typeof rowCreatedAt === 'string' &&
                    typeof rowId === 'string' &&
                    (rowCreatedAt < createdAt ||
                      (rowCreatedAt === equalCreatedAt && rowId > id))
                  );
                });
              }

              if (sql.includes('ORDER BY created_at DESC, id ASC')) {
                results.sort((a, b) => {
                  const aCreatedAt = typeof a.created_at === 'string' ? a.created_at : '';
                  const bCreatedAt = typeof b.created_at === 'string' ? b.created_at : '';

                  if (aCreatedAt !== bCreatedAt) {
                    return bCreatedAt.localeCompare(aCreatedAt);
                  }

                  const aId = typeof a.id === 'string' ? a.id : '';
                  const bId = typeof b.id === 'string' ? b.id : '';
                  return aId.localeCompare(bId);
                });
              }

              const limit = args.at(-1);
              if (typeof limit === 'number') {
                results = results.slice(0, limit);
              }

              return { results };
            },
            first: async () => rows[0] ?? null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

type ThreadRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  needs_rethreading: number;
  created_at: string;
  subject?: string | null;
  from_address?: string;
};

function createThreadDb(seedRows: ThreadRow[]) {
  const rows = seedRows.map((row) => ({ ...row }));
  const preparedSqls: string[] = [];
  const bindCalls: Array<{ sql: string; args: unknown[] }> = [];

  const db = {
    prepare: (sql: string) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      preparedSqls.push(normalizedSql);

      return {
        bind: (...args: unknown[]) => ({
          all: async () => {
            bindCalls.push({ sql: normalizedSql, args });

            if (normalizedSql.includes('WHERE needs_rethreading = 1')) {
              const limit = args[0] as number;

              return {
                results: rows
                  .filter((row) => row.needs_rethreading === 1 && row.in_reply_to !== null)
                  .sort((a, b) => a.created_at.localeCompare(b.created_at))
                  .slice(0, limit)
                  .map((row) => ({ id: row.id, in_reply_to: row.in_reply_to! })),
              };
            }

            throw new Error(`Unexpected SQL in all(): ${normalizedSql}`);
          },
          first: async () => {
            bindCalls.push({ sql: normalizedSql, args });

            if (normalizedSql.includes('WHERE message_id = ? LIMIT 1')) {
              const parent = rows.find((row) => row.message_id === args[0]);
              return parent ? { thread_id: parent.thread_id } : null;
            }

            throw new Error(`Unexpected SQL in first(): ${normalizedSql}`);
          },
          run: async () => {
            bindCalls.push({ sql: normalizedSql, args });

            if (normalizedSql.includes('SET thread_id = ?, needs_rethreading = 0')) {
              const [threadId, orphanId] = args;
              const orphan = rows.find((row) => row.id === orphanId);
              if (orphan) {
                orphan.thread_id = threadId as string;
                orphan.needs_rethreading = 0;
                return { success: true };
              }
            }

            throw new Error(`Unexpected SQL in run(): ${normalizedSql}`);
          },
        }),
      };
    },
  } as unknown as D1Database;

  return { db, rows, preparedSqls, bindCalls };
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
    const cursor = btoa(
      JSON.stringify({
        createdAt: '2026-05-11T12:00:00Z',
        id: '2',
      })
    );

    const rows = [
      {
        id: '1',
        thread_id: 'thread-1',
        subject: 'Newest',
        created_at: '2026-05-11T13:00:00Z',
      },
      {
        id: '2',
        thread_id: 'thread-2',
        subject: 'Middle',
        created_at: '2026-05-11T12:00:00Z',
      },
      {
        id: '3',
        thread_id: 'thread-3',
        subject: 'Same second, later id',
        created_at: '2026-05-11T12:00:00Z',
      },
      {
        id: '4',
        thread_id: 'thread-4',
        subject: 'Older',
        created_at: '2026-05-11T10:00:00Z',
      },
      {
        id: '5',
        thread_id: 'thread-5',
        subject: 'Oldest',
        created_at: '2026-05-11T09:00:00Z',
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
      cursor,
    });

    expect(preparedSql).toContain('created_at < ?');
    expect(boundArgs).toEqual([
      '2026-05-11T12:00:00Z',
      '2026-05-11T12:00:00Z',
      '2',
      3,
    ]);
    expect(result.threads).toHaveLength(2);
    expect(result.threads.map((thread) => thread.id)).toEqual(['3', '4']);
    expect(result.nextCursor).toBe(
      btoa(
        JSON.stringify({
          createdAt: '2026-05-11T10:00:00Z',
          id: '4',
        })
      )
    );
  });
});

describe('resolveOrphanedThreads', () => {
  it('joins an orphan to the existing parent thread by message_id', async () => {
    const { db, rows } = createThreadDb([
      {
        id: 'parent-1',
        thread_id: 'thread-root',
        message_id: '<parent@example.com>',
        in_reply_to: null,
        needs_rethreading: 0,
        created_at: '2026-05-09T10:00:00Z',
      },
      {
        id: 'orphan-1',
        thread_id: '<parent@example.com>',
        message_id: '<reply@example.com>',
        in_reply_to: '<parent@example.com>',
        needs_rethreading: 1,
        created_at: '2026-05-09T10:01:00Z',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(resolveOrphanedThreads(db)).resolves.toBe(1);
    } finally {
      logSpy.mockRestore();
    }

    expect(rows.find((row) => row.id === 'orphan-1')).toMatchObject({
      thread_id: 'thread-root',
      needs_rethreading: 0,
    });
  });

  it('leaves an orphan on its own thread when no parent message_id exists', async () => {
    const { db, rows } = createThreadDb([
      {
        id: 'orphan-1',
        thread_id: '<missing@example.com>',
        message_id: '<reply@example.com>',
        in_reply_to: '<missing@example.com>',
        needs_rethreading: 1,
        created_at: '2026-05-09T10:01:00Z',
        subject: 'Re: Status',
      },
      {
        id: 'other-thread',
        thread_id: '<different-root@example.com>',
        message_id: '<different-root@example.com>',
        in_reply_to: null,
        needs_rethreading: 0,
        created_at: '2026-05-09T10:02:00Z',
        subject: 'Re: Status',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(resolveOrphanedThreads(db)).resolves.toBe(0);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }

    expect(rows.find((row) => row.id === 'orphan-1')).toMatchObject({
      thread_id: '<missing@example.com>',
      needs_rethreading: 1,
    });
  });

  it('does not merge different conversations that only share a subject line', async () => {
    const { db, rows } = createThreadDb([
      {
        id: 'orphan-a',
        thread_id: '<missing-a@example.com>',
        message_id: '<reply-a@example.com>',
        in_reply_to: '<missing-a@example.com>',
        needs_rethreading: 1,
        created_at: '2026-05-09T10:01:00Z',
        subject: 'Daily Standup',
        from_address: 'alice@example.com',
      },
      {
        id: 'orphan-b',
        thread_id: '<missing-b@example.com>',
        message_id: '<reply-b@example.com>',
        in_reply_to: '<missing-b@example.com>',
        needs_rethreading: 1,
        created_at: '2026-05-09T10:02:00Z',
        subject: 'Daily Standup',
        from_address: 'bob@example.com',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(resolveOrphanedThreads(db)).resolves.toBe(0);
    } finally {
      logSpy.mockRestore();
    }

    expect(rows.find((row) => row.id === 'orphan-a')?.thread_id).toBe('<missing-a@example.com>');
    expect(rows.find((row) => row.id === 'orphan-b')?.thread_id).toBe('<missing-b@example.com>');
  });

  it('resolves an orphan correctly after its parent arrives late', async () => {
    const { db, rows } = createThreadDb([
      {
        id: 'orphan-1',
        thread_id: '<late-parent@example.com>',
        message_id: '<reply@example.com>',
        in_reply_to: '<late-parent@example.com>',
        needs_rethreading: 1,
        created_at: '2026-05-09T10:00:00Z',
      },
      {
        id: 'late-parent',
        thread_id: 'thread-root',
        message_id: '<late-parent@example.com>',
        in_reply_to: null,
        needs_rethreading: 0,
        created_at: '2026-05-09T10:05:00Z',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(resolveOrphanedThreads(db)).resolves.toBe(1);
      expect(logSpy).toHaveBeenCalledWith('[rethread] resolved 1 orphaned rows');
    } finally {
      logSpy.mockRestore();
    }

    expect(rows.find((row) => row.id === 'orphan-1')).toMatchObject({
      thread_id: 'thread-root',
      needs_rethreading: 0,
    });
  });

  it('only processes the first 100 orphaned rows per run', async () => {
    const rows: ThreadRow[] = Array.from({ length: 150 }, (_, index) => ({
      id: `orphan-${index}`,
      thread_id: `<parent-${index}@example.com>`,
      message_id: `<reply-${index}@example.com>`,
      in_reply_to: `<parent-${index}@example.com>`,
      needs_rethreading: 1,
      created_at: `2026-05-09T10:${String(index).padStart(2, '0')}:00Z`,
    }));

    rows.push(...Array.from({ length: 150 }, (_, index) => ({
      id: `parent-${index}`,
      thread_id: `thread-${index}`,
      message_id: `<parent-${index}@example.com>`,
      in_reply_to: null,
      needs_rethreading: 0,
      created_at: `2026-05-09T11:${String(index).padStart(2, '0')}:00Z`,
    })));

    const { db, rows: threadRows, preparedSqls, bindCalls } = createThreadDb(rows);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(resolveOrphanedThreads(db)).resolves.toBe(100);
      expect(logSpy).toHaveBeenCalledWith('[rethread] resolved 100 orphaned rows');
    } finally {
      logSpy.mockRestore();
    }

    const orphanQuery = preparedSqls.find((sql) => sql.includes('WHERE needs_rethreading = 1'));
    expect(orphanQuery).toContain('LIMIT ?');
    expect(bindCalls).toContainEqual({
      sql: orphanQuery,
      args: [100],
    });
    expect(threadRows.filter((row) => row.id.startsWith('orphan-') && row.needs_rethreading === 0)).toHaveLength(100);
    expect(threadRows.filter((row) => row.id.startsWith('orphan-') && row.needs_rethreading === 1)).toHaveLength(50);
  });
});
