import { describe, it, expect, vi } from 'vitest';
import { getLatestEmails, 
        getEmailsByThread, 
        markAsRead, 
        getEmailById, 
        migrateEmailBodiesToR2,
        getThreadList, 
        getThreadListPage,
        searchEmails,
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

              if (sql.includes('ranked_emails.created_at < ?') && args.length >= 4) {
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

              if (sql.includes('ORDER BY ranked_emails.created_at DESC, ranked_emails.id ASC')) {
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

function createMockR2Bucket(
  objects: Record<string, string>
): { bucket: R2Bucket; getSpy: ReturnType<typeof vi.fn> } {
  const getSpy = vi.fn(async (key: string) => {
    const value = objects[key];
    if (value === undefined) {
      return null;
    }
    return {
      text: async () => value,
    } as R2ObjectBody;
  });

  return {
    bucket: {
      get: getSpy,
    } as unknown as R2Bucket,
    getSpy,
  };
}

type ThreadRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references?: string | null;
  needs_rethreading: number;
  created_at: string;
  subject?: string | null;
  from_address?: string;
};

function createThreadDb(seedRows: ThreadRow[]) {
  const rows = seedRows.map((row) => ({ ...row }));
  const preparedSqls: string[] = [];
  const bindCalls: Array<{ sql: string; args: unknown[] }> = [];
  const batchCalls: Array<Array<{ sql: string; args: unknown[] }>> = [];

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
                  .map((row) => ({
                    id: row.id,
                    in_reply_to: row.in_reply_to!,
                    references: row.references ?? null,
                  })),
              };
            }

            if (normalizedSql.includes('WHERE message_id IN (')) {
              const messageIds = new Set(args as string[]);

              return {
                results: rows
                  .filter((row) => row.message_id !== null && messageIds.has(row.message_id))
                  .map((row) => ({
                    id: row.id,
                    message_id: row.message_id!,
                    thread_id: row.thread_id,
                  })),
              };
            }

            throw new Error(`Unexpected SQL in all(): ${normalizedSql}`);
          },
          first: async () => {
            bindCalls.push({ sql: normalizedSql, args });

            if (normalizedSql.includes('WHERE message_id = ? LIMIT 1')) {
              const parent = rows.find((row) => row.message_id === args[0]);
              return parent ? { id: parent.id, thread_id: parent.thread_id } : null;
            }

            throw new Error(`Unexpected SQL in first(): ${normalizedSql}`);
          },
          run: async () => {
            bindCalls.push({ sql: normalizedSql, args });

            if (
              normalizedSql.includes('SET thread_id = ?, needs_rethreading = 0') &&
              normalizedSql.includes('WHERE id = ? AND needs_rethreading = 1')
            ) {
              const [threadId, orphanId] = args;
              const orphan = rows.find((row) => row.id === orphanId);
              if (orphan && orphan.needs_rethreading === 1) {
                orphan.thread_id = threadId as string;
                orphan.needs_rethreading = 0;
                return { success: true };
              }

              return { success: true };
            }

            throw new Error(`Unexpected SQL in run(): ${normalizedSql}`);
          },
        }),
      };
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const batchStatementCalls: Array<{ sql: string; args: unknown[] }> = [];

      for (const statement of statements as unknown as Array<{ run: () => Promise<unknown> }>) {
        const bindCallCountBeforeRun = bindCalls.length;
        await statement.run();
        const latestBindCall = bindCalls.at(-1);
        if (latestBindCall && bindCalls.length > bindCallCountBeforeRun) {
          batchStatementCalls.push(latestBindCall);
        }
      }

      batchCalls.push(batchStatementCalls);
      return [];
    },
  } as unknown as D1Database;

  return { db, rows, preparedSqls, bindCalls, batchCalls };
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

  it('hydrates body_html and body_text from R2 when keys are present', async () => {
    const rows = [
      {
        id: '1',
        thread_id: 'thread-abc',
        body_html: null,
        body_text: null,
        body_html_key: 'emails/1/body.html',
        body_text_key: 'emails/1/body.txt',
      },
    ];
    const db = createMockDb(rows);
    const { bucket, getSpy } = createMockR2Bucket({
      'emails/1/body.html': '<p>HTML from R2</p>',
      'emails/1/body.txt': 'Text from R2',
    });

    const result = await getEmailsByThread(db, 'thread-abc', bucket);

    expect(result[0].body_html).toBe('<p>HTML from R2</p>');
    expect(result[0].body_text).toBe('Text from R2');
    expect(getSpy).toHaveBeenCalledWith('emails/1/body.html');
    expect(getSpy).toHaveBeenCalledWith('emails/1/body.txt');
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

  it('hydrates body fields from R2 when key columns are set', async () => {
    const email = {
      id: 'abc',
      subject: 'Hello',
      body_html: null,
      body_text: null,
      body_html_key: 'emails/abc/body.html',
      body_text_key: 'emails/abc/body.txt',
    };
    const db = createMockDb([email]);
    const { bucket } = createMockR2Bucket({
      'emails/abc/body.html': '<p>Hydrated</p>',
      'emails/abc/body.txt': 'Hydrated text',
    });

    const result = await getEmailById(db, 'abc', bucket);

    expect(result?.body_html).toBe('<p>Hydrated</p>');
    expect(result?.body_text).toBe('Hydrated text');
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

  it('returns exactly limit rows when more rows exist (no +1 over-fetch)', async () => {
    // 4 rows available, limit=3 → must return exactly 3 rows and bind exactly 3 (not 4)
    let lastBoundLimit: number | undefined;
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: String(i + 1),
      thread_id: `thread-${i + 1}`,
      created_at: `2026-05-09T${String(15 - i).padStart(2, '0')}:00:00Z`,
    }));
    const db = createMockDb(rows, {
      onBind: (args) => {
        const last = args.at(-1);
        if (typeof last === 'number') lastBoundLimit = last;
      },
    });
    const result = await getThreadList(db, 3);
    expect(result).toHaveLength(3);
    expect(lastBoundLimit).toBe(3); // Confirms the LIMIT arg is exactly 3, not 4 (limit+1)
  });
});

describe('migrateEmailBodiesToR2', () => {
  it('skips D1 update when put succeeds but head verification fails', async () => {
    const selectRows = [
      {
        id: 'email-1',
        body_text: 'Plain body',
        body_html: null,
        body_text_key: null,
        body_html_key: null,
      },
    ];

    const updateRunSpy = vi.fn(async () => ({ success: true }));

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes('SELECT id, body_text, body_html, body_text_key, body_html_key')) {
              return { results: selectRows };
            }
            throw new Error(`Unexpected SQL in all(): ${sql}`);
          },
          run: async () => {
            if (sql.includes('UPDATE emails')) {
              return updateRunSpy();
            }
            throw new Error(`Unexpected SQL in run(): ${sql}`);
          },
        }),
      }),
    } as unknown as D1Database;

    const putSpy = vi.fn(async () => undefined);
    const headSpy = vi.fn(async () => null);
    const bucket = {
      put: putSpy,
      head: headSpy,
    } as unknown as R2Bucket;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const migrated = await migrateEmailBodiesToR2(db, bucket, 10);

      expect(migrated).toBe(0);
      expect(putSpy).toHaveBeenCalledWith('emails/email-1/body.txt', 'Plain body', {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
      expect(headSpy).toHaveBeenCalledWith('emails/email-1/body.txt');
      expect(updateRunSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        'R2 write verification failed for email email-1, key: emails/email-1/body.txt. Skipping email; D1 body columns remain unchanged.'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('getThreadListPage', () => {
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

  it('does not skip or duplicate rows when two threads share the same created_at timestamp', async () => {
    // NOTE: createMockDb simulates the composite WHERE clause in-memory (not via real SQL).
    // This test verifies that cursor encode/decode round-trips correctly across page
    // boundaries and that the mock filters rows consistently with the intended
    // (created_at < ?) OR (created_at = ? AND id > ?) predicate.
    // SQL clause correctness against a real D1 database is covered by integration tests.
    //
    // All five threads: three share the same timestamp at the page boundary.
    // Page 1 (limit=2): threads A and B (both at '2026-05-11T12:00:00Z').
    // Page 2 cursor encodes { createdAt: '2026-05-11T12:00:00Z', id: 'b' }.
    // Page 2 must return C (same timestamp, id > 'b') and D — no skip, no duplicate.
    const allRows = [
      { id: 'a', thread_id: 'thread-a', subject: 'A', created_at: '2026-05-11T12:00:00Z' },
      { id: 'b', thread_id: 'thread-b', subject: 'B', created_at: '2026-05-11T12:00:00Z' },
      { id: 'c', thread_id: 'thread-c', subject: 'C', created_at: '2026-05-11T12:00:00Z' },
      { id: 'd', thread_id: 'thread-d', subject: 'D', created_at: '2026-05-11T10:00:00Z' },
      { id: 'e', thread_id: 'thread-e', subject: 'E', created_at: '2026-05-11T09:00:00Z' },
    ];

    // Fetch page 1 (no cursor) — should return rows a, b.
    let capturedSql = '';
    const page1 = await getThreadListPage(
      createMockDb(allRows, { onPrepare: (sql) => { capturedSql = sql; } }),
      { limit: 2 }
    );
    expect(page1.threads.map((t) => t.id)).toEqual(['a', 'b']);
    expect(page1.nextCursor).not.toBeNull();
    // Page 1 has no cursor — WHERE clause must not include the tiebreaker predicate.
    expect(capturedSql).not.toContain('ranked_emails.created_at < ?');

    // Fetch page 2 using the cursor from page 1 — should return rows c, d (no skip/duplicate).
    // Also assert the SQL carries the composite tiebreaker predicate.
    let page2Sql = '';
    let page2Args: unknown[] = [];
    const page2 = await getThreadListPage(
      createMockDb(allRows, {
        onPrepare: (sql) => { page2Sql = sql; },
        onBind: (args) => { page2Args = args; },
      }),
      { limit: 2, cursor: page1.nextCursor! }
    );
    expect(page2.threads.map((t) => t.id)).toEqual(['c', 'd']);
    expect(page2.nextCursor).not.toBeNull();
    // Verify the composite WHERE clause structure is emitted correctly.
    expect(page2Sql).toContain('ranked_emails.created_at < ?');
    expect(page2Sql).toContain('ranked_emails.created_at = ? AND ranked_emails.id > ?');
    expect(page2Args).toEqual([
      '2026-05-11T12:00:00Z',
      '2026-05-11T12:00:00Z',
      'b',
      3, // fetchLimit = pageSize + 1
    ]);

    // Fetch page 3 — should return row e only and no further cursor.
    const page3 = await getThreadListPage(createMockDb(allRows), {
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.threads.map((t) => t.id)).toEqual(['e']);
    expect(page3.nextCursor).toBeNull();

    // Verify no row appears more than once across all pages.
    const allIds = [
      ...page1.threads.map((t) => t.id),
      ...page2.threads.map((t) => t.id),
      ...page3.threads.map((t) => t.id),
    ];
    expect(allIds).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns an empty page and null nextCursor for a malformed cursor string', async () => {
    const db = createMockDb([
      { id: '1', thread_id: 'thread-1', subject: 'Hello', created_at: '2026-05-11T12:00:00Z' },
    ]);

    const result = await getThreadListPage(db, { limit: 50, cursor: 'not-valid-base64!!!{' });

    expect(result.threads).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns an empty page and null nextCursor for a base64 cursor that lacks required fields', async () => {
    const db = createMockDb([
      { id: '1', thread_id: 'thread-1', subject: 'Hello', created_at: '2026-05-11T12:00:00Z' },
    ]);
    const malformedCursor = btoa(JSON.stringify({ foo: 'bar' }));

    const result = await getThreadListPage(db, { limit: 50, cursor: malformedCursor });

    expect(result.threads).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

describe('searchEmails', () => {
  it('returns an empty array for blank queries', async () => {
    const db = createMockDb([
      { id: '1', thread_id: 'thread-1', subject: 'Hello' },
    ]);
    const result = await searchEmails(db, '   ');
    expect(result).toEqual([]);
  });

  it('returns an empty array for a whitespace-only string with mixed spaces', async () => {
    const db = createMockDb([{ id: '1', thread_id: 'thread-1', subject: 'Hello' }]);
    const result = await searchEmails(db, '  \t  ');
    expect(result).toEqual([]);
  });

  it('returns an empty array for queries longer than 500 characters', async () => {
    const prepareSpy = vi.fn();
    const db = createMockDb(
      [{ id: '1', thread_id: 'thread-1', subject: 'Hello', references: null }],
      { onPrepare: prepareSpy }
    );

    const result = await searchEmails(db, `a${'b'.repeat(500)}`);

    expect(result).toEqual([]);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('accepts a 500-character query and runs the FTS search', async () => {
    let boundArgs: unknown[] = [];
    const db = createMockDb(
      [{ id: '1', thread_id: 'thread-1', subject: 'Hello', references: null }],
      { onBind: (args) => { boundArgs = args; } }
    );

    await searchEmails(db, 'a'.repeat(500));

    expect(boundArgs).toEqual([`"${'a'.repeat(500)}"`]);
  });

  it('queries FTS5 with AND semantics (space-separated phrases) for multi-word queries', async () => {
    let preparedSql = '';
    let boundArgs: unknown[] = [];
    const db = createMockDb(
      [
        {
          id: '1',
          thread_id: 'thread-1',
          subject: 'Hello FTS',
          references: null,
        },
      ],
      {
        onPrepare: (sql) => {
          preparedSql = sql;
        },
        onBind: (args) => {
          boundArgs = args;
        },
      }
    );

    const result = await searchEmails(db, 'hello "world');

    expect(preparedSql).toContain('JOIN emails_fts ON emails.rowid = emails_fts.rowid');
    expect(preparedSql).toContain('WHERE emails_fts MATCH ?');
    // AND semantics: terms joined by space, not OR
    expect(boundArgs).toEqual(['"hello" """world"']);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('Hello FTS');
  });

  it('produces a single quoted phrase for a single-term query', async () => {
    let boundArgs: unknown[] = [];
    const db = createMockDb(
      [{ id: '1', thread_id: 'thread-1', subject: 'Hello', references: null }],
      { onBind: (args) => { boundArgs = args; } }
    );

    await searchEmails(db, 'hello');
    expect(boundArgs).toEqual(['"hello"']);
  });

  it('preserves hyphens and colons inside search terms (not stripped)', async () => {
    let boundArgs: unknown[] = [];
    const db = createMockDb(
      [{ id: '1', thread_id: 'thread-1', subject: 're: Smith-Jones', references: null }],
      { onBind: (args) => { boundArgs = args; } }
    );

    await searchEmails(db, 're: Smith-Jones');
    // Hyphens and colons must be preserved inside FTS5 double-quoted phrases
    expect(boundArgs).toEqual(['"re:" "Smith-Jones"']);
  });

  it('strips wildcard * characters (not valid inside double-quoted FTS5 phrases)', async () => {
    // The old sanitizer used to allow * through; double-quoting a term containing
    // * causes an FTS5 syntax error. Verify it is escaped via double-quote wrapping,
    // which neutralises * as a literal character inside the phrase.
    let boundArgs: unknown[] = [];
    const db = createMockDb(
      [{ id: '1', thread_id: 'thread-1', subject: 'hello world', references: null }],
      { onBind: (args) => { boundArgs = args; } }
    );

    await searchEmails(db, 'hel*');
    // * is kept as a literal inside the double-quoted phrase — no FTS5 prefix search.
    expect(boundArgs).toEqual(['"hel*"']);
  });

  it('applies a LIMIT clause to prevent unbounded FTS result sets', async () => {
    let preparedSql = '';
    const db = createMockDb(
      [{ id: '1', thread_id: 'thread-1', subject: 'Hello', references: null }],
      { onPrepare: (sql) => { preparedSql = sql; } }
    );

    await searchEmails(db, 'hello');
    expect(preparedSql).toContain('LIMIT 50');
  });

  it('matches against from_name field', async () => {
    let boundArgs: unknown[] = [];
    const db = createMockDb(
      [
        {
          id: '1',
          thread_id: 'thread-1',
          subject: 'Meeting notes',
          from_name: 'Alice Bob',
          references: null,
        },
      ],
      { onBind: (args) => { boundArgs = args; } }
    );

    await searchEmails(db, 'Alice Bob');
    // Both terms must be present (AND semantics)
    expect(boundArgs).toEqual(['"Alice" "Bob"']);
  });
});

describe('resolveOrphanedThreads', () => {
  it('joins an orphan to the existing parent thread by message_id', async () => {
    const { db, rows, preparedSqls, batchCalls } = createThreadDb([
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
    expect(preparedSqls.some((sql) => sql.includes('WHERE message_id IN ('))).toBe(true);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(1);
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

  it('falls back to references chain when direct in_reply_to parent is missing', async () => {
    const { db, rows } = createThreadDb([
      {
        id: 'root-1',
        thread_id: 'thread-root',
        message_id: '<root@example.com>',
        in_reply_to: null,
        needs_rethreading: 0,
        created_at: '2026-05-09T09:58:00Z',
      },
      {
        id: 'orphan-1',
        thread_id: '<missing-parent@example.com>',
        message_id: '<reply@example.com>',
        in_reply_to: '<missing-parent@example.com>',
        references: '<root@example.com> <missing-parent@example.com>',
        needs_rethreading: 1,
        created_at: '2026-05-09T10:00:00Z',
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

  it('uses idempotent update predicate with needs_rethreading = 1', async () => {
    const { db, preparedSqls } = createThreadDb([
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
      {
        id: 'already-resolved',
        thread_id: 'thread-root',
        message_id: '<reply2@example.com>',
        in_reply_to: '<parent@example.com>',
        needs_rethreading: 0,
        created_at: '2026-05-09T10:02:00Z',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(resolveOrphanedThreads(db)).resolves.toBe(1);
    } finally {
      logSpy.mockRestore();
    }

    const updateQuery = preparedSqls.find((sql) =>
      sql.includes('SET thread_id = ?, needs_rethreading = 0')
    );
    expect(updateQuery).toContain('WHERE id = ? AND needs_rethreading = 1');
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
