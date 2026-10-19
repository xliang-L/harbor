import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { State } from "./types.ts";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, signature TEXT NOT NULL, response TEXT NOT NULL)",
    );
    if (!this.db.prepare("SELECT id FROM state").get())
      this.db.prepare("INSERT INTO state VALUES (1,?)").run(
        JSON.stringify({
          brand: null,
          evidence: [],
          suggestions: [],
          contents: [],
          tasks: [],
          metrics: [],
        }),
      );
  }
  read(): State {
    const state = JSON.parse(
      (
        this.db.prepare("SELECT json FROM state WHERE id=1").get() as {
          json: string;
        }
      ).json,
    );
    return {
      sources: [],
      calendar: [],
      facts: [],
      guidelines: null,
      products: [],
      campaigns: [],
      assets: [],
      ...state,
    };
  }
  change<T>(fn: (s: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const s = this.read();
      const out = fn(s);
      this.db.prepare("UPDATE state SET json=? WHERE id=1").run(JSON.stringify(s));
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
