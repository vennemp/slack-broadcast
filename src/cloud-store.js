import { randomUUID } from 'node:crypto';

const validId = (id) => /^[0-9a-f-]{36}$/.test(id || '');
const owns = (record, teamId, userId) => record?.teamId === teamId && record?.userId === userId;

// Transactions guard transitions across Cloud Run instances and task retries.
export class CloudStore {
  constructor(db, prefix = 'slackBroadcast') {
    this.db = db;
    this.drafts = db.collection(`${prefix}Drafts`);
    this.jobs = db.collection(`${prefix}Jobs`);
    this.users = db.collection(`${prefix}Users`);
  }

  async createDraft({ teamId, userId, text = '' }) {
    const draft = {
      id: randomUUID(), teamId, userId, text, channels: [], state: 'compose',
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 30 * 60_000,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    };
    await this.drafts.doc(draft.id).create(draft);
    return draft;
  }

  async draft(id, teamId, userId) {
    if (!validId(id)) return undefined;
    const draft = (await this.drafts.doc(id).get()).data();
    return owns(draft, teamId, userId) && draft.expiresAtMs > Date.now() ? draft : undefined;
  }

  async changeDraft(id, teamId, userId, from, changes) {
    if (!validId(id)) return undefined;
    return this.db.runTransaction(async (tx) => {
      const ref = this.drafts.doc(id);
      const draft = (await tx.get(ref)).data();
      if (!owns(draft, teamId, userId) || draft.expiresAtMs <= Date.now() || draft.state !== from) return undefined;
      const updated = { ...draft, ...changes };
      tx.set(ref, updated);
      return updated;
    });
  }

  async prepare(id, teamId, userId, viewId) {
    if (!validId(id)) return undefined;
    return this.db.runTransaction(async (tx) => {
      const draftRef = this.drafts.doc(id);
      const jobRef = this.jobs.doc(id);
      const userRef = this.users.doc(`${teamId}_${userId}`);
      const [draftDoc, jobDoc, userDoc] = await Promise.all([tx.get(draftRef), tx.get(jobRef), tx.get(userRef)]);
      const draft = draftDoc.data();
      if (!owns(draft, teamId, userId) || draft.expiresAtMs <= Date.now()) return undefined;
      const existing = jobDoc.data();
      if (existing) return owns(existing, teamId, userId) ? existing : undefined;
      if (draft.state !== 'review') return undefined;
      const job = {
        id, teamId, userId, viewId, text: draft.text, createdAt: new Date().toISOString(),
        results: [
          ...draft.channels.map((channel) => ({ channel, status: 'queued' })),
          ...(draft.skipped || []).map(({ channel, error }) => ({ channel, status: 'failed', error })),
        ],
        phase: 'queued', leaseUntil: 0, finishedAt: null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      };
      tx.create(jobRef, job);
      tx.update(draftRef, { state: 'queued', text: '' });
      const recentJobIds = [id, ...(userDoc.data()?.recentJobIds || [userDoc.data()?.latestJobId])].filter(Boolean);
      tx.set(userRef, { latestJobId: id, recentJobIds: [...new Set(recentJobIds)].slice(0, 5) });
      return job;
    });
  }

  async job(id, teamId, userId) {
    if (!validId(id)) return undefined;
    const job = (await this.jobs.doc(id).get()).data();
    if (teamId && !owns(job, teamId, userId)) return undefined;
    return job;
  }

  async latest(teamId, userId) {
    const pointer = (await this.users.doc(`${teamId}_${userId}`).get()).data();
    return pointer ? this.job(pointer.latestJobId, teamId, userId) : undefined;
  }

  async recent(teamId, userId) {
    const pointer = (await this.users.doc(`${teamId}_${userId}`).get()).data();
    const ids = pointer?.recentJobIds || (pointer?.latestJobId ? [pointer.latestJobId] : []);
    return (await Promise.all(ids.slice(0, 5).map((id) => this.job(id, teamId, userId)))).filter(Boolean);
  }

  async claim(id) {
    if (!validId(id)) return { state: 'missing' };
    return this.db.runTransaction(async (tx) => {
      const ref = this.jobs.doc(id);
      const job = (await tx.get(ref)).data();
      if (!job) return { state: 'missing' };
      if (job.finishedAt) return { state: 'done', job };
      if (job.leaseUntil > Date.now()) return { state: 'busy' };
      // A previous attempt may have posted and crashed before saving the response.
      // Never repeat a channel whose result is ambiguous.
      for (const result of job.results) {
        if (result.status === 'sending') result.status = 'unknown';
      }
      Object.assign(job, { phase: 'running', leaseId: randomUUID(), leaseUntil: Date.now() + 10 * 60_000 });
      tx.set(ref, job);
      return { state: 'claimed', job };
    });
  }

  async checkpoint(id, leaseId, channel, changes) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.jobs.doc(id);
      const job = (await tx.get(ref)).data();
      if (!job || job.leaseId !== leaseId || job.finishedAt || job.leaseUntil <= Date.now()) throw new Error('Broadcast lease lost');
      const result = job.results.find((entry) => entry.channel === channel);
      if (!result) throw new Error('Unknown recipient');
      Object.assign(result, changes);
      tx.set(ref, job);
    });
  }

  async finish(id, leaseId) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.jobs.doc(id);
      const job = (await tx.get(ref)).data();
      if (!job || job.leaseId !== leaseId) throw new Error('Broadcast lease lost');
      if (job.results.some((result) => ['queued', 'sending'].includes(result.status))) throw new Error('Broadcast incomplete');
      Object.assign(job, { phase: 'done', text: '', finishedAt: new Date().toISOString(), leaseUntil: 0 });
      tx.set(ref, job);
      return job;
    });
  }
}
