import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const validUser = (id) => /^[UW][A-Z0-9]+$/.test(id || '');
const modify = (state, { actor, operation, userId }, admins) => {
  if (!admins.has(actor)) throw new Error('Only app administrators can change approved senders');
  if (!validUser(userId) || !['add', 'remove'].includes(operation)) throw new Error('Invalid sender change');
  const ids = new Set(state.senders || []);
  const changed = operation === 'add' ? !ids.has(userId) : ids.has(userId);
  if (operation === 'add') ids.add(userId);
  else ids.delete(userId);
  if (ids.size > 50) throw new Error('This app supports up to 50 approved senders');
  return {
    senders: [...ids],
    history: [...(state.history || []), ...(changed ? [{ actor, operation, userId, at: new Date().toISOString() }] : [])].slice(-100),
  };
};

export class FirestoreSenders {
  constructor(db, admins, prefix = 'slackBroadcast') {
    this.db = db; this.admins = new Set(admins); this.collection = db.collection(`${prefix}Access`);
  }
  async policy(teamId) {
    const state = (await this.collection.doc(teamId).get()).data();
    return { allowed: new Set(state?.senders || []), admins: this.admins, initialized: !!state };
  }
  async change(teamId, mutation) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.collection.doc(teamId);
      const state = (await tx.get(ref)).data() || {};
      const updated = modify(state, mutation, this.admins);
      tx.set(ref, updated);
      return updated;
    });
  }
}

export class LocalSenders {
  #writes = Promise.resolve();
  constructor(directory, admins, initialSenders) {
    this.directory = directory; this.admins = new Set(admins); this.initialSenders = initialSenders;
  }
  path(teamId) {
    if (!/^T[A-Z0-9]+$/.test(teamId)) throw new Error('Invalid workspace ID');
    return join(this.directory, `access-${teamId}.json`);
  }
  async state(teamId) {
    try { return JSON.parse(await readFile(this.path(teamId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { senders: [...this.initialSenders], history: [] };
      throw error;
    }
  }
  async policy(teamId) { return { allowed: new Set((await this.state(teamId)).senders), admins: this.admins, initialized: true }; }
  async change(teamId, mutation) {
    const operation = this.#writes.then(async () => {
      const updated = modify(await this.state(teamId), mutation, this.admins);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(teamId);
      await writeFile(`${path}.tmp`, JSON.stringify(updated, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return updated;
    });
    this.#writes = operation.catch(() => {});
    return operation;
  }
}
