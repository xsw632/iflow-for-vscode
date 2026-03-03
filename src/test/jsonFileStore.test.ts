import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonFileStore } from "../shared/jsonFileStore";

suite("JsonFileStore", () => {
  let tmpDir: string;
  let restorePatches: Array<() => void>;

  const patchProperty = (
    target: object,
    key: string,
    value: unknown,
    restores: Array<() => void>,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value,
    });
    restores.push(() => {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
        return;
      }
      Reflect.deleteProperty(target, key);
    });
  };

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonfilestore-test-"));
    restorePatches = [];
  });

  teardown(() => {
    while (restorePatches.length > 0) {
      const restore = restorePatches.pop();
      restore?.();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── read() ──────────────────────────────────────────────────────────

  test("read() returns {} for non-existent file", () => {
    const filePath = path.join(tmpDir, "does-not-exist.json");
    const store = new JsonFileStore(filePath, () => {});

    const result = store.read();

    assert.deepStrictEqual(result, {});
  });

  test("read() returns parsed JSON for existing file", () => {
    const filePath = path.join(tmpDir, "data.json");
    const expected = { name: "test", version: 1, nested: { key: "value" } };
    fs.writeFileSync(filePath, JSON.stringify(expected), "utf-8");

    const store = new JsonFileStore(filePath, () => {});
    const result = store.read();

    assert.deepStrictEqual(result, expected);
  });

  test("read() uses mtime cache on repeated calls (no re-read)", () => {
    const filePath = path.join(tmpDir, "cached.json");
    fs.writeFileSync(filePath, JSON.stringify({ a: 1 }), "utf-8");

    const store = new JsonFileStore(filePath, () => {});

    const first = store.read();
    assert.deepStrictEqual(first, { a: 1 });

    // Overwrite file content without changing mtime — we simulate this by
    // verifying the same object reference is returned on the second call,
    // which proves the cache path was taken (no re-parse).
    const second = store.read();
    assert.strictEqual(first, second, "Expected the exact same cached object reference");
  });

  test("read() invalidates cache when file is modified (mtime changes)", () => {
    const filePath = path.join(tmpDir, "mtime.json");
    fs.writeFileSync(filePath, JSON.stringify({ v: 1 }), "utf-8");

    const store = new JsonFileStore(filePath, () => {});
    const first = store.read();
    assert.deepStrictEqual(first, { v: 1 });

    // Advance mtime by writing new content after a small delay
    // Use utimesSync to guarantee a different mtime even on fast filesystems
    const newData = { v: 2 };
    fs.writeFileSync(filePath, JSON.stringify(newData), "utf-8");
    const futureTime = Date.now() / 1000 + 10;
    fs.utimesSync(filePath, futureTime, futureTime);

    const second = store.read();
    assert.deepStrictEqual(second, { v: 2 });
    assert.notStrictEqual(first, second, "Expected a new object after mtime change");
  });

  test("read() returns {} and logs on malformed JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json !!!", "utf-8");

    const logMessages: string[] = [];
    const store = new JsonFileStore(filePath, (msg) => logMessages.push(msg));

    const result = store.read();

    assert.deepStrictEqual(result, {});
    assert.strictEqual(logMessages.length, 1);
    assert.ok(
      logMessages[0].includes("Failed to parse"),
      `Expected log to contain 'Failed to parse', got: ${logMessages[0]}`,
    );
  });

  test("read() returns {} and logs stable token when statSync hits I/O failure", () => {
    const filePath = path.join(tmpDir, "io-failure.json");
    fs.writeFileSync(filePath, JSON.stringify({ ok: true }), "utf-8");

    const logMessages: string[] = [];
    const store = new JsonFileStore(filePath, (msg) => logMessages.push(msg));
    const nativeFs = require("fs") as typeof fs;
    const originalStatSync = nativeFs.statSync.bind(nativeFs);

    patchProperty(
      nativeFs,
      "statSync",
      ((target, options) => {
        if (target === filePath) {
          const error = new Error("io denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalStatSync(target, options as never);
      }) as typeof nativeFs.statSync,
      restorePatches,
    );

    const result = store.read();

    assert.deepStrictEqual(result, {});
    assert.strictEqual(logMessages.length, 1);
    assert.ok(logMessages[0].includes("Failed to parse"));
    assert.ok(logMessages[0].includes(filePath));
  });

  // ── write() ─────────────────────────────────────────────────────────

  test("write() creates file with correct JSON content", () => {
    const filePath = path.join(tmpDir, "write-test.json");
    const store = new JsonFileStore(filePath, () => {});

    const data = { hello: "world", count: 42 };
    const success = store.write(data);

    assert.strictEqual(success, true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(onDisk, data);

    // Verify pretty-printed with 2-space indent
    const raw = fs.readFileSync(filePath, "utf-8");
    assert.strictEqual(raw, JSON.stringify(data, null, 2));
  });

  test("write() creates parent directories", () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "deep.json");
    const store = new JsonFileStore(filePath, () => {});

    const success = store.write({ deep: true });

    assert.strictEqual(success, true);
    assert.ok(fs.existsSync(filePath));
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(onDisk, { deep: true });
  });

  test("write() returns false and logs on write failure", () => {
    // Create a read-only directory so writing inside it fails
    const readOnlyDir = path.join(tmpDir, "readonly");
    fs.mkdirSync(readOnlyDir, { mode: 0o444 });
    const filePath = path.join(readOnlyDir, "sub", "file.json");

    const logMessages: string[] = [];
    const store = new JsonFileStore(filePath, (msg) => logMessages.push(msg));

    const success = store.write({ fail: true });

    assert.strictEqual(success, false);
    assert.strictEqual(logMessages.length, 1);
    assert.ok(
      logMessages[0].includes("Failed to write"),
      `Expected log to contain 'Failed to write', got: ${logMessages[0]}`,
    );

    // Restore writable mode so teardown cleanup can remove it
    fs.chmodSync(readOnlyDir, 0o755);
  });

  test("write() updates the read cache", () => {
    const filePath = path.join(tmpDir, "cache-after-write.json");
    const store = new JsonFileStore(filePath, () => {});

    const data = { cached: true };
    store.write(data);

    // Subsequent read should return cached data without needing to re-parse
    const result = store.read();
    assert.deepStrictEqual(result, data);
    // Verify it is the same cached reference (no re-read from disk)
    assert.strictEqual(result, data, "Expected cached reference after write");
  });

  test("write() uses Windows utf-8 signature branch when platform is win32", () => {
    const filePath = path.join(tmpDir, "win32-write.json");
    const store = new JsonFileStore(filePath, () => {});
    const nativeFs = require("fs") as typeof fs;
    const originalWriteFileSync = nativeFs.writeFileSync.bind(nativeFs);
    let observedEncoding: unknown;

    patchProperty(process, "platform", "win32", restorePatches);
    patchProperty(
      nativeFs,
      "writeFileSync",
      ((target, content, options) => {
      observedEncoding = options;
      return originalWriteFileSync(target, content, options as never);
      }) as typeof nativeFs.writeFileSync,
      restorePatches,
    );

    const success = store.write({ os: "windows" });

    assert.strictEqual(success, true);
    assert.strictEqual(observedEncoding, "utf-8");
  });

  test("write() keeps success semantics when post-write statSync throws", () => {
    const filePath = path.join(tmpDir, "stat-fallback.json");
    const logMessages: string[] = [];
    const store = new JsonFileStore(filePath, (msg) => logMessages.push(msg));
    const nativeFs = require("fs") as typeof fs;
    const originalStatSync = nativeFs.statSync.bind(nativeFs);
    let throwOnce = true;

    patchProperty(
      nativeFs,
      "statSync",
      ((target, options) => {
      if (throwOnce && target === filePath) {
        throwOnce = false;
        throw new Error("stat failed");
      }
      return originalStatSync(target, options as never);
      }) as typeof nativeFs.statSync,
      restorePatches,
    );

    const data = { fallback: true };
    const success = store.write(data);

    assert.strictEqual(success, true);
    assert.strictEqual(logMessages.length, 0);
    assert.ok(fs.existsSync(filePath));
    const fromDisk = store.read();
    assert.deepStrictEqual(fromDisk, data);
  });

  // ── update() ────────────────────────────────────────────────────────

  test("update() skips write when data unchanged", () => {
    const filePath = path.join(tmpDir, "no-change.json");
    const original = { x: 1 };
    fs.writeFileSync(filePath, JSON.stringify(original), "utf-8");
    const originalMtime = fs.statSync(filePath).mtimeMs;

    // Force a different mtime so we can detect if write happens
    const futureTime = Date.now() / 1000 + 100;
    fs.utimesSync(filePath, futureTime, futureTime);
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    const store = new JsonFileStore(filePath, () => {});

    // Updater returns same data — write should be skipped
    const result = store.update((data) => ({ ...data }));

    assert.strictEqual(result, true);

    // File mtime should not have changed (no write occurred)
    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    assert.strictEqual(mtimeAfter, mtimeBefore, "Expected file not to be rewritten");
  });

  test("update() writes when data changed", () => {
    const filePath = path.join(tmpDir, "changed.json");
    fs.writeFileSync(filePath, JSON.stringify({ count: 0 }), "utf-8");

    const store = new JsonFileStore(filePath, () => {});
    const result = store.update((data) => ({
      ...data,
      count: (data.count as number) + 1,
    }));

    assert.strictEqual(result, true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(onDisk, { count: 1 });
  });

  test("update() persists in-place mutations from cached reads", () => {
    const filePath = path.join(tmpDir, "in-place-update.json");
    fs.writeFileSync(filePath, JSON.stringify({ count: 1 }), "utf-8");
    const store = new JsonFileStore(filePath, () => {});

    const cached = store.read();
    assert.deepStrictEqual(cached, { count: 1 });

    const result = store.update((data) => {
      (data as { count: number }).count = 2;
      return data;
    });

    assert.strictEqual(result, true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(onDisk, { count: 2 });
  });

  test("update() returns false when write fails after cached read", () => {
    const filePath = path.join(tmpDir, "update-write-failure.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), "utf-8");
    const logMessages: string[] = [];
    const store = new JsonFileStore(filePath, (msg) => logMessages.push(msg));
    const nativeFs = require("fs") as typeof fs;
    const originalWriteFileSync = nativeFs.writeFileSync.bind(nativeFs);

    patchProperty(
      nativeFs,
      "writeFileSync",
      (() => {
        const error = new Error("disk full") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }) as typeof nativeFs.writeFileSync,
      restorePatches,
    );

    const cached = store.read();
    assert.deepStrictEqual(cached, { version: 1 });

    const result = store.update((data) => ({
      ...data,
      version: 2,
    }));

    assert.strictEqual(result, false);
    assert.strictEqual(logMessages.length, 1);
    assert.ok(logMessages[0].includes("Failed to write"));

    patchProperty(nativeFs, "writeFileSync", originalWriteFileSync, restorePatches);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(onDisk, { version: 1 });
  });

  test("update() works on non-existent file (read returns {}, updater adds data)", () => {
    const filePath = path.join(tmpDir, "new-via-update.json");
    const store = new JsonFileStore(filePath, () => {});

    const result = store.update((data) => ({ ...data, created: true }));

    assert.strictEqual(result, true);
    assert.ok(fs.existsSync(filePath));
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(onDisk, { created: true });
  });
});
