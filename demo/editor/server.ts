import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { OpenAI } from "openai";
import {
  Agent, Session, Tool, Param, ToolKit,
  RequestConfig, StreamEventType, Message,
  ThinkingDeltaEvent, ThinkingDoneEvent,
  TextDeltaEvent, ToolCallStartEvent, ToolCallDeltaEvent, ToolCallDoneEvent,
} from "../../src";

const PORT = 3001;

// ========================
//  工具：操作编辑器
// ========================

function createTools(editorContentRef: { current: string }) {
  const readEditor = Tool.create(async () => {
    return editorContentRef.current || "(编辑器为空)";
  })
    .name("read_editor")
    .description("读取编辑器中的全部代码。修改代码前务必先调用此工具确认当前内容。")
    .build();

  const editCode = Tool.create(async (args: Record<string, unknown>) => {
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const content = editorContentRef.current;

    if (!content.includes(oldStr)) {
      return JSON.stringify({
        error: "未找到要替换的代码片段。请先用 read_editor 查看当前代码，确保 old_string 与编辑器中的内容完全一致（包括缩进、空格和换行）。"
      });
    }

    editorContentRef.current = content.replace(oldStr, newStr);
    return JSON.stringify({ success: true, message: "代码已更新" });
  })
    .name("edit_code")
    .description(
      "替换编辑器中的代码片段。old_string 必须与编辑器中的原始代码逐字符完全一致（包括缩进、空格）。" +
      "如果不确定原始内容，请先调用 read_editor。"
    )
    .params(
      Param.string("old_string").desc("要替换的原代码片段，必须与编辑器完全一致").required(),
      Param.string("new_string").desc("替换后的新代码").required(),
    )
    .build();

  const insertAtLine = Tool.create(async (args: Record<string, unknown>) => {
    const lineNumber = args.line_number as number;
    const code = args.code as string;
    const lines = editorContentRef.current.split("\n");

    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return JSON.stringify({
        error: `行号 ${lineNumber} 超出范围，当前代码共 ${lines.length} 行，有效行号 1-${lines.length + 1}。`
      });
    }

    lines.splice(lineNumber - 1, 0, code);
    editorContentRef.current = lines.join("\n");
    return JSON.stringify({ success: true, message: `已在第 ${lineNumber} 行插入代码` });
  })
    .name("insert_at_line")
    .description("在指定行号（1-based）之前插入一行或多行代码。")
    .params(
      Param.integer("line_number").desc("插入位置行号，从1开始，新代码插入到该行之前").required(),
      Param.string("code").desc("要插入的代码（可含换行）").required(),
    )
    .build();

  return { readEditor, editCode, insertAtLine };
}

// ========================
//  Agent 创建
// ========================

function createEditorAgent(
  apiKey: string,
  baseUrl: string,
  model: string,
  editorContentRef: { current: string },
  sendEvent: (event: string, data: any) => void
): Agent {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });
  const { readEditor, editCode, insertAtLine } = createTools(editorContentRef);
  const toolkit = new ToolKit().add(readEditor, editCode, insertAtLine);

  const session = Session.create(
    "你是一个嵌入在网页代码编辑器中的 AI 编程助手。\n\n" +
    "你有以下工具可用：\n" +
    "- read_editor：读取编辑器中的完整代码\n" +
    "- edit_code：替换编辑器中的代码片段（需提供精确匹配的 old_string 和新代码 new_string）\n" +
    "- insert_at_line：在指定行号前插入代码\n\n" +
    "工作准则：\n" +
    "1. 修改代码前务必先调用 read_editor 查看当前代码\n" +
    "2. edit_code 的 old_string 必须与原文逐字符一致（包括缩进和空格）\n" +
    "3. 写代码时遵循语言的最佳实践和命名规范\n" +
    "4. 解释代码时简洁清晰，用中文回复\n" +
    "5. 主动添加注释说明关键逻辑"
  );

  const config = RequestConfig.create().temperature(0.3).maxTokens(4096);

  const agent = new Agent({
    client, model, session, toolkit, config,
  });

  agent
    .on(StreamEventType.THINKING_DELTA, (e) => {
      sendEvent("thinking_delta", { delta: (e as ThinkingDeltaEvent).delta });
    })
    .on(StreamEventType.THINKING_DONE, (e) => {
      sendEvent("thinking_done", { thinking: (e as ThinkingDoneEvent).thinking });
    })
    .on(StreamEventType.TEXT_DELTA, (e) => {
      sendEvent("text_delta", { delta: (e as TextDeltaEvent).delta });
    })
    .on(StreamEventType.TOOL_CALL_START, (e) => {
      const ev = e as ToolCallStartEvent;
      sendEvent("tool_call_start", { index: ev.index, name: ev.name, toolCallId: ev.toolCallId });
    })
    .on(StreamEventType.TOOL_CALL_DELTA, (e) => {
      const ev = e as ToolCallDeltaEvent;
      sendEvent("tool_call_delta", { index: ev.index, argsDelta: ev.argsDelta, argsSnapshot: ev.argsSnapshot });
    })
    .on(StreamEventType.TOOL_CALL_DONE, (e) => {
      const ev = e as ToolCallDoneEvent;
      sendEvent("tool_call_done", { index: ev.index, name: ev.name, arguments: ev.arguments });
    });

  return agent;
}

// ========================
//  HTTP 服务器
// ========================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  try {
    // 静态页面
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // API: 获取模型列表（代理）
    if (url.pathname === "/api/models" && req.method === "POST") {
      const body = await readBody(req);
      const { apiKey, baseUrl } = body;

      if (!apiKey || !baseUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 apiKey 或 baseUrl" }));
        return;
      }

      try {
        const modelsUrl = baseUrl.replace(/\/+$/, "") + "/models";
        const fetchRes = await fetch(modelsUrl, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });
        if (!fetchRes.ok) throw new Error(`${fetchRes.status} ${fetchRes.statusText}`);
        const data = await fetchRes.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err: any) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: 聊天 (SSE)
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readBody(req);
      const { messages, editorContent, apiKey, baseUrl, model, deepseekMode } = body;

      if (!apiKey || !baseUrl || !model) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 apiKey / baseUrl / model" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const controller = new AbortController();
      req.on("close", () => {
        if (req.destroyed && !res.writableEnded) {
          controller.abort(new Error("Client disconnected"));
        }
      });
      req.on("error", () => controller.abort(new Error("Request error")));

      try {
        await handleChat(messages || [], editorContent || "", apiKey, baseUrl, model, !!deepseekMode, sendEvent, controller.signal);
      } catch (err: any) {
        sendEvent("error", { message: err.message || "未知错误" });
      }

      sendEvent("done", {});
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (err: any) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ========================
//  聊天处理
// ========================

async function handleChat(
  messages: { role: string; content: string }[],
  editorContent: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  deepseekMode: boolean,
  sendEvent: (event: string, data: any) => void,
  signal?: AbortSignal
): Promise<void> {
  const editorContentRef = { current: editorContent };
  const agent = createEditorAgent(apiKey, baseUrl, model, editorContentRef, sendEvent);

  // 把历史消息加入 Session（最后一条用户消息除外，它由 agent.run() 添加）
  const historyMessages = messages.slice(0, -1);
  for (const msg of historyMessages) {
    if (msg.role === "user") {
      agent.session.addUser(msg.content);
    } else if (msg.role === "assistant") {
      agent.session.addAssistant(Message.assistant(msg.content));
    }
  }

  const lastMsg = messages[messages.length - 1];
  const userInput = lastMsg?.content || "你好";

  // DeepSeek 等模型要求工具调用时回传 reasoning_content，否则会报错
  const runOptions: Record<string, unknown> = deepseekMode
    ? { serializeOptions: { thinking: { mode: "native" as const, scope: "tool_call" as const } } }
    : {};
  if (signal) runOptions.signal = signal;

  let reply: Message;
  try {
    reply = await agent.run(userInput, runOptions);
  } catch (err) {
    // 即使出错也要发 code_diff，因为工具可能已经修改了编辑器内容
    sendEvent("code_diff", { editorContent: editorContentRef.current });
    throw err;
  }

  // 返回最新编辑器内容 + AI 文本回复
  sendEvent("code_diff", { editorContent: editorContentRef.current });
  sendEvent("reply_text", { content: reply.text });
}

// ========================
//  辅助
// ========================

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// ========================
//  启动
// ========================

server.listen(PORT, "0.0.0.0", () => {
  const nets = require("os").networkInterfaces();
  let localIp = "localhost";
  for (const iface of Object.values(nets) as any[]) {
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) {
        localIp = cfg.address;
        break;
      }
    }
  }

  console.log("\n" + "═".repeat(50));
  console.log("  💻 代码编辑器 AI 助手 — AgentEngine");
  console.log("═".repeat(50));
  console.log(`\n  本机访问: http://localhost:${PORT}`);
  console.log(`  局域网:   http://${localIp}:${PORT}`);
  console.log("═".repeat(50) + "\n");
});
