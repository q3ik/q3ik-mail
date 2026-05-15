'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  getLatestEmails,
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
  const { env } = getCloudflareContext();
  return getThreadList(env.DB, limit);
}

export async function fetchThreadListPage(limit = 50, cursor?: string) {
  const { env } = getCloudflareContext();
  return getThreadListPage(env.DB, { limit, cursor });
}

export async function fetchLatestEmails(limit = 50) {
  const { env } = getCloudflareContext();
  return getLatestEmails(env.DB, limit);
}

export async function fetchThread(threadId: string) {
  const { env } = getCloudflareContext();
  return getEmailsByThread(env.DB, threadId, getOptionalEmailBodiesBucket(env));
}

export async function fetchEmailById(emailId: string) {
  const { env } = getCloudflareContext();
  return getEmailById(env.DB, emailId, getOptionalEmailBodiesBucket(env));
}

export async function markEmailAsRead(emailId: string) {
  const { env } = getCloudflareContext();
  return markAsRead(env.DB, emailId);
}
