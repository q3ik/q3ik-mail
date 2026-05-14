import { describe, it, expect, vi } from 'vitest';
import worker from '../index';
import { parseFrom } from '../utils/parseFrom';

type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerRequest = Parameters<WorkerFetch>[0];
type Uint8ArrayConstructorWithFromBase64 = Uint8ArrayConstructor & {
  fromBase64?: (input: string) => Uint8Array;
};

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

vi.mock('../middleware/cfAccess', () => ({
  validateCfAccessJwt: vi.fn().mockResolvedValue({
    ok: true,
    payload: { sub: 'test-user' },
  }),
}));

// Minimal mock Env — matches the Env interface in apps/worker/src/index.ts
const mockEnv = {
  RESEND_API_KEY: 'test-key',
  RESEND_WEBHOOK_SECRET: 'test-secret',
  CLOUDFLARE_ACCESS_AUD: 'test-aud',
  CLOUDFLARE_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  WEBHOOK_RATE_LIMITER: {
    limit: vi.fn().mockResolvedValue({ success: true }),
  },
  EMAIL_BODIES: {
    put: async () => {},
  },
  DB: {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 1 } }),
      }),
    }),
  },
} as unknown as import('../index').Env;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function makeRequest(
  body: string,
  headers: Record<string, string> = {},
  path = '/'
) {
  return new Request(`https://worker.example.com${path}`, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'Cf-Access-Jwt-Assertion': 'test-jwt',
      ...headers,
    },
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
 * SELECT statements are routed to silent non-spy stubs so bindSpy exclusively
 * captures INSERT .bind() calls.
 *
 * `selectFirstResult` is the value returned by the thread-lookup SELECT
 * (`WHERE message_id = ?`). Use an object like `{ thread_id: 'x' }` to simulate
 * a found parent, or `null` for the orphan / no-parent path.
 *
 * `existingResendId` is the value returned by the duplicate-detection SELECT
 * (`WHERE resend_id = ?`). Defaults to `null` (not a duplicate) so that tests
 * reach the full ingestion path. Pass a non-null value to simulate a duplicate.
 *
 * `dedupBindSpy` is a separate spy wired into the resend_id SELECT stub.
 * Inspect it to assert that the dedup query was called with the correct emailId.
 * It is distinct from `bindSpy` (which only captures INSERT .bind() calls).
 */
function makeThreadEnv(selectFirstResult: unknown = null, existingResendId: unknown = null) {
  const bindSpy = vi.fn().mockReturnValue({
    first: async () => null,
    run: async () => ({ success: true, meta: { changes: 1 } }),
  });
  // Separate spy for the duplicate-detection SELECT bind() so tests can assert
  // the correct emailId is passed without polluting the INSERT bindSpy.
  const dedupBindSpy = vi.fn().mockReturnValue({
    first: async () => existingResendId,
  });
  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    // Route SELECTs to silent non-spy stubs so bindSpy only sees INSERT calls.
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
      // The duplicate-detection query checks resend_id — use dedupBindSpy so
      // tests can assert the correct emailId is passed to the dedup query.
      if (sql.includes('resend_id')) {
        return { bind: dedupBindSpy };
      }
      // All other SELECTs (e.g. thread-lookup by message_id) use the caller's value.
      return {
        bind: () => ({ first: async () => selectFirstResult }),
      };
    }
    return { bind: bindSpy };
  });
  const putSpy = vi.fn().mockResolvedValue(undefined);
  const rateLimitSpy = vi.fn().mockResolvedValue({ success: true });
  const env = {
    RESEND_API_KEY: 'test-key',
    RESEND_WEBHOOK_SECRET: 'test-secret',
    CLOUDFLARE_ACCESS_AUD: 'test-aud',
    CLOUDFLARE_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    WEBHOOK_RATE_LIMITER: { limit: rateLimitSpy },
    EMAIL_BODIES: { put: putSpy },
    DB: { prepare: prepareSpy },
  } as unknown as import('../index').Env;
  return { env, prepareSpy, bindSpy, dedupBindSpy, putSpy, rateLimitSpy };
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

  it('returns 401 when Cloudflare Access validation fails', async () => {
    const { validateCfAccessJwt } = await import('../middleware/cfAccess');
    (validateCfAccessJwt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'Missing Cf-Access-Jwt-Assertion header',
    });

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

  it('returns 429 when the webhook rate limiter denies POST /api/webhook', async () => {
    const { env, rateLimitSpy } = makeThreadEnv();
    rateLimitSpy.mockResolvedValueOnce({ success: false });

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
      'CF-Connecting-IP': '203.0.113.5',
    }, '/api/webhook');
    const res = await fetchWorker(req, env);

    expect(res.status).toBe(429);
    expect(await res.text()).toBe('Too Many Requests');
    expect(rateLimitSpy).toHaveBeenCalledWith({ key: '203.0.113.5' });
  });

  it('uses "unknown" as webhook rate limit key when CF-Connecting-IP is absent', async () => {
    const { env, rateLimitSpy } = makeThreadEnv();

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    }, '/api/webhook');
    const res = await fetchWorker(req, env);

    expect(res.status).toBe(200);
    expect(rateLimitSpy).toHaveBeenCalledWith({ key: 'unknown' });
  });

  it('stores text body in R2 and persists the `body_text_key` in D1', async () => {
    const { Resend } = await import('resend');
    const { env, prepareSpy, bindSpy, putSpy } = makeThreadEnv();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Body Mapping',
            text: 'Plain text from text field',
            // A `body_text` key in the payload must NOT reach D1 body_text;
            // the worker must always read from `text`, never from `body_text`.
            body_text: 'legacy field should be ignored',
            html: null,
            headers: [{ name: 'Message-ID', value: '<body-map@example.com>' }],
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
    expect(values[columns.indexOf('body_text')]).toBeNull();
    const bodyTextKey = values[columns.indexOf('body_text_key')];
    expect(bodyTextKey).toMatch(/^emails\/.+\/body\.txt$/);
    expect(putSpy).toHaveBeenCalledWith(
      bodyTextKey,
      'Plain text from text field',
      expect.objectContaining({
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      })
    );
  });

  it('accepts HTML-only email where `text` key is absent (no 502)', async () => {
    const { Resend } = await import('resend');
    const { env, prepareSpy, bindSpy, putSpy } = makeThreadEnv();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'HTML Only',
            // `text` key is intentionally absent — HTML-only sender
            html: '<p>HTML body</p>',
            headers: [{ name: 'Message-ID', value: '<html-only@example.com>' }],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);
    // Must not 502 — missing `text` key is valid for HTML-only senders
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    expect(values[columns.indexOf('body_text')]).toBeNull();
    expect(values[columns.indexOf('body_html')]).toBeNull();
    expect(values[columns.indexOf('body_text_key')]).toBeNull();
    const bodyHtmlKey = values[columns.indexOf('body_html_key')];
    expect(bodyHtmlKey).toMatch(/^emails\/.+\/body\.html$/);
    expect(putSpy).toHaveBeenCalledWith(
      bodyHtmlKey,
      '<p>HTML body</p>',
      expect.objectContaining({
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      })
    );
  });

  it('returns 502 when Resend payload has a non-string, non-null `text` field', async () => {
    const { Resend } = await import('resend');

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Bad text type',
            text: 12345,  // wrong type — should trigger 502
            html: null,
            headers: [],
          }),
        },
      },
    }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
        'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
      });
      const res = await fetchWorker(req);
      expect(res.status).toBe(502);
      // Verify the field name is included in the diagnostic log
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('field="text"'),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('extracts and persists References header from inbound email', async () => {
    const { Resend } = await import('resend');
    const { env, prepareSpy, bindSpy } = makeThreadEnv();

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
    const { env, prepareSpy, bindSpy } = makeThreadEnv();

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

  it('stores inline attachment content under the required R2 attachments key prefix', async () => {
    const { Resend } = await import('resend');
    const { env, putSpy } = makeThreadEnv();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Bob <bob@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Attachment',
            text: null,
            html: null,
            attachments: [
              {
                filename: 'invoice.pdf',
                content: 'aGVsbG8=',
                content_type: 'application/pdf',
              },
            ],
            headers: [{ name: 'Message-ID', value: '<attachment@example.com>' }],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);
    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^emails\/.+\/attachments\/invoice\.pdf$/),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/pdf' },
      })
    );
  });

  it('persists attachment metadata rows in D1 after storing attachments in R2', async () => {
    const { Resend } = await import('resend');
    const { env, bindSpy } = makeThreadEnv();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Bob <bob@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Attachment metadata',
            text: null,
            html: null,
            attachments: [
              {
                filename: 'invoice.pdf',
                content: 'aGVsbG8=',
                content_type: 'application/pdf',
              },
            ],
            headers: [{ name: 'Message-ID', value: '<attachment-meta@example.com>' }],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);
    expect(res.status).toBe(200);

    const emailInsertValues = bindSpy.mock.calls[0] as unknown[];
    const attachmentInsertValues = bindSpy.mock.calls.find(
      (call) => call.length === 7 && call.includes('invoice.pdf')
    ) as unknown[] | undefined;

    expect(attachmentInsertValues).toBeDefined();
    const [
      _attachmentId,
      attachmentEmailId,
      attachmentR2Key,
      attachmentFilename,
      attachmentContentType,
      attachmentSizeBytes,
      attachmentCreatedAt,
    ] = attachmentInsertValues!;

    expect(attachmentEmailId).toBe(emailInsertValues[0]);
    expect(String(attachmentR2Key)).toMatch(/^emails\/.+\/attachments\/invoice\.pdf$/);
    expect(attachmentFilename).toBe('invoice.pdf');
    expect(attachmentContentType).toBe('application/pdf');
    expect(attachmentSizeBytes).toBe(5);
    expect(typeof attachmentCreatedAt).toBe('number');
  });

  it('decodes standard, URL-safe, and unpadded base64 attachment content', async () => {
    const { Resend } = await import('resend');
    const { env, putSpy } = makeThreadEnv();

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Attachment base64 variants',
            text: 'Body',
            html: null,
            headers: [],
            attachments: [
              {
                filename: 'standard.bin',
                content_type: 'application/octet-stream',
                content: 'aGVsbG8=',
              },
              {
                filename: 'url-safe.bin',
                content_type: 'application/octet-stream',
                // URL-safe base64 for bytes [251, 239, 255].
                content: '--__',
              },
              {
                filename: 'unpadded.bin',
                content_type: 'application/octet-stream',
                // Standard base64 without padding for "hello".
                content: 'aGVsbG8',
              },
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

    const expectedBytesByFilename: Record<string, number[]> = {
      'standard.bin': [104, 101, 108, 108, 111],
      'url-safe.bin': [251, 239, 255],
      'unpadded.bin': [104, 101, 108, 108, 111],
    };

    for (const [filename, expectedBytes] of Object.entries(expectedBytesByFilename)) {
      const attachmentPutCall = putSpy.mock.calls.find((call) =>
        String(call[0]).includes(`/attachments/${filename}`)
      );
      if (!attachmentPutCall) {
        throw new Error(`No R2 put call found for attachment: ${filename}`);
      }
      expect(Array.from(attachmentPutCall[1] as Uint8Array)).toEqual(expectedBytes);
    }
  });

  it('falls back to atob decoding when Uint8Array.fromBase64 is unavailable', async () => {
    const { Resend } = await import('resend');
    const { env, putSpy } = makeThreadEnv();

    const hadFromBase64 = Object.hasOwn(Uint8Array, 'fromBase64');
    const originalFromBase64 = (Uint8Array as Uint8ArrayConstructorWithFromBase64).fromBase64;
    Object.defineProperty(Uint8Array, 'fromBase64', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    try {
      (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        emails: {
          receiving: {
            get: vi.fn().mockResolvedValue({
              from: 'Alice <alice@example.com>',
              to: ['you@q3ik.com'],
              subject: 'Attachment fallback decode',
              text: 'Body',
              html: null,
              headers: [],
              attachments: [
                {
                  filename: 'fallback.bin',
                  content_type: 'application/octet-stream',
                  content: '--__',
                },
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

      const attachmentPutCall = putSpy.mock.calls.find((call) =>
        String(call[0]).includes('/attachments/fallback.bin')
      );
      if (!attachmentPutCall) {
        throw new Error('No R2 put call found for attachment: fallback.bin');
      }
      expect(Array.from(attachmentPutCall[1] as Uint8Array)).toEqual([251, 239, 255]);
    } finally {
      if (!hadFromBase64) {
        delete (Uint8Array as Uint8ArrayConstructorWithFromBase64).fromBase64;
      } else {
        Object.defineProperty(Uint8Array, 'fromBase64', {
          value: originalFromBase64,
          writable: true,
          configurable: true,
        });
      }
    }
  });


  it('enforces single and cumulative attachment size limits before loading content', async () => {
    const { Resend } = await import('resend');
    const { env, putSpy } = makeThreadEnv();

    env.MAX_SINGLE_ATTACHMENT_BYTES = '10';
    env.MAX_TOTAL_ATTACHMENT_BYTES = '16';

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Bob <bob@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Attachment limits',
            text: null,
            html: null,
            attachments: [
              { filename: 'too-large.bin', size: 12, content: 'aGVsbG8=' },
              { filename: 'first-ok.bin', size: 9, content: 'aGVsbG8=' },
              { filename: 'would-exceed-total.bin', size: 9, content: 'aGVsbG8=' },
            ],
            headers: [{ name: 'Message-ID', value: '<attachment-limits@example.com>' }],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);
    expect(res.status).toBe(200);

    const attachmentPutKeys = putSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((key) => key.includes('/attachments/'));

    expect(attachmentPutKeys.some((key) => key.endsWith('/first-ok.bin'))).toBe(true);
    expect(attachmentPutKeys.some((key) => key.endsWith('/too-large.bin'))).toBe(false);
    expect(attachmentPutKeys.some((key) => key.endsWith('/would-exceed-total.bin'))).toBe(false);
  });

  it('streams URL-based attachments directly to R2 without arrayBuffer buffering', async () => {
    const { Resend } = await import('resend');
    const { env, putSpy } = makeThreadEnv();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }), { status: 200 })
    );

    try {
      (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        emails: {
          receiving: {
            get: vi.fn().mockResolvedValue({
              from: 'Bob <bob@example.com>',
              to: ['you@q3ik.com'],
              subject: 'URL attachment',
              text: null,
              html: null,
              attachments: [
                {
                  filename: 'remote.pdf',
                  url: 'https://example.com/remote.pdf',
                  content_type: 'application/pdf',
                  size: 3,
                },
              ],
              headers: [{ name: 'Message-ID', value: '<attachment-url@example.com>' }],
            }),
          },
        },
      }));

      const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
        'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
      });
      const res = await fetchWorker(req, env);
      expect(res.status).toBe(200);

      const attachmentPutCall = putSpy.mock.calls.find((call) =>
        String(call[0]).includes('/attachments/remote.pdf')
      );
      expect(attachmentPutCall).toBeDefined();
      expect(attachmentPutCall?.[1]).toBeInstanceOf(ReadableStream);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('streams attachment-id-based attachments directly to R2 without arrayBuffer buffering', async () => {
    const { Resend } = await import('resend');
    const { env, putSpy } = makeThreadEnv();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      }), { status: 200 })
    );

    try {
      (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        emails: {
          receiving: {
            get: vi.fn().mockResolvedValue({
              from: 'Bob <bob@example.com>',
              to: ['you@q3ik.com'],
              subject: 'ID attachment',
              text: null,
              html: null,
              attachments: [
                {
                  filename: 'photo.jpg',
                  id: 'attach-001',
                  content_type: 'image/jpeg',
                  size: 3,
                },
              ],
              headers: [{ name: 'Message-ID', value: '<attachment-id@example.com>' }],
            }),
          },
        },
      }));

      const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
        'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
      });
      const res = await fetchWorker(req, env);
      expect(res.status).toBe(200);

      const attachmentPutCall = putSpy.mock.calls.find((call) =>
        String(call[0]).includes('/attachments/photo.jpg')
      );
      expect(attachmentPutCall).toBeDefined();
      expect(attachmentPutCall?.[1]).toBeInstanceOf(ReadableStream);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('persists estimatedSizeBytes in D1 metadata for streamed (URL) attachments', async () => {
    const { Resend } = await import('resend');
    const { env, bindSpy } = makeThreadEnv();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }), { status: 200 })
    );

    try {
      (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        emails: {
          receiving: {
            get: vi.fn().mockResolvedValue({
              from: 'Carol <carol@example.com>',
              to: ['you@q3ik.com'],
              subject: 'Streamed metadata',
              text: null,
              html: null,
              attachments: [
                {
                  filename: 'data.bin',
                  url: 'https://example.com/data.bin',
                  content_type: 'application/octet-stream',
                  size: 1024,
                },
              ],
              headers: [{ name: 'Message-ID', value: '<streamed-meta@example.com>' }],
            }),
          },
        },
      }));

      const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
        'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
      });
      const res = await fetchWorker(req, env);
      expect(res.status).toBe(200);

      const attachmentInsertValues = bindSpy.mock.calls.find(
        (call) => call.length === 7 && call.includes('data.bin')
      ) as unknown[] | undefined;

      expect(attachmentInsertValues).toBeDefined();
      // sizeBytes should equal the `size` field from the attachment metadata (1024),
      // not undefined (which would happen if data.byteLength were used on a ReadableStream).
      expect(attachmentInsertValues![5]).toBe(1024);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('returns 200 and performs no R2/D1 writes when a duplicate resend_id is received', async () => {
    // `existingResendId` causes the resend_id SELECT stub to return an existing
    // row, simulating a duplicate delivery. `dedupBindSpy` captures what value
    // was passed to .bind() on the dedup SELECT, proving the correct emailId
    // is used — not undefined or a hardcoded value.
    const { env, prepareSpy, bindSpy, dedupBindSpy, putSpy } = makeThreadEnv(
      null,
      { id: 'existing-email-id' },
    );

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req, env);

    // Must return 200 OK immediately without touching R2 or D1 further.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Already ingested');

    // The dedup SELECT must have been prepared with a query referencing resend_id.
    const dedupSelectCall = (prepareSpy.mock.calls as unknown[][]).find(
      (args) => (args[0] as string).includes('resend_id'),
    );
    expect(dedupSelectCall).toBeDefined();

    // The dedup SELECT bind() must have been called with the correct emailId.
    // The svix mock returns email_id = 'resend-test-id'; verify that exact value
    // was passed — catches any regression where undefined or a wrong ID is bound.
    expect(dedupBindSpy).toHaveBeenCalledWith('resend-test-id');

    // No R2 writes should have occurred.
    expect(putSpy).not.toHaveBeenCalled();

    // No D1 INSERT should have been prepared.
    const insertCall = (prepareSpy.mock.calls as unknown[][]).find(
      (args) => (args[0] as string).includes('INSERT'),
    );
    expect(insertCall).toBeUndefined();

    // bindSpy (INSERT path) must not have been called — the early-exit fired.
    expect(bindSpy).not.toHaveBeenCalled();
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
    const { env, prepareSpy, bindSpy } = makeThreadEnv({ thread_id: 'existing-thread-id' });

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
    const { env, prepareSpy, bindSpy } = makeThreadEnv(null);

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, env, mockCtx);
    expect(res.status).toBe(200);

    const { columns, values } = getInsertArgs(prepareSpy, bindSpy);
    const threadIdIdx = columns.indexOf('thread_id');
    const needsRethreadingIdx = columns.indexOf('needs_rethreading');
    expect(threadIdIdx).toBeGreaterThanOrEqual(0);
    expect(needsRethreadingIdx).toBeGreaterThanOrEqual(0);
    expect(values[threadIdIdx]).toBe('<missing@example.com>');
    // needs_rethreading is a bound `?` param — getInsertArgs resolves it correctly
    // regardless of the literal 0s for is_read/is_sent in the same INSERT.
    expect(values[needsRethreadingIdx]).toBe(1);
  });

  it('does not merge separate root emails that share the same subject', async () => {
    const { Resend } = await import('resend');

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Daily Standup',
            text: 'Thread A',
            html: '<p>Thread A</p>',
            headers: [
              { name: 'Message-ID', value: '<thread-a@example.com>' },
            ],
          }),
        },
      },
    }));

    const { env: firstEnv, prepareSpy: firstPrepareSpy, bindSpy: firstBindSpy } = makeThreadEnv();
    const firstReq = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const firstRes = await worker.fetch!(firstReq as WorkerRequest, firstEnv, mockCtx);
    expect(firstRes.status).toBe(200);

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Bob <bob@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Daily Standup',
            text: 'Thread B',
            html: '<p>Thread B</p>',
            headers: [
              { name: 'Message-ID', value: '<thread-b@example.com>' },
            ],
          }),
        },
      },
    }));

    const { env: secondEnv, prepareSpy: secondPrepareSpy, bindSpy: secondBindSpy } = makeThreadEnv();
    const secondReq = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const secondRes = await worker.fetch!(secondReq as WorkerRequest, secondEnv, mockCtx);
    expect(secondRes.status).toBe(200);

    const firstInsert = getInsertArgs(firstPrepareSpy, firstBindSpy);
    const secondInsert = getInsertArgs(secondPrepareSpy, secondBindSpy);
    expect(firstInsert.values[firstInsert.columns.indexOf('thread_id')]).toBe('<thread-a@example.com>');
    expect(secondInsert.values[secondInsert.columns.indexOf('thread_id')]).toBe('<thread-b@example.com>');
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

    const { env, prepareSpy, bindSpy } = makeThreadEnv();

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
