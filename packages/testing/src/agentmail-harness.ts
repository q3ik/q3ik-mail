export interface AgentMailMailbox {
  id: string;
  email: string;
}

export interface AgentMailMessage {
  id: string;
  subject?: string;
  headers?: Record<string, string>;
  parsed_headers?: Record<string, string>;
  raw_headers?: Record<string, string> | string;
  [key: string]: unknown;
}

interface AgentMailMessagesResponse {
  messages: AgentMailMessage[];
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type AgentMailMessageFilter = (message: AgentMailMessage) => boolean;

export interface WaitForEmailOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  filter?: AgentMailMessageFilter;
}

export class AgentMailClient {
  private readonly baseUrl: string;
  #apiKey: string;

  constructor(
    apiKey: string,
    options?: { baseUrl?: string }
  ) {
    this.#apiKey = apiKey;
    this.baseUrl = options?.baseUrl ?? 'https://api.agentmail.to/v0';
  }

  toJSON() {
    return { type: 'AgentMailClient' };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'AgentMailClient [key redacted]';
  }

  private async request(
    path: string,
    init: RequestInit | undefined,
    options: { allowStatuses?: number[]; expectJson: false }
  ): Promise<void>;

  private async request<T>(
    path: string,
    init?: RequestInit,
    options?: { allowStatuses?: number[]; expectJson?: true }
  ): Promise<T>;

  private async request<T>(
    path: string,
    init?: RequestInit,
    options?: { allowStatuses?: number[]; expectJson?: boolean }
  ): Promise<T | void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init?.headers ?? {}),
      },
    });

    const allowStatuses = options?.allowStatuses ?? [];
    if (!res.ok && !allowStatuses.includes(res.status)) {
      const errorBody = await res.text();
      if (process.env.DEBUG) console.debug('AgentMail error body:', errorBody);
      throw new Error(`AgentMail API error ${res.status} on ${path}`);
    }

    // Caller explicitly opted out of JSON parsing — return without reading body.
    if (options?.expectJson === false) return;

    // Issue 2 fix: a 204 on the default path returns undefined rather than
    // throwing. The caller receives undefined (typed as T | void) and can
    // handle it. Only throw when the caller explicitly required JSON (expectJson: true).
    if (res.status === 204) {
      if (options?.expectJson === true) {
        throw new Error(`AgentMail API request expected JSON but received 204 No Content for ${path}`);
      }
      return undefined as unknown as T;
    }

    return res.json() as Promise<T>;
  }

  async createMailbox(): Promise<AgentMailMailbox> {
    const inbox = await this.request<{ inbox_id: string; email: string }>('/inboxes', { method: 'POST' }, { expectJson: true });
    // Normalise the AgentMail response shape to match AgentMailMailbox.
    return { id: inbox.inbox_id, email: inbox.email };
  }

  async listMessages(mailboxId: string): Promise<AgentMailMessage[]> {
    const data = await this.request<AgentMailMessagesResponse>('/inboxes/' + encodeURIComponent(mailboxId) + '/messages', undefined, { expectJson: true });
    return data.messages;
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    await this.request(
      '/inboxes/' + encodeURIComponent(mailboxId),
      { method: 'DELETE' },
      { allowStatuses: [404], expectJson: false }
    );
  }

  async waitForEmail(
    mailboxId: string,
    timeoutOrOptions: number | WaitForEmailOptions = DEFAULT_WAIT_TIMEOUT_MS
  ): Promise<AgentMailMessage> {
    const timeoutMs =
      typeof timeoutOrOptions === 'number'
        ? timeoutOrOptions
        : (timeoutOrOptions.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const pollIntervalMs =
      typeof timeoutOrOptions === 'number'
        ? DEFAULT_POLL_INTERVAL_MS
        : (timeoutOrOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const filter = typeof timeoutOrOptions === 'number' ? undefined : timeoutOrOptions.filter;

    // Issue 1 fix: use a hard deadline so the loop never overshoots timeoutMs.
    // The sleep is capped to the remaining budget so the last iteration does
    // not push the total elapsed time past the caller's deadline.
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let messages: AgentMailMessage[];
      try {
        messages = await this.listMessages(mailboxId);
      } catch (err) {
        console.warn(
          'AgentMail listMessages failed, retrying:',
          err instanceof Error ? err.message : err
        );
        // Back off on transient failure using the same interval as a successful-but-empty poll.
        // Without this, a sustained failure busy-loops for the full timeoutMs budget.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
        continue;
      }
      const message = filter ? messages.find(filter) : messages[0];
      if (message) return message;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }

    throw new Error(filter ? 'Timed out waiting for matching email' : 'Timed out waiting for email');
  }
}
