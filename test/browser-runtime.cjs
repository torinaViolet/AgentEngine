const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: ["test/browser-smoke.ts"], bundle: true, platform: "browser", format: "cjs", write: false }).outputFiles[0].text;
const sandbox = { module: { exports: {} }, console, structuredClone, TextEncoder, TextDecoder, atob, btoa, URL, Headers, FormData, Blob, Response, ReadableStream, DOMException, AbortController, setTimeout, clearTimeout };
vm.runInNewContext(bundle, sandbox, { timeout: 10000 });
const api = sandbox.module.exports;
assert.equal(sandbox.Buffer, undefined);
(async () => {
  const resolver = { async resolve() { return { base64: btoa("browser document"), mimeType: "text/plain" }; } };
  class BrowserAudioProvider extends api.Provider {
    async generateAudio() {
      const response = await this.request("audio", { body: { text: "hello" } });
      return { artifacts: [{ kind: "audio", mimeType: "audio/wav", source: { type: "bytes", bytes: await this.readBytes(response) } }] };
    }
  }
  const audio = await new BrowserAudioProvider({ baseURL: "https://fake.test", transport: async () => new Response(new Uint8Array([1, 2])) }).generateAudio();
  assert.equal(audio.artifacts[0].source.bytes.length, 2);
  assert(api.Message.assistant().addVideo("appfile://video").hasMedia);
  for (const Provider of [api.OpenAIProvider, api.AnthropicProvider, api.GeminiProvider]) {
    const provider = new Provider({ mediaResolver: resolver });
    const message = api.Message.user("").addFile("attachment://test", { mimeType: "text/plain" });
    const request = await provider.buildRequest({ model: "test", messages: [message] }, false);
    assert(JSON.stringify(request.body).includes("browser document"));
  }
  console.log("PASS: browser runtime and text attachments without Buffer or Node builtins");
})().catch(error => { console.error(error); process.exitCode = 1; });
