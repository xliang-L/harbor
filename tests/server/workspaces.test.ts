import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceApp } from "../../server/storage/workspaces.ts";

async function start(data: string, output: string) {
  const app = createWorkspaceApp(data, output);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  return {
    base,
    post: async (id: string, key?: string, suffix = "", context = "default") => {
      const response = await fetch(`${base}projects${suffix}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Harbor-Project": context,
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        },
        body: JSON.stringify({ id }),
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      app.locals.stopScheduler();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("project creation rejects reused keys with different intent and replays persistently across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-workspace-keys-"));
  const data = join(dir, "data");
  let api = await start(data, join(dir, "output"));
  let closed = false;
  try {
    const created = await api.post("brand-a", "create-a");
    assert.equal(created.status, 200);
    assert.deepEqual(created.body, { id: "brand-a" });
    const retried = await Promise.all(
      Array.from({ length: 4 }, () => api.post("brand-a", "create-a")),
    );
    assert.ok(retried.every((r) => r.status === 200 && r.body.id === "brand-a"));
    assert.equal((await api.post("brand-b", "create-a")).status, 409);
    assert.deepEqual(readdirSync(join(data, "projects")), ["brand-a"]);
    const db = new DatabaseSync(join(data, "harbor.sqlite"), { readOnly: true });
    const record = db
      .prepare("SELECT signature,response FROM requests WHERE key=?")
      .get("workspace:projects:create-a");
    assert.deepEqual(record && JSON.parse(String(record.response)), created.body);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM requests").get()?.count, 1);
    db.close();
    await api.close();
    closed = true;
    api = await start(data, join(dir, "output"));
    closed = false;
    assert.deepEqual(
      await api.post("brand-a", "create-a", "?project=brand-a", "brand-a"),
      created,
      "Global creation result survives process recreation and valid context changes",
    );
    assert.equal((await api.post("brand-b", "create-a")).status, 409);
    assert.equal((await api.post("brand-b", "create-b")).status, 200);
    assert.deepEqual(readdirSync(join(data, "projects")).sort(), ["brand-a", "brand-b"]);
  } finally {
    if (!closed) await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace context is checked before global reads, creation and cached replay without creating databases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-workspace-context-"));
  const data = join(dir, "data");
  const api = await start(data, join(dir, "output"));
  try {
    assert.equal((await api.post("brand-a", "create-a")).status, 200);
    const before = readdirSync(join(data, "projects"));
    const snapshot = () => {
      const db = new DatabaseSync(join(data, "harbor.sqlite"), { readOnly: true });
      try {
        return db.prepare("SELECT key,signature,response FROM requests ORDER BY key").all();
      } finally {
        db.close();
      }
    };
    const requests = snapshot();
    for (const path of ["projects", "console", "state"]) {
      assert.equal(
        (
          await fetch(`${api.base}${path}?project=brand-a`, {
            headers: { "X-Harbor-Project": "default" },
          })
        ).status,
        400,
      );
      assert.equal((await fetch(`${api.base}${path}?project=unknown`)).status, 404);
      assert.equal((await fetch(`${api.base}${path}?project=bad%2Fpath`)).status, 400);
      assert.equal((await fetch(`${api.base}${path}?project=default&project=brand-a`)).status, 400);
    }
    assert.equal(
      (await api.post("brand-a", "create-a", "?project=brand-a", "default")).status,
      400,
      "Even a cached success must validate context first",
    );
    assert.equal((await api.post("brand-b", "context-key", "", "unknown")).status, 404);
    for (const key of [undefined, "", " ", "x".repeat(101)])
      assert.equal((await api.post("brand-b", key)).status, 400);
    assert.deepEqual(readdirSync(join(data, "projects")), before);
    assert.deepEqual(
      snapshot(),
      requests,
      "Rejected requests must not reserve idempotency keys or touch request records",
    );
    assert.equal(
      (await api.post("brand-b", "context-key")).status,
      200,
      "A corrected request can reuse the previously rejected key",
    );
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit project creation accepts its new target context without opening any other unknown workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-workspace-create-context-"));
  const data = join(dir, "data");
  const api = await start(data, join(dir, "output"));
  try {
    assert.equal((await api.post("brand-a", "create-a", "", "brand-a")).status, 200);
    assert.equal(
      (await api.post("brand-b", "create-b", "?project=brand-b", "brand-b")).status,
      200,
    );
    assert.deepEqual((await api.post("brand-a", "create-a", "", "brand-a")).body, {
      id: "brand-a",
    });
    assert.equal(
      (await api.post("brand-c", "create-a", "", "brand-c")).status,
      409,
      "The new-context exception must still enforce request identity",
    );
    assert.equal((await api.post("brand-c", "create-c", "", "different-unknown")).status, 404);
    assert.equal(
      (await api.post("brand-c", "create-c", "?project=different-unknown", "brand-c")).status,
      400,
    );
    assert.equal((await api.post("brand-c", undefined, "", "brand-c")).status, 400);
    assert.equal((await fetch(`${api.base}projects?project=brand-c`)).status, 404);
    assert.equal(
      (
        await fetch(`${api.base}brand`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Harbor-Project": "brand-c",
            "Idempotency-Key": "not-creation",
          },
          body: JSON.stringify({ id: "brand-c" }),
        })
      ).status,
      404,
    );
    assert.deepEqual(readdirSync(join(data, "projects")).sort(), ["brand-a", "brand-b"]);
    assert.equal(
      (await api.post("brand-c", "create-c", "", "brand-c")).status,
      200,
      "Rejected requests do not reserve the creation key",
    );
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
