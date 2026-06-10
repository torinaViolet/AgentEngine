import { describe, it } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { Agent } from "../../src/agent";
import { RequestConfig } from "../../src/config";
import { Session } from "../../src/session";
import { StreamEventType } from "../../src/stream";

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const shouldRunRealTests = process.env.RUN_REAL_DEEPSEEK_TESTS === "1";

describe("Agent real DeepSeek client", () => {
  it(
    "streams a minimal reply through the Agent loop",
    {
      skip: shouldRunRealTests && apiKey
        ? false
        : "Set RUN_REAL_DEEPSEEK_TESTS=1 and DEEPSEEK_API_KEY to run this real API test",
      timeout: 45_000,
    },
    async () => {
      const client = new OpenAI({ apiKey, baseURL });
      const session = Session.create(
        "You are a test responder. Follow the user's exact output instruction."
      );
      const agent = new Agent({
        client,
        model,
        session,
        config: RequestConfig.create().temperature(0).maxTokens(64),
      });
      const deltas: string[] = [];

      agent.on(StreamEventType.TEXT_DELTA, (event) => {
        deltas.push(event.delta);
      });

      const reply = await agent.run("Reply exactly: AGENTENGINE_REAL_OK");

      assert.match(reply.text, /AGENTENGINE_REAL_OK/);
      assert.equal(deltas.join(""), reply.text);
      assert.equal(agent.lastRunState?.status, "completed");
      assert.equal(agent.lastRunState?.stopReason, "final");
      assert.equal(session.history().at(-1), reply);
    }
  );
});
