const assert = require("node:assert/strict");

const root = require("@notic/agent-engine");
const nodeEntry = require("@notic/agent-engine/node");

assert.equal(typeof root.Agent, "function");
assert.equal(typeof root.BrowserMediaResolver, "function");
assert.equal(root.DefaultMediaResolver, undefined);
assert.equal(typeof nodeEntry.DefaultMediaResolver, "function");

console.log("PASS: browser-safe root and explicit Node media exports");
