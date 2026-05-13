declare module '@sentry/cloudflare' {
  export function captureMessage(
    message: string,
    context?: { level?: 'error' | 'warning' | 'info' | 'debug'; tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): void;

  export function captureException(
    error: unknown,
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): void;
}
