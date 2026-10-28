import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_GROUPS = 25;
export const MAX_GROUP_CHANNELS = 25;
export const MAX_GROUP_NAME = 60;

export class GroupError extends Error {
  constructor(message, field = 'group_name') { super(message); this.field = field; }
}

function change(groups, { operation = 'save', id, version = 0, name, channels, userId }) {
  const index = groups.findIndex((group) => group.id === id);
  const previous = groups[index];
  if (id && (!previous || previous.version !== version)) throw new GroupError('This group changed. Reopen it before editing.');
  if (operation === 'delete') {
    if (!previous) throw new GroupError('This group is unavailable.');
    groups.splice(index, 1);
    return previous;
  }
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanChannels = [...new Set(channels || [])];
  if (!cleanName || [...cleanName].length > MAX_GROUP_NAME || /[\r\n\t]/.test(cleanName)) throw new GroupError(`Enter a name of 1 to ${MAX_GROUP_NAME} characters on one line.`);
  if (!cleanChannels.length || cleanChannels.length > MAX_GROUP_CHANNELS || cleanChannels.some((channel) => !/^[CG][A-Z0-9]+$/.test(channel))) throw new GroupError(`Select between 1 and ${MAX_GROUP_CHANNELS} channels.`, 'group_channels');
  if (groups.some((group) => group.id !== id && group.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw new GroupError('A group with this name already exists.');
  if (!previous && groups.length >= MAX_GROUPS) throw new GroupError(`There can be up to ${MAX_GROUPS} saved groups. Remove a group before creating another.`);
  const record = {
    id: previous?.id || randomUUID(), name: cleanName, channels: cleanChannels,
    createdBy: previous?.createdBy || userId, updatedBy: userId,
    createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: (previous?.version || 0) + 1,
  };
  if (previous) groups[index] = record;
  else groups.push(record);
  return record;
}

export class FirestoreGroups {
  constructor(db, prefix = 'slackBroadcast') { this.collection = db.collection(`${prefix}Groups`); this.db = db; }
  async list(teamId) { return (await this.collection.doc(teamId).get()).data()?.groups || []; }
  async get(teamId, id) { return (await this.list(teamId)).find((group) => group.id === id); }
  async save(teamId, mutation) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.collection.doc(teamId);
      const groups = (await tx.get(ref)).data()?.groups || [];
      const result = change(groups, mutation);
      tx.set(ref, { groups });
      return result;
    });
  }
}

export class LocalGroups {
  #writes = Promise.resolve();
  constructor(directory) { this.directory = directory; }
  path(teamId) {
    if (!/^T[A-Z0-9]+$/.test(teamId)) throw new Error('Invalid workspace ID');
    return join(this.directory, `groups-${teamId}.json`);
  }
  async list(teamId) {
    try { return JSON.parse(await readFile(this.path(teamId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async get(teamId, id) { return (await this.list(teamId)).find((group) => group.id === id); }
  async save(teamId, mutation) {
    const operation = this.#writes.then(async () => {
      const groups = await this.list(teamId);
      const result = change(groups, mutation);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(teamId);
      await writeFile(`${path}.tmp`, JSON.stringify(groups, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return result;
    });
    this.#writes = operation.catch(() => {});
    return operation;
  }
}
