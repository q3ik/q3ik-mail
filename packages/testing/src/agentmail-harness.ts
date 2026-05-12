export interface AgentMailMailbox {
  id: string;
  email: string;
}

export interface AgentMailMessage {
  id: string;
  subject?: string;
  headers?: Record<string, string>;
  parsed_headers?: Record<string, string>;
  raw_headers?: Record<string, string>;
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

  constructor(
    private readonly apiKey: string,
    options?: { baseUrl?: string }
  ) {
    this.baseUrl = options?.baseUrl ?? 'https://api.agentmail.to/v1';
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
        Authorization: `Bearer ${this.apiKey}`,
        ...(init?.headers ?? {}),
      },
    });

    const allowStatuses = options?.allowStatuses ?? [];
    if (!res.ok && !allowStatuses.includes(res.status)) {
      const errorBody = await res.text();
      throw new Error(`AgentMail API request failed (${res.status}): ${errorBody}`);
    }

    if (options?.expectJson === false) return;
    if (res.status === 204) {
      throw new Error(`AgentMail API request expected JSON but received 204 No Content for ${path}`);
    }

    return res.json() as Promise<T>;
  }

  async createMailbox(): Promise<AgentMailMailbox> {
    return this.request<AgentMailMailbox>('/mailboxes', { method: 'POST' });
  }

  async listMessages(mailboxId: string): Promise<AgentMailMessage[]> {
    const data = await this.request<AgentMailMessagesResponse>(`/mailboxes/${mailboxId}/messages`);
    return data.messages;
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    await this.request<void>(
      `/mailboxes/${mailboxId}`,
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
    const start = Date.now();

    while (true) {
      if (Date.now() - start >= timeoutMs) break;
      const messages = await this.listMessages(mailboxId);
      const message = filter ? messages.find(filter) : messages[0];
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(filter ? 'Timed out waiting for matching email' : 'Timed out waiting for email');
  }
}
