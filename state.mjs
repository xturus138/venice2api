import fs from 'node:fs';
import path from 'node:path';

// Everything the runner needs to survive a crash lives in the workspace folder.
export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.logPath = path.join(dir, 'log.jsonl');
    this.focusPath = path.join(dir, 'focus.json');
  }

  writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  save(state) {
    state.updatedAt = new Date().toISOString();
    this.writeAtomic(this.statePath, JSON.stringify(state, null, 2));
  }

  log(event) {
    fs.appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  }

  doc(name) {
    try {
      return fs.readFileSync(path.join(this.dir, name), 'utf8');
    } catch {
      return '';
    }
  }

  writeDoc(name, text) {
    this.writeAtomic(path.join(this.dir, name), text);
  }

  focus() {
    try {
      const v = JSON.parse(fs.readFileSync(this.focusPath, 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  setFocus(paths) {
    this.writeAtomic(this.focusPath, JSON.stringify(paths, null, 2));
  }

  // Start a fresh task. The log is kept (it is append-only history).
  reset() {
    for (const f of ['state.json', 'PLAN.md', 'NOTES.md', 'focus.json']) {
      fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}
