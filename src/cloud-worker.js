import { postToChannel } from './delivery.js';
import { ChannelAccess } from './channel-access.js';

export async function processCloudJob({ id, store, client, access = new ChannelAccess(client), permitted = () => true }) {
  const claimed = await store.claim(id);
  if (claimed.state !== 'claimed') return claimed;
  const { job } = claimed;
  const authorized = await permitted(job.userId, job.teamId);
  const available = authorized ? await access.available(job.userId) : new Set();
  const pending = job.results.filter((result) => result.status === 'queued');
  let cursor = 0;
  let interrupted = false;
  async function worker() {
    try {
      while (!interrupted && cursor < pending.length) {
        const { channel } = pending[cursor++];
        if (!await permitted(job.userId, job.teamId)) {
          await store.checkpoint(id, job.leaseId, channel, { status: 'failed', error: 'sender_not_authorized' });
          continue;
        }
        if (!available.has(channel)) {
          await store.checkpoint(id, job.leaseId, channel, { status: 'failed', error: authorized ? 'channel_access_denied' : 'sender_not_authorized' });
          continue;
        }
        await store.checkpoint(id, job.leaseId, channel, { status: 'sending' });
        // Avoid holding a billed request open through lengthy rate-limit sleeps.
        const outcome = await postToChannel(client, channel, job.text, undefined, 0);
        await store.checkpoint(id, job.leaseId, channel, outcome);
      }
    } catch (error) {
      interrupted = true;
      throw error;
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, worker));
  const failed = workers.find((worker) => worker.status === 'rejected');
  if (failed) throw failed.reason;
  return { state: 'done', job: await store.finish(id, job.leaseId) };
}
