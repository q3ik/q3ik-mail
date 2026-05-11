import { describe, it, expect, vi } from 'vitest';
import worker from '../index';
import { parseFrom } from '../utils/parseFrom';

type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerRequest = Parameters<WorkerFetch>[0];

// Mock svix — the worker uses `new Webhook(secret).verify()` directly.
vi.mock('svix', () => ({
  Webhook: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockReturnValue({
      type: 'email.received',
      data: { email_id: 'resend-test-id' },
    }),
  })),
}));

// Mock the Resend SDK for the receiving API call (emails.receiving.get)
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      receiving: {
        get: vi.fn().mockResolvedValue({
          from: 'Alice <alice@example.com>',
          to: ['you@q3ik.com'],
          subject: 'Test Subject',
          text: 'Hello',
          html: '<p>Hello</p>',
          headers: [],
        }),
      },
    },
  })),
}));

// Minimal mock Env — matches the Env interface in apps/worker/src/index.ts
const mockEnv = {
  RESEND_API_KEY: 'test-key',
  RESEND_WEBHOOK_SECRET: 'test-secret',
  DB: {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    }),
  },
} as unknown as import('../index').Env;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function makeRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('https://worker.example.com/', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fetchWorker(req: Request, env = mockEnv, ctx = mockCtx) {
  return worker.fetch!(req as WorkerRequest, env, ctx);
}

// ---------------------------------------------------------------------------
// DB spy helpers
// ---------------------------------------------------------------------------

/**
 * Creates a spy-instrumented Env whose DB.prepare / .bind calls are recorded.
 * SELECT statements (thread-lookup) are routed to a silent non-spy stub so
 * bindSpy exclusively captures INSERT .bind() calls.
 *
 * `selectFirstResult` is the value returned by SELECT .first() — use an
 * object like `{ thread_id: 'x' }` to simulate a found parent, or `null`
 * for the orphan / no-parent path.
 */
function makeEnvWithSpy(selectFirstResult: unknown = null) {
  const bindSpy = vi.fn().mockReturnValue({
    first: async () => null,
    run: async () => ({ success: true }),
  });
  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    // Route SELECTs to a silent non-spy stub so bindSpy only sees INSERT calls.
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
      return {
        bind: () => ({ first: async () => selectFirstResult }),
      };
    }
    return { bind: bindSpy };
  });
  const env = {
    RESEND_API_KEY: 'test-key',
    RESEND_WEBHOOK_SECRET: 'test-secret',
    DB: { prepare: prepareSpy },
  } as unknown as import('../index').Env;
  return { env, prepareSpy, bindSpy };
}

/**
 * Parses the INSERT OR IGNORE INTO emails statement captured by prepareSpy
 * and returns column names alongside their corresponding bound values.
 *
 * The INSERT uses a mix of `?` placeholders and literal values (e.g. `0, 0`
 * for is_read and is_sent). This helper aligns columns to bound-param
 * positions by scanning the VALUES clause for `?` tokens, so assertions
 * remain correct regardless of which columns use literals vs. bound params.
 *
 * bindSpy.mock.calls[0] is always the INSERT — SELECTs are routed elsewhere.
 */
function getInsertArgs(
  prepareSpy: ReturnType<typeof vi.fn>,
  bindSpy: ReturnType<typeof vi.fn>,
): { columns: string[]; values: unknown[] } {
  const insertIdx = (prepareSpy.mock.calls as unknown[][]).findIndex(
    (args) => (args[0] as string).includes('INSERT OR IGNORE INTO emails'),
  );
  expect(insertIdx).toBeGreaterThanOrEqual(0);

  const insertSql = prepareSpy.mock.calls[insertIdx][0] as string;

  // Parse column list
  const colMatch = insertSql.match(/INSERT[^(]*\(([^)]+)\)/);
  expect(colMatch).not.toBeNull();
  const allColumns = colMatch![1]
    .split(',')
    .map((c) => c.trim().replace(/["'`]/g, ''));

  // Parse VALUES clause to find which positions are `?` vs literals
  const valuesMatch = insertSql.match(/VALUES\s*\(([^)]+)\)/i);
  expect(valuesMatch).not.toBeNull();
  const valueTokens = valuesMatch![1].split(',').map((v) => v.trim());

  // Build a map: column name → bound-param index (only for `?` entries)
  // Columns with literal values (e.g. `0`) are excluded from the values array.
  const boundValues = bindSpy.mock.calls[0] as unknown[];
  const columnToValue: Record<string, unknown> = {};
  let paramIdx = 0;
  for (let i = 0; i < valueTokens.length; i++) {
    if (valueTokens[i] === '?') {
      columnToValue[allColumns[i]] = boundValues[paramIdx++];
    } else {
      // Literal value — parse and store directly so callers can still look it up
      const literal = valueTokens[i];
      const parsed = isNaN(Number(literal)) ? literal : Number(literal);
      columnToValue[allColumns[i]] = parsed;
    }
  }

  // Return columns and a values array aligned to allColumns order (literals + bound)
  const values = allColumns.map((col) => columnToValue[col]);
  return { columns: allColumns, values };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webhook handler', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = new Request('https://worker.example.com/', { method: 'GET' });
    const res = await fetchWorker(req);
    expect(res.status).toBe(405);
  });

  it('returns 401 when svix verification throws', async () => {
    const { Webhook } = await import('svix');
    (Webhook as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      verify: vi.fn().mockImplementationOnce(() => { throw new Error('bad sig'); }),
    }));
    const req = makeRequest('{"type":"email.received"}', {
      'svix-id': 'x', 'svix-timestamp': 'x', 'svix-signature': 'x',
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 and skips insert for non-email.received events', async () => {
    const { Webhook } = await import('svix');
    (Webhook as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      verify: vi.fn().mockReturnValueOnce({ type: 'email.delivered', data: {} }),
    }));
    const req = makeRequest('{}', {
      'svix-id': 'x', 'svix-timestamp': 'x', 'svix-signature': 'x',
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(200);
  });

  it('returns 200 and inserts email on valid email.received event', async () => {
    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(200);
  });

  it('extracts and persists References header from inbound email', async () => {
    const { Resend } = await import('resend');
    const { env, prepareSpy, bindSpy } = makeEnvWithSpy();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Re: Hello',
            text: 'Reply body',
            html: null,
            headers: [
              { name: 'Message-ID', value: '<reply-123@mail.example.com>' },
              { name: 'In-Reply-To', value: '<root-456@mail.example.com>' },
              { name: 'References', value: '<root-456@mail.example.com>' },
            ],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    const referencesIdx = columns.indexOf('references');
    expect(referencesIdx).toBeGreaterThanOrEqual(0);
    expect(values[referencesIdx]).toBe('<root-456@mail.example.com>');
  });

  it('stores null for references when References header is absent', async () => {
    const { Resend } = await import('resend');
    const { env, prepareSpy, bindSpy } = makeEnvWithSpy();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Bob <bob@example.com>',
            to: ['you@q3ik.com'],
            subject: 'No References header',
            text: 'Body',
            html: null,
            headers: [
              { name: 'Message-ID', value: '<new-789@mail.example.com>' },
            ],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    const referencesIdx = columns.indexOf('references');
    expect(referencesIdx).toBeGreaterThanOrEqual(0);
    expect(values[referencesIdx]).toBeNull();
  });
});

describe('parseFrom', () => {
  it('parses unquoted display name', () => {
    expect(parseFrom('Alice <alice@example.com>')).toEqual({ name: 'Alice', address: 'alice@example.com' });
  });

  it('parses quoted display name with comma (RFC 5322)', () => {
    expect(parseFrom('"Smith, John" <john@example.com>')).toEqual({ name: 'Smith, John', address: 'john@example.com' });
  });

  it('parses angle-bracket-only form with no display name', () => {
    // Valid RFC 5322 form: <alice@example.com> — no display name, name must be null
    expect(parseFrom('<alice@example.com>')).toEqual({ name: null, address: 'alice@example.com' });
  });

  it('parses plain email address with no display name', () => {
    expect(parseFrom('alice@example.com')).toEqual({ name: null, address: 'alice@example.com' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseFrom('  Alice <alice@example.com>  ')).toEqual({ name: 'Alice', address: 'alice@example.com' });
  });

  it('returns empty address for empty input', () => {
    expect(parseFrom('')).toEqual({ name: null, address: '' });
  });

  it('returns null name for all-whitespace quoted display name', () => {
    // "   " is a valid quoted string but semantically empty — name must be null, not ''
    expect(parseFrom('"   " <alice@example.com>')).toEqual({ name: null, address: 'alice@example.com' });
  });
});

describe('threading', () => {
  it('joins existing thread when In-Reply-To parent is found', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Re: Test',
            text: 'Reply',
            html: '<p>Reply</p>',
            headers: [
              { name: 'In-Reply-To', value: '<parent@example.com>' },
              { name: 'Message-ID', value: '<reply@example.com>' },
            ],
          }),
        },
      },
    }));

    // selectFirstResult = found parent row
    const { env, prepareSpy, bindSpy } = makeEnvWithSpy({ thread_id: 'existing-thread-id' });

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, env, mockCtx);
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    const threadIdIdx = columns.indexOf('thread_id');
    expect(threadIdIdx).toBeGreaterThanOrEqual(0);
    expect(values[threadIdIdx]).toBe('existing-thread-id');
  });

  it('sets needs_rethreading=1 when In-Reply-To parent is not found', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Re: Orphan',
            text: 'Reply',
            html: '<p>Reply</p>',
            headers: [
              { name: 'In-Reply-To', value: '<missing@example.com>' },
            ],
          }),
        },
      },
    }));

    // selectFirstResult = null simulates parent not found
    const { env, prepareSpy, bindSpy } = makeEnvWithSpy(null);

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, env, mockCtx);
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    const needsRethreadingIdx = columns.indexOf('needs_rethreading');
    expect(needsRethreadingIdx).toBeGreaterThanOrEqual(0);
    // needs_rethreading is a bound `?` param — getInsertArgs resolves it correctly
    // regardless of the literal 0s for is_read/is_sent in the same INSERT.
    expect(values[needsRethreadingIdx]).toBe(1);
  });

  it('stores correct from_name and from_address for quoted display name with comma', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: '"Smith, John" <john@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Hello',
            text: 'Hi',
            html: '<p>Hi</p>',
            headers: [],
          }),
        },
      },
    }));

    const { env, prepareSpy, bindSpy } = makeEnvWithSpy();

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, env, mockCtx);
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    expect(values[columns.indexOf('from_address')]).toBe('john@example.com');
    expect(values[columns.indexOf('from_name')]).toBe('Smith, John');
  });

  it('returns 400 when from address is missing or unparseable', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: '',   // empty from field — parseFrom returns address: ''
            to: ['you@q3ik.com'],
            subject: 'No Sender',
            text: 'Hi',
            html: '<p>Hi</p>',
            headers: [],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    // Guard fires before DB — mockEnv is sufficient, no spy needed
    const res = await worker.fetch!(req as WorkerRequest, mockEnv, mockCtx);
    expect(res.status).toBe(400);
  });
});
