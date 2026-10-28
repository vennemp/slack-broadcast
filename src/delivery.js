import { setTimeout as delay } from 'node:timers/promises';

// Retry only explicit rate-limit rejections: a timeout or lost response may mean
// Slack already accepted the message. SDK automatic retries must be disabled.
export async function postToChannel(client, channel, text, wait = delay, maxRateLimitRetries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await client.chat.postMessage({
        channel, text, unfurl_links: false, unfurl_media: false,
        parse: 'none', link_names: false,
      });
      if (!response.ok) return { status: 'failed', error: response.error || 'unknown_error' };
      return { status: 'sent', ts: response.ts };
    } catch (error) {
      const rateLimited = error.code === 'slack_webapi_rate_limited_error';
      if (rateLimited && attempt < maxRateLimitRetries && error.retryAfter >= 0 && error.retryAfter <= 30) {
        await wait(Math.max(1, error.retryAfter) * 1000);
        continue;
      }
      if (rateLimited) return { status: 'failed', error: 'ratelimited' };
      if (error.code === 'slack_webapi_platform_error') {
        return { status: 'failed', error: error.data?.error || 'unknown_error' };
      }
      return { status: 'unknown' };
    }
  }
}

export async function deliver({ client, journal, draft, wait = delay }) {
  // Replayed submissions never start an existing broadcast again.
  const existing = journal.get(draft.id);
  if (existing) return existing;
  const job = {
    id: draft.id, teamId: draft.teamId, userId: draft.userId,
    createdAt: new Date().toISOString(),
    results: [
      ...[...new Set(draft.channels)].map((channel) => ({ channel, status: 'queued' })),
      ...(draft.skipped || []).map(({ channel, error }) => ({ channel, status: 'failed', error })),
    ],
  };
  await journal.save(job);
  const pending = job.results.filter((result) => result.status === 'queued');
  let cursor = 0;
  let interrupted = false;
  async function worker() {
    try {
      while (!interrupted && cursor < pending.length) {
        const result = pending[cursor++];
        result.status = 'sending';
        // Never make an external send unless its intent was successfully recorded.
        await journal.save(job);
        Object.assign(result, await postToChannel(client, result.channel, draft.text, wait));
        await journal.save(job);
      }
    } catch (error) {
      interrupted = true;
      throw error;
    }
  }
  // Bound concurrency; a rejection must not leave other workers unobserved.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, worker));
  const failure = workers.find((result) => result.status === 'rejected');
  if (failure) {
    for (const result of job.results) {
      if (result.status === 'queued') result.status = 'cancelled';
      if (result.status === 'sending') result.status = 'unknown';
    }
    job.finishedAt = new Date().toISOString();
    // Keep the in-memory receipt accurate even if the disk remains unavailable.
    try { await journal.save(job); } catch { /* The original storage error is reported below. */ }
    throw failure.reason;
  }
  job.finishedAt = new Date().toISOString();
  await journal.save(job);
  return job;
}
