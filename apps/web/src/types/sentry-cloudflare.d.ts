declare module '@sentry/cloudflare' {
  export interface Scope {
    setLevel(level: 'error' | 'warning' | 'info' | 'debug'): void;
    setTags(tags: Record<string, string>): void;
    setExtras(extra: Record<string, unknown>): void;
  }

  export function withScope(callback: (scope: Scope) => void): void;

  export function captureMessage(
    message: string,
    context?: { level?: 'error' | 'warning' | 'info' | 'debug'; tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): void;

  export function captureException(
    error: unknown,
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): void;
}
