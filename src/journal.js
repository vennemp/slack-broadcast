import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A local receipt journal for one app process. No message text or tokens are stored.
export class Journal {
  #jobs = new Map();
  #writes = Promise.resolve();

  constructor(directory) {
    this.directory = directory;
  }

  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const job = JSON.parse(await readFile(join(this.directory, file), 'utf8'));
      if (file !== `${job.id}.json` || !Array.isArray(job.results)) throw new Error(`Invalid receipt: ${file}`);
      this.#jobs.set(job.id, job);
      if (!job.finishedAt) {
        for (const result of job.results) {
          if (result.status === 'sending') result.status = 'unknown';
          if (result.status === 'queued') result.status = 'cancelled';
        }
        job.finishedAt = new Date().toISOString();
        await this.save(job);
      }
    }
  }

  get(id) { return this.#jobs.get(id); }

  latest(teamId, userId) {
    return this.recent(teamId, userId, 1)[0];
  }

  recent(teamId, userId, limit = 5) {
    return [...this.#jobs.values()]
      .filter((job) => job.teamId === teamId && job.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async save(job) {
    if (!/^[0-9a-f-]{36}$/.test(job.id)) throw new Error('Invalid broadcast ID');
    const snapshot = JSON.stringify(job, null, 2);
    const path = join(this.directory, `${job.id}.json`);
    const write = this.#writes.then(async () => {
      await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      this.#jobs.set(job.id, job);
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
