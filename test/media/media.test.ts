import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserMediaResolver, DefaultMediaResolver } from "../../src/media";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DefaultMediaResolver", () => {
  it("resolves valid data URIs", async () => {
    const resolver = new DefaultMediaResolver();

    assert.deepEqual(await resolver.resolve("data:text/plain;base64,aGVsbG8="), {
      mimeType: "text/plain",
      base64: "aGVsbG8=",
    });
  });

  it("rejects invalid data URIs", async () => {
    const resolver = new DefaultMediaResolver();

    await assert.rejects(
      () => resolver.resolve("data:text/plain,hello"),
      /Invalid data URI/
    );
  });

  it("resolves local files and guesses MIME type from extension", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-engine-media-"));

    try {
      const txtPath = path.join(dir, "note.txt");
      const pngPath = path.join(dir, "image.PNG");
      const unknownPath = path.join(dir, "blob.unknown");
      await writeFile(txtPath, "hello");
      await writeFile(pngPath, Buffer.from([1, 2, 3]));
      await writeFile(unknownPath, "bin");

      const resolver = new DefaultMediaResolver();

      assert.deepEqual(await resolver.resolve(txtPath), {
        mimeType: "text/plain",
        base64: Buffer.from("hello").toString("base64"),
      });
      assert.deepEqual(await resolver.resolve(`file:///${pngPath}`), {
        mimeType: "image/png",
        base64: Buffer.from([1, 2, 3]).toString("base64"),
      });
      assert.deepEqual(await resolver.resolve(unknownPath), {
        mimeType: "application/octet-stream",
        base64: Buffer.from("bin").toString("base64"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves HTTP resources using response content-type without parameters", async () => {
    globalThis.fetch = (async (url: string) => {
      assert.equal(url, "https://example.com/file.txt");
      return new Response("remote", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as typeof fetch;

    const resolver = new DefaultMediaResolver();

    assert.deepEqual(await resolver.resolve("https://example.com/file.txt"), {
      mimeType: "text/plain",
      base64: Buffer.from("remote").toString("base64"),
    });
  });

  it("uses application/octet-stream when HTTP content-type is absent", async () => {
    const bytes = new TextEncoder().encode("remote");
    globalThis.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(0),
      headers: {
        get: () => null,
      },
    })) as unknown as typeof fetch;

    const resolver = new DefaultMediaResolver();

    assert.deepEqual(await resolver.resolve("http://example.com/file"), {
      mimeType: "application/octet-stream",
      base64: Buffer.from("remote").toString("base64"),
    });
  });

  it("rejects failed HTTP responses", async () => {
    globalThis.fetch = (async () => new Response("missing", {
      status: 404,
      statusText: "Not Found",
    })) as typeof fetch;

    const resolver = new DefaultMediaResolver();

    await assert.rejects(
      () => resolver.resolve("https://example.com/missing"),
      /Failed to fetch https:\/\/example\.com\/missing: 404 Not Found/
    );
  });
});

describe("BrowserMediaResolver", () => {
  it("resolves data URIs without Node.js builtins", async () => {
    const resolver = new BrowserMediaResolver();

    assert.deepEqual(await resolver.resolve("data:text/plain;base64,aGVsbG8="), {
      mimeType: "text/plain",
      base64: "aGVsbG8=",
    });
  });

  it("resolves fetched resources and strips content-type parameters", async () => {
    globalThis.fetch = (async () => new Response("browser", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })) as typeof fetch;
    const resolver = new BrowserMediaResolver();

    assert.deepEqual(await resolver.resolve("https://example.com/browser.txt"), {
      mimeType: "text/plain",
      base64: Buffer.from("browser").toString("base64"),
    });
  });

  it("rejects local paths with guidance for the Node subpath", async () => {
    const resolver = new BrowserMediaResolver();

    await assert.rejects(
      () => resolver.resolve("C:\\tmp\\local.png"),
      /@notic\/agent-engine\/node/
    );
  });
});
