import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Context,
  Hook,
  McpToolAdapter,
  Param,
  Tool,
  ToolExecutionError,
  ToolKit,
  ValueType,
  type McpClientLike,
} from "../../src/tool";

describe("Param", () => {
  it("builds primitive parameter schemas", () => {
    assert.deepEqual(
      Param.string("city").desc("City name").required().enum(["Paris", "Tokyo"]).toSchema(),
      {
        type: ValueType.String,
        description: "City name",
        enum: ["Paris", "Tokyo"],
      }
    );

    assert.deepEqual(Param.integer("count").desc("Count").toSchema(), {
      type: ValueType.Integer,
      description: "Count",
    });
    assert.deepEqual(Param.number("score").toSchema(), {
      type: ValueType.Number,
      description: "",
    });
    assert.deepEqual(Param.boolean("enabled").toSchema(), {
      type: ValueType.Boolean,
      description: "",
    });
  });

  it("builds array and nested object schemas", () => {
    const tags = Param.array("tags", ValueType.String).desc("Tags");
    const items = Param.array("items", [
      Param.string("name").required(),
      Param.number("price"),
    ]);
    const address = Param.object("address", [
      Param.string("city").required(),
      Param.object("geo", [
        Param.number("lat").required(),
        Param.number("lng").required(),
      ]),
    ]);

    assert.deepEqual(tags.toSchema(), {
      type: ValueType.Array,
      description: "Tags",
      items: { type: ValueType.String },
    });
    assert.deepEqual(items.toSchema(), {
      type: ValueType.Array,
      description: "",
      items: {
        type: "object",
        properties: {
          name: { type: ValueType.String, description: "" },
          price: { type: ValueType.Number, description: "" },
        },
        required: ["name"],
      },
    });
    assert.deepEqual(address.toSchema(), {
      type: ValueType.Object,
      description: "",
      properties: {
        city: { type: ValueType.String, description: "" },
        geo: {
          type: ValueType.Object,
          description: "",
          properties: {
            lat: { type: ValueType.Number, description: "" },
            lng: { type: ValueType.Number, description: "" },
          },
          required: ["lat", "lng"],
        },
      },
      required: ["city"],
    });
  });
});

describe("Tool", () => {
  it("builds a function schema and becomes immutable after build", () => {
    const tool = Tool.create(async () => "sunny")
      .name("get_weather")
      .description("Get weather")
      .params(
        Param.string("city").desc("City").required(),
        Param.string("unit").desc("Unit").enum(["celsius", "fahrenheit"])
      )
      .build();

    assert.equal(tool.toolName, "get_weather");
    assert.deepEqual(tool.schema, {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City" },
            unit: {
              type: "string",
              description: "Unit",
              enum: ["celsius", "fahrenheit"],
            },
          },
          required: ["city"],
        },
      },
    });
    assert.throws(() => tool.description("Changed"));
  });

  it("requires build before runtime APIs are used", () => {
    const tool = Tool.create(async () => "ok").name("unbuilt");

    assert.throws(() => tool.schema);
    assert.throws(() => tool.create("call_1", {}));
  });

  it("runs lifecycle hooks in order and lets hooks change arguments, result, and serialization", async () => {
    const calls: string[] = [];
    const tool = Tool.create(async (args, ctx) => {
      calls.push("execute");
      assert.equal(ctx.id, "call_1");
      assert.equal(ctx.name, "sum");
      return Number(args.a) + Number(args.b);
    })
      .name("sum")
      .params(
        Param.number("a").required(),
        Param.number("b").required()
      )
      .on(Hook.ON_CREATE, (ctx) => {
        calls.push("on_create");
        ctx.arguments.a = Number(ctx.arguments.a) + 1;
      })
      .on(Hook.ON_VALIDATE, (ctx) => {
        calls.push("on_validate");
        ctx.arguments.b = Number(ctx.arguments.b) + 1;
      })
      .on(Hook.BEFORE_EXECUTE, (ctx) => {
        calls.push("before_execute");
        ctx.arguments.a = Number(ctx.arguments.a) * 2;
      })
      .on(Hook.AFTER_EXECUTE, (ctx) => {
        calls.push("after_execute");
        ctx.result = { value: ctx.result };
      })
      .on(Hook.ON_SERIALIZE, (ctx) => {
        calls.push("on_serialize");
        ctx.result = { ...ctx.result as object, serialized: true };
      })
      .build();

    const call = tool.create("call_1", { a: 1, b: 2 });

    assert.deepEqual(call.arguments, { a: 2, b: 3 });
    assert.equal(call.isExecuted, false);
    await assert.rejects(async () => call.result);
    assert.deepEqual(await call.execute(), { value: 7 });
    assert.equal(call.isExecuted, true);
    assert.deepEqual(call.result, { value: 7 });
    assert.equal(call.toMessage().text, "{\"value\":7,\"serialized\":true}");
    assert.deepEqual(calls, [
      "on_create",
      "on_validate",
      "before_execute",
      "execute",
      "after_execute",
      "on_serialize",
    ]);
  });

  it("validates required parameters during call creation", () => {
    const tool = Tool.create(async () => "ok")
      .name("needs_arg")
      .params(Param.string("required_value").required())
      .build();

    assert.throws(() => tool.create("call_1", {}));
  });

  it("lets ON_ERROR provide fallback results during validation and execution", async () => {
    const validationFallback = Tool.create(async () => "unreachable")
      .name("validate_fallback")
      .params(Param.string("name").required())
      .on(Hook.ON_ERROR, (ctx) => {
        ctx.result = { fallback: true, phase: ctx.error?.message };
      })
      .build();
    const validationCall = validationFallback.create("call_1", {});

    assert.equal(await validationCall.execute(), "unreachable");

    const executionFallback = Tool.create(async () => {
      throw new Error("boom");
    })
      .name("execution_fallback")
      .on(Hook.ON_ERROR, (ctx) => {
        ctx.result = { fallback: true, message: ctx.error?.message };
      })
      .build();
    const executionCall = executionFallback.create("call_2", {});

    assert.deepEqual(await executionCall.execute(), {
      fallback: true,
      message: "boom",
    });
    assert.equal(executionCall.error?.message, "boom");
  });

  it("can cancel execution in BEFORE_EXECUTE", async () => {
    const tool = Tool.create(async () => "unreachable")
      .name("cancelled")
      .on(Hook.BEFORE_EXECUTE, (ctx) => {
        ctx.cancel("blocked");
      })
      .build();

    await assert.rejects(
      () => tool.create("call_1", {}).execute(),
      /blocked/
    );
  });

  it("throws abort reasons from Context", () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    const ctx = new Context("call_1", "tool", {}, controller.signal);

    controller.abort(reason);

    assert.throws(() => ctx.throwIfAborted(), reason);
  });
});

describe("ToolKit", () => {
  it("registers tools and exposes schemas and names", () => {
    const first = Tool.create(async () => "first").name("first").description("First").build();
    const second = Tool.create(async () => "second").name("second").description("Second").build();
    const toolkit = new ToolKit().add(first, second);

    assert.equal(toolkit.size, 2);
    assert.deepEqual(toolkit.names, ["first", "second"]);
    assert.equal(toolkit.has("first"), true);
    assert.equal(toolkit.get("second"), second);
    assert.deepEqual(toolkit.schemas, [first.schema, second.schema]);
    assert.throws(() => toolkit.add(first));
  });

  it("executes a known tool call and serializes its result", async () => {
    const tool = Tool.create(async (args) => ({ echo: args.value }))
      .name("echo")
      .params(Param.string("value").required())
      .build();
    const toolkit = new ToolKit().add(tool);

    const result = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_1",
      name: "echo",
      arguments: "{\"value\":\"hello\"}",
    });

    assert.equal(result.text, "{\"echo\":\"hello\"}");
  });

  it("returns model-readable errors for unknown tools, invalid JSON arguments, and execution failures", async () => {
    const tool = Tool.create(async (args) => {
      if (!args.ok) throw new Error("not ok");
      return "ok";
    })
      .name("maybe")
      .build();
    const toolkit = new ToolKit().add(tool);

    const unknown = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_unknown",
      name: "missing",
      arguments: "{}",
    });
    const invalidArgs = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_invalid",
      name: "maybe",
      arguments: "not json",
    });

    assert.match(unknown.text, /missing|未知|鏈煡/);
    assert.match(invalidArgs.text, /invalid_tool_arguments/);
    assert.match(invalidArgs.text, /JSON/);

    await assert.rejects(
      () => toolkit.execute({
        type: "tool_call",
        toolCallId: "call_unknown_throw",
        name: "missing",
        arguments: "{}",
      }, { errorPolicy: "throw" }),
      ToolExecutionError
    );
  });

  it("does not execute tools when arguments are not JSON objects", async () => {
    let executions = 0;
    const tool = Tool.create(async () => {
      executions++;
      return "ok";
    })
      .name("strict_args")
      .build();
    const toolkit = new ToolKit().add(tool);

    const arrayArgs = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_array",
      name: "strict_args",
      arguments: "[]",
    });

    assert.equal(executions, 0);
    assert.match(arrayArgs.text, /invalid_tool_arguments/);

    await assert.rejects(
      () => toolkit.execute({
        type: "tool_call",
        toolCallId: "call_invalid",
        name: "strict_args",
        arguments: "not json",
      }, { errorPolicy: "throw" }),
      ToolExecutionError
    );
  });

  it("accepts an empty argument buffer for parameterless tools", async () => {
    const tool = Tool.create(async (args) => ({ keys: Object.keys(args) }))
      .name("no_args")
      .build();
    const toolkit = new ToolKit().add(tool);

    const result = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_empty",
      name: "no_args",
      arguments: "",
    });

    assert.equal(result.text, "{\"keys\":[]}");
  });

  it("applies the error policy to tool creation validation", async () => {
    const tool = Tool.create(async () => "ok")
      .name("required_args")
      .params(Param.string("value").required())
      .build();
    const toolkit = new ToolKit().add(tool);

    const result = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_missing",
      name: "required_args",
      arguments: "{}",
    });
    assert.match(result.text, /缺少必填参数/);

    await assert.rejects(
      () => toolkit.execute({
        type: "tool_call",
        toolCallId: "call_missing_throw",
        name: "required_args",
        arguments: "{}",
      }, { errorPolicy: "throw" }),
      ToolExecutionError
    );
  });

  it("throws ToolExecutionError when configured with throw policy", async () => {
    const tool = Tool.create(async () => {
      throw new Error("boom");
    })
      .name("fail")
      .build();
    const toolkit = new ToolKit().add(tool);

    await assert.rejects(
      () => toolkit.execute({
        type: "tool_call",
        toolCallId: "call_1",
        name: "fail",
        arguments: "{}",
      }, { errorPolicy: "throw" }),
      (error) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.equal(error.toolCallId, "call_1");
        assert.equal(error.toolName, "fail");
        assert.match(error.message, /boom/);
        return true;
      }
    );
  });

  it("executes multiple tool calls in parallel order", async () => {
    const one = Tool.create(async () => "one").name("one").build();
    const two = Tool.create(async () => "two").name("two").build();
    const toolkit = new ToolKit().add(one, two);

    const results = await toolkit.executeAll([
      { type: "tool_call", toolCallId: "call_1", name: "one", arguments: "{}" },
      { type: "tool_call", toolCallId: "call_2", name: "two", arguments: "{}" },
    ]);

    assert.deepEqual(results.map((msg) => msg.text), ["one", "two"]);
  });

  it("adds MCP tools without replacing existing tools with the same name", async () => {
    const existing = Tool.create(async () => "local").name("remote_tool").build();
    const client: McpClientLike = {
      async listTools() {
        return {
          tools: [
            {
              name: "remote_tool",
              description: "Remote duplicate",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
            {
              name: "new_remote_tool",
              description: "Remote new",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          ],
        };
      },
      async callTool(params) {
        return {
          content: [
            { type: "text", text: `called ${params.name}` },
            { type: "image" },
            { type: "text", text: JSON.stringify(params.arguments ?? {}) },
          ],
        };
      },
    };

    const toolkit = await new ToolKit().add(existing).addMCP(client);

    assert.equal(toolkit.size, 2);
    assert.equal(toolkit.get("remote_tool"), existing);

    const result = await toolkit.execute({
      type: "tool_call",
      toolCallId: "call_1",
      name: "new_remote_tool",
      arguments: "{\"value\":\"x\"}",
    });

    assert.equal(result.text, "called new_remote_tool\n{\"value\":\"x\"}");
  });
});

describe("McpToolAdapter", () => {
  it("converts MCP tool definitions into AgentEngine tools", async () => {
    const calls: unknown[] = [];
    const client: McpClientLike = {
      async listTools() {
        return {
          tools: [
            {
              name: "search",
              description: "Search docs",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        };
      },
      async callTool(params) {
        calls.push(params);
        return {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
            { type: "image" },
          ],
        };
      },
    };

    const [tool] = await McpToolAdapter.fromClient(client);

    assert.equal(tool.toolName, "search");
    assert.deepEqual(tool.schema, {
      type: "function",
      function: {
        name: "search",
        description: "Search docs",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    });

    const call = tool.create("call_1", { query: "agent" });
    assert.equal(await call.execute(), "first\nsecond");
    assert.deepEqual(calls, [
      {
        name: "search",
        arguments: { query: "agent" },
      },
    ]);
  });
});
