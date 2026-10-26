const assert = require("node:assert/strict");

const root = require("@notic/agent-engine");
assert(!Object.keys(require.cache).some(path => /node_modules[\\/](openai|@anthropic-ai|@google|@modelcontextprotocol)[\\/]/.test(path)), "3.0 root loaded a vendor SDK");
const nodeEntry = require("@notic/agent-engine/node");

assert.equal(typeof root.Agent, "function");
assert.equal(typeof root.Generator, "function");
assert.equal(typeof root.Provider, "function");
assert.equal(typeof root.supportsCapability, "function");
assert(new root.OpenAIProvider() instanceof root.Provider);
assert.equal(root.Session, undefined);
assert.equal(root.Message.assistant("hello").children, undefined);
for (const entry of ["agent", "generator", "provider", "message", "session", "tool", "prompt"]) {
  const subpath = require(`@notic/agent-engine/${entry}`);
  assert(Object.keys(subpath).length > 0, `Empty module: ${entry}`);
}
assert.equal(typeof require("@notic/agent-engine/legacy").Session, "function");
assert.equal(typeof require("@notic/agent-engine/legacy/adapter").OpenAIAdapter, "function");
assert.equal(typeof root.BrowserMediaResolver, "function");
assert.equal(root.DefaultMediaResolver, undefined);
assert.equal(typeof nodeEntry.DefaultMediaResolver, "function");

console.log("PASS: browser-safe root and explicit Node media exports");
