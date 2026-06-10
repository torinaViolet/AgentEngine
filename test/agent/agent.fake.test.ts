import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  AgentAbortError,
  AgentAlreadyRunningError,
  AgentToolApprovalError,
  AgentToolApprovalTimeoutError,
  OpenAIClientLike,
} from "../../src/agent";
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

  it("cleans pending approval and repairs tool protocol when aborted", async () => {
    const client = new FakeOpenAIClient().enqueue(toolCallChunks("echo", { value: "later" }));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit: new ToolKit().add(createEchoTool()),
      toolApprovalMode: "manual",
    });

    const run = agent.run("wait for approval");
    await waitFor(() => agent.pendingApprovals.length === 1);

    const reason = new Error("user cancelled approval");
    assert.equal(agent.abort(reason), true);
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof AgentAbortError);
      assert.equal(error.cause, reason);
      return true;
    });

    assert.deepEqual(agent.pendingApprovals, []);
    assert.equal(agent.lastRunState?.status, "interrupted");
    assert.equal(agent.lastRunState?.stopReason, "abort");
    assert.equal(agent.canResume, true);
    const repaired = agent.session.history().at(-1)!;
    assert.equal(repaired.role, Role.Tool);
    assert.equal(repaired.metadata.interrupted, true);
    assert.match(repaired.text, /"outcome":"unknown"/);
  });

  it("classifies manual approval abort timeouts and can resume safely", async () => {
    const client = new FakeOpenAIClient()
      .enqueue(toolCallChunks("echo", { value: "timeout" }))
      .enqueue(textChunks("resumed safely"));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit: new ToolKit().add(createEchoTool()),
      toolApprovalMode: "manual",
      toolApprovalTimeoutMs: 5,
      toolApprovalTimeoutPolicy: "abort",
    });

    await assert.rejects(
      agent.run("time out approval"),
      AgentToolApprovalTimeoutError
    );

    assert.deepEqual(agent.pendingApprovals, []);
    assert.equal(agent.lastRunState?.status, "interrupted");
    assert.equal(agent.lastRunState?.stopReason, "timeout");
    assert.equal(agent.canResume, true);

    const reply = await agent.resume();
    assert.equal(reply.text, "resumed safely");
    assert.deepEqual(
      (client.calls[1].params.messages as Array<{ role: string }>).map((msg) => msg.role),
      ["user", "assistant", "tool", "user"]
    );
  });

  it("cleans pending approval when manual approval times out as rejected", async () => {
    const client = new FakeOpenAIClient().enqueue(toolCallChunks("echo", { value: "timeout" }));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit: new ToolKit().add(createEchoTool()),
      toolApprovalMode: "manual",
      toolApprovalTimeoutMs: 5,
    });

    await assert.rejects(agent.run("reject timed out approval"), /工具调用均被审批拒绝/);

    assert.deepEqual(agent.pendingApprovals, []);
    assert.equal(agent.lastRunState?.status, "failed");
    assert.equal(agent.lastRunState?.stopReason, "tool_approval_rejected");
    assert.equal(agent.canResume, true);
    const result = agent.session.history().at(-1)!;
    assert.equal(result.role, Role.Tool);
    assert.match(result.text, /工具审批超时/);
  });

  it("wraps approval handler failures and repairs missing tool results", async () => {
    const client = new FakeOpenAIClient().enqueue(toolCallChunks("echo", { value: "x" }));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit: new ToolKit().add(createEchoTool()),
      toolApproval: () => {
        throw new Error("approval service unavailable");
      },
    });

    await assert.rejects(agent.run("approve this"), (error) => {
      assert.ok(error instanceof AgentToolApprovalError);
      assert.equal(error.request.name, "echo");
      assert.match(error.message, /approval service unavailable/);
      return true;
    });

    assert.equal(agent.lastRunState?.stopReason, "tool_approval_error");
    assert.equal(agent.canResume, true);
    assert.equal(agent.session.history().at(-1)?.role, Role.Tool);
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

  it("emits tool execution errors while returning them to the model", async () => {
    const failingTool = Tool.create(() => {
      throw new Error("recoverable failure");
    })
      .name("fail_softly")
      .build();
    const client = new FakeOpenAIClient()
      .enqueue(toolCallChunks("fail_softly", {}))
      .enqueue(textChunks("handled tool failure"));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
      toolkit: new ToolKit().add(failingTool),
    });
    const errors: Array<{ error: Error; result?: Message }> = [];
    const done: string[] = [];

    agent.on(StreamEventType.TOOL_EXECUTE_ERROR, (event) => errors.push(event));
    agent.on(StreamEventType.TOOL_EXECUTE_DONE, (event) => done.push(event.name));

    const reply = await agent.run("use failing tool");

    assert.equal(reply.text, "handled tool failure");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].result?.metadata.toolExecutionError !== undefined, true);
    assert.match(errors[0].error.message, /recoverable failure/);
    assert.deepEqual(done, []);
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

  it("rejects concurrent runs without mutating the session", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FakeOpenAIClient().enqueue(() => (async function* () {
      await gate;
      yield textChunks("first reply")[0];
    })());
    const session = Session.create();
    const agent = new Agent({ client, model: "fake-model", session });

    const firstRun = agent.run("first");
    await waitFor(() => agent.isRunning);

    await assert.rejects(
      () => agent.run("second"),
      AgentAlreadyRunningError
    );
    assert.deepEqual(session.history().map((msg) => msg.text), ["first"]);

    release!();
    assert.equal((await firstRun).text, "first reply");
    assert.equal(agent.isRunning, false);
  });

  it("fails the run when stream parsing emits an error", async () => {
    const malformedChunk: StreamChunk = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            get function() {
              throw new Error("bad streamed tool call");
            },
          }],
        },
      }],
    };
    const client = new FakeOpenAIClient().enqueue([malformedChunk]);
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
    });
    const errors: Error[] = [];
    agent.on(StreamEventType.ERROR, (event) => errors.push(event.error));

    await assert.rejects(agent.run("parse this"), /bad streamed tool call/);

    assert.equal(errors.length, 1);
    assert.equal(agent.lastRunState?.status, "failed");
    assert.equal(agent.lastRunState?.stopReason, "unknown_error");
    assert.deepEqual(agent.session.history().map((msg) => msg.text), ["parse this"]);
  });

  it("reports rejected promises from async event handlers", async () => {
    const client = new FakeOpenAIClient().enqueue(textChunks("hello"));
    const agent = new Agent({
      client,
      model: "fake-model",
      session: Session.create(),
    });
    const handlerErrors: Error[] = [];

    agent.setHandlerErrorHandler((error) => handlerErrors.push(error));
    agent.on(StreamEventType.TEXT_DELTA, async () => {
      await Promise.resolve();
      throw new Error("async handler failed");
    });

    assert.equal((await agent.run("hello")).text, "hello");
    await waitFor(() => handlerErrors.length === 1);
    assert.match(handlerErrors[0].message, /async handler failed/);
  });
});
