import { migrateEmailBodiesToR2 } from '@q3ik-mail/database';
import type { Env } from '../index';

export interface EmailBodyMigrationResult {
  migrated: number;
  completed: boolean;
}

/**
 * One-time body backfill helper.
 * Uploads legacy D1 body_text/body_html content to R2 and stores key columns.
 */
export async function runEmailBodyMigration(
  env: Pick<Env, 'DB' | 'EMAIL_BODIES'>,
  batchSize: number = 100
): Promise<EmailBodyMigrationResult> {
  const migrated = await migrateEmailBodiesToR2(env.DB, env.EMAIL_BODIES, batchSize);
  return {
    migrated,
    completed: migrated < batchSize,
  };
}
