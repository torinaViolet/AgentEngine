import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, OpenAIClientLike } from "../../src/agent";
import { RequestConfig } from "../../src/config";
import { Message, Role } from "../../src/message";
import { PromptBuilder, Rule } from "../../src/prompt";
import { Session } from "../../src/session";
import { StreamEventType } from "../../src/stream";
import { Param, Tool, ToolKit } from "../../src/tool";

type StreamChunk = Record<string, unknown>;
type StreamFactory = (
  params: Record<string, unknown>,
  options?: Record<string, unknown>
) => AsyncIterable<StreamChunk> | StreamChunk[] | Promise<AsyncIterable<StreamChunk> | StreamChunk[]>;

class FakeOpenAIClient implements OpenAIClientLike {
  public readonly calls: Array<{
    params: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];

  private readonly queue: StreamFactory[] = [];

  readonly chat = {
    completions: {
      create: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        this.calls.push({ params, options });
        const next = this.queue.shift();
        if (!next) {
          throw new Error("No fake stream queued");
        }

        const stream = await next(params, options);
        return Array.isArray(stream) ? asyncStream(stream) : stream;
      },
    },
  };

  enqueue(chunks: StreamChunk[] | StreamFactory): this {
    this.queue.push(typeof chunks === "function" ? chunks : () => chunks);
    return this;
  }
}

async function* asyncStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

function textChunks(text: string, finishReason = "stop"): StreamChunk[] {
  return [
    {
      choices: [
        {
          delta: { content: text },
          finish_reason: finishReason,
        },
      ],
    },
  ];
}

function toolCallChunks(
  name: string,
  args: Record<string, unknown>,
  id = "call_1"
): StreamChunk[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ];
}

function createEchoTool(): Tool {
  return Tool.create((args) => ({ echoed: args.value }))
    .name("echo")
    .description("Echo a value")
    .params(Param.string("value").required())
    .build();
}

function eventTypes(events: Array<{ type: string }>): string[] {
  return events.map((event) => event.type);
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Agent fake client", () => {
  it("runs one streamed turn, emits events, and stores the assistant reply", async () => {
    const client = new FakeOpenAIClient().enqueue(textChunks("hello agent"));
    const session = Session.create("system");
    const agent = new Agent({ client, model: "fake-model", session });
    const events: Array<{ type: string }> = [];

    agent.on(StreamEventType.TURN_START, (event) => events.push(event));
    agent.on(StreamEventType.TEXT_DELTA, (event) => events.push(event));
    agent.on(StreamEventType.TEXT_DONE, (event) => events.push(event));
    agent.on(StreamEventType.MESSAGE_DONE, (event) => events.push(event));
    agent.on(StreamEventType.TURN_END, (event) => events.push(event));

    const reply = await agent.run("say hi");

    assert.equal(reply.role, Role.Assistant);
    assert.equal(reply.text, "hello agent");
    assert.equal(reply.model, "fake-model");
    assert.equal(agent.lastRunState?.status, "completed");
    assert.equal(agent.lastRunState?.stopReason, "final");
    assert.equal(agent.canResume, false);
    assert.deepEqual(session.history().map((msg) => msg.text), [
      "system",
      "say hi",
      "hello agent",
    ]);
    assert.deepEqual(eventTypes(events), [
      StreamEventType.TURN_START,
      StreamEventType.TEXT_DELTA,
      StreamEventType.TEXT_DONE,
      StreamEventType.MESSAGE_DONE,
      StreamEventType.TURN_END,
    ]);
  });

  it("merges config, agent request options, run options, prompt injections, and tool schemas", async () => {
    const client = new FakeOpenAIClient().enqueue(textChunks("configured"));
    const toolkit = new ToolKit().add(createEchoTool());
    const promptBuilder = new PromptBuilder();
    promptBuilder.injectSystem(Rule.top().after(), "injected context");

    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create("system"),
      toolkit,
      promptBuilder,
      config: RequestConfig.create().temperature(0.2).maxTokens(64),
      requestOptions: { temperature: 0.4, top_p: 0.8 },
    });

    await agent.run("question", {
      temperature: 0.7,
      presence_penalty: 0.3,
      promptBuildOptions: { strategy: "batch" },
    });

    assert.equal(client.calls.length, 1);
    const params = client.calls[0].params;
    assert.equal(params.model, "fake-model");
    assert.equal(params.stream, true);
    assert.equal(params.temperature, 0.7);
    assert.equal(params.max_tokens, 64);
    assert.equal(params.top_p, 0.8);
    assert.equal(params.presence_penalty, 0.3);
    assert.deepEqual(
      (params.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
      ["echo"]
    );
    assert.deepEqual(
      (params.messages as Array<{ role: string; content: string }>).map((msg) => msg.content),
      ["system", "injected context", "question"]
    );
    assert.ok(client.calls[0].options?.signal instanceof AbortSignal);
  });

  it("executes approved tool calls and continues until the final answer", async () => {
    const client = new FakeOpenAIClient()
      .enqueue(toolCallChunks("echo", { value: "ping" }))
      .enqueue(textChunks("tool says ping"));
    const toolkit = new ToolKit().add(createEchoTool());
    const session = Session.create();
    const agent = new Agent({ client, model: "fake-model", session, toolkit });
    const events: Array<{ type: string }> = [];

    agent.on(
      [
        StreamEventType.TOOL_CALL_START,
        StreamEventType.TOOL_APPROVAL_REQUIRED,
        StreamEventType.TOOL_APPROVAL_ACCEPTED,
        StreamEventType.TOOL_EXECUTE_START,
        StreamEventType.TOOL_EXECUTE_DONE,
      ],
      (event) => events.push(event)
    );

    const reply = await agent.run("use echo");

    assert.equal(reply.text, "tool says ping");
    assert.equal(client.calls.length, 2);
    assert.deepEqual(session.history().map((msg) => msg.role), [
      Role.User,
      Role.Assistant,
      Role.Tool,
      Role.Assistant,
    ]);
    assert.equal(session.history()[1].toolCalls[0].name, "echo");
    assert.equal(session.history()[2].text, "{\"echoed\":\"ping\"}");
    assert.deepEqual(eventTypes(events), [
      StreamEventType.TOOL_CALL_START,
      StreamEventType.TOOL_APPROVAL_REQUIRED,
      StreamEventType.TOOL_APPROVAL_ACCEPTED,
      StreamEventType.TOOL_EXECUTE_START,
      StreamEventType.TOOL_EXECUTE_DONE,
    ]);
  });

  it("supports manual approval through pendingApprovals", async () => {
    const client = new FakeOpenAIClient()
      .enqueue(toolCallChunks("echo", { value: "manual" }))
      .enqueue(textChunks("approved result"));
    const toolkit = new ToolKit().add(createEchoTool());
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit,
      toolApprovalMode: "manual",
    });

    const run = agent.run("needs approval");

    await waitFor(() => agent.pendingApprovals.length === 1);
    const [approval] = agent.pendingApprovals;

    assert.equal(approval.name, "echo");
    assert.deepEqual(approval.arguments, { value: "manual" });
    assert.equal(agent.approve(approval.approvalId), true);
    assert.equal(agent.approve(approval.approvalId), false);

    const reply = await run;
    assert.equal(reply.text, "approved result");
    assert.deepEqual(agent.pendingApprovals, []);
    assert.equal(agent.lastRunState?.status, "completed");
  });

  it("rejects tool calls through an approval handler and records a rejected tool result", async () => {
    const client = new FakeOpenAIClient().enqueue(toolCallChunks("echo", { value: "nope" }));
    const toolkit = new ToolKit().add(createEchoTool());
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit,
      toolApproval: () => ({ approved: false, reason: "blocked" }),
    });

    await assert.rejects(agent.run("reject this"), /拒绝|rejected|blocked/);

    assert.equal(agent.lastRunState?.status, "failed");
    assert.equal(agent.lastRunState?.stopReason, "tool_approval_rejected");
    assert.equal(agent.canResume, true);
    const history = agent.session.history();
    assert.equal(history.at(-1)?.role, Role.Tool);
    assert.match(history.at(-1)?.text ?? "", /blocked/);
  });

  it("can pause on tool execution errors and persist the failed tool result", async () => {
    const failingTool = Tool.create(() => {
      throw new Error("boom");
    })
      .name("fail")
      .description("Always fails")
      .build();
    const client = new FakeOpenAIClient().enqueue(toolCallChunks("fail", {}));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit: new ToolKit().add(failingTool),
      toolErrorPolicy: "pause",
    });
    const errors: Array<{ type: string; error: Error }> = [];

    agent.on(StreamEventType.TOOL_EXECUTE_ERROR, (event) => errors.push(event));

    await assert.rejects(agent.run("pause on error"), /boom/);

    assert.equal(agent.lastRunState?.status, "failed");
    assert.equal(agent.lastRunState?.stopReason, "tool_execution_error");
    assert.equal(agent.canResume, true);
    assert.equal(errors.length, 1);
    assert.match(agent.session.history().at(-1)?.text ?? "", /"paused":true/);
  });

  it("returns a max-token partial result without throwing when finish_reason is length", async () => {
    const client = new FakeOpenAIClient().enqueue(textChunks("partial", "length"));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
    });

    const reply = await agent.run("too long");

    assert.equal(reply.text, "partial");
    assert.equal(agent.lastRunState?.status, "failed");
    assert.equal(agent.lastRunState?.stopReason, "max_tokens");
    assert.equal(agent.canResume, true);
    assert.equal(agent.lastRunState?.lastMessage, reply);
  });

  it("runRaw sends supplied messages and does not mutate the session", async () => {
    const client = new FakeOpenAIClient().enqueue(textChunks("raw reply"));
    const session = Session.create("system");
    const agent = new Agent({ client, model: "fake-model", session });
    const messages = [Message.system("raw system"), Message.user("raw user")];

    const reply = await agent.runRaw(messages, { temperature: 0.1 });

    assert.equal(reply.text, "raw reply");
    assert.deepEqual(session.history().map((msg) => msg.text), ["system"]);
    assert.deepEqual(
      (client.calls[0].params.messages as Array<{ role: string; content: string }>).map((msg) => msg.content),
      ["raw system", "raw user"]
    );
    assert.equal(client.calls[0].params.temperature, 0.1);
  });
});
