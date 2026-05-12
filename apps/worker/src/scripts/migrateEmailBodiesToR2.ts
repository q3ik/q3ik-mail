import { migrateEmailBodiesToR2 } from '@q3ik-mail/database';
import type { Env } from '../index';

export interface EmailBodyMigrationResult {
  migrated: number;
  completed: boolean;
}

/**
 * One-time body backfill helper.
 * Uploads legacy D1 body_text/body_html content to R2 and stores key columns.
 *
 * `completed` is true when the batch returned zero rows, meaning no more
 * unmigrated emails remain. The caller should loop until completed === true.
 *
 * Note: `migrated === batchSize` does NOT mean incomplete — the correct
 * termination signal is `migrated === 0` (empty batch returned by the query).
 */
export async function runEmailBodyMigration(
  env: Pick<Env, 'DB' | 'EMAIL_BODIES'>,
  batchSize: number = 100
): Promise<EmailBodyMigrationResult> {
  if (!env.EMAIL_BODIES) {
    throw new Error('EMAIL_BODIES R2 bucket is not bound in this environment');
  }
  const migrated = await migrateEmailBodiesToR2(env.DB, env.EMAIL_BODIES, batchSize);
  return {
    migrated,
    // completed when the last batch was empty — handles the case where total
    // row count is exactly divisible by batchSize without an off-by-one call.
    completed: migrated === 0,
  };
}
