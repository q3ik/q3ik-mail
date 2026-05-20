'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  getEmailsByThread,
  getThreadList,
  getThreadListPage,
  markAsRead,
  getEmailById,
} from '@q3ik-mail/database';

function getOptionalEmailBodiesBucket(env: CloudflareEnv): R2Bucket | null {
  return 'EMAIL_BODIES' in env ? (env.EMAIL_BODIES as R2Bucket) : null;
}

export async function fetchThreadList(limit = 50) {
  const { env } = await getCloudflareContext({ async: true });
  return getThreadList(env.DB, limit);
}

export async function fetchThreadListPage(limit = 50, cursor?: string) {
  const { env } = await getCloudflareContext({ async: true });
  return getThreadListPage(env.DB, {
    limit,
    cursor,
    cursorSecret: env.THREAD_LIST_CURSOR_SECRET,
  });
}

export async function fetchThread(threadId: string) {
  const { env } = await getCloudflareContext({ async: true });
  return getEmailsByThread(env.DB, threadId, getOptionalEmailBodiesBucket(env));
}

export async function fetchEmailById(emailId: string) {
  const { env } = await getCloudflareContext({ async: true });
  return getEmailById(env.DB, emailId, getOptionalEmailBodiesBucket(env));
}

export async function markEmailAsRead(emailId: string) {
  const { env } = await getCloudflareContext({ async: true });
  return markAsRead(env.DB, emailId);
}
