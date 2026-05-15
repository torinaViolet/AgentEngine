import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { OpenAI } from "openai";
import {
  Agent, Session, Tool, Param, ToolKit,
  RequestConfig, StreamEventType,
  ThinkingDeltaEvent, ThinkingDoneEvent,
  TextDeltaEvent, ToolCallStartEvent, ToolCallDoneEvent,
} from "../../src";
import {
  Battle, MONSTERS, MonsterTemplate, MoveResult, BattleSnapshot,
} from "./game";

const PORT = 3000;

// ========================
//  全局状态
// ========================

interface GameSession {
  battle: Battle;
  agent: Agent;
  apiKey: string;
  baseUrl: string;
  model: string;
  deepseekMode: boolean;
  /** 每回合执行前的快照，用于回溯 */
  turnSnapshots: BattleSnapshot[];
  sseRes?: http.ServerResponse;
}

const sessions = new Map<string, GameSession>();
let sessionCounter = 0;

function generateSessionId(): string {
  return "gs-" + (++sessionCounter) + "-" + Date.now().toString(36);
}

// ========================
//  AI Agent创建
// ========================

function createBattleAgent(
  apiKey: string,
  baseUrl: string,
  model: string,
  sendEvent: (event: string, data: any) => void
): Agent {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  // 工具：选择技能
  const chooseTool = Tool.create(async (args: Record<string, unknown>) => {
    const moveName = args.move_name as string;
    return JSON.stringify({ chosen: moveName });
  })
    .name("choose_move")
    .description(
      "选择你要使用的技能。必须从可用技能列表中选择一个技能名。" +
      "你需要综合考虑属性克制、命中率、PP剩余量、双方HP等因素做出最优选择。"
    )
    .params(
      Param.string("move_name").desc("要使用的技能名称，必须与可用技能列表中的名称完全一致").required(),
      Param.string("reason").desc("选择该技能的理由，简洁说明战术考量").required()
    )
    .build();

  const toolkit = new ToolKit().add(chooseTool);

  const session = Session.create(
    "你是一个精灵对战游戏中的AI对战训练师。" +
    "你需要在每个回合分析战场局势，然后使用choose_move工具选择一个技能。\n" +
    "策略要点：\n" +
    "1. 优先使用属性克制的技能（效果拔群=2倍伤害）\n" +
    "2. 避免使用被抵抗的技能（效果不好=0.5倍伤害）\n" +
    "3. 注意PP管理，强力技能PP有限\n" +
    "4. 关注双方HP，必要时选择命中率高的技能确保稳定输出\n" +
    "5. 你的reason要简短有趣，带些角色扮演感"
  );

  const config = RequestConfig.create()
    .temperature(0.7)
    .maxTokens(1024);

  const agent = new Agent({
    client,
    model,
    session,
    toolkit,
    config,
  });

  // 注册事件
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
      sendEvent("tool_call_start", { name: ev.name });
    })
    .on(StreamEventType.TOOL_CALL_DONE, (e) => {
      const ev = e as ToolCallDoneEvent;
      sendEvent("tool_call_done", { name: ev.name, arguments: ev.arguments });
    });

  return agent;
}

// ========================
//  HTTP服务器
// ========================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  try {
    // ---- 静态文件 ----
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ---- API: 获取精灵列表 ----
    if (url.pathname === "/api/monsters" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MONSTERS));
      return;
    }

    // ---- API: 获取模型列表（代理） ----
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
        if (!fetchRes.ok) {
          throw new Error(`${fetchRes.status} ${fetchRes.statusText}`);
        }
        const data = await fetchRes.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err: any) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ---- API: 创建对战 ----
    if (url.pathname === "/api/battle/create" && req.method === "POST") {
      const body = await readBody(req);
      const { playerId, enemyId, apiKey, baseUrl, model, deepseekMode } = body;

      if (!playerId || !enemyId || !apiKey || !baseUrl || !model) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少参数" }));
        return;
      }

      const sessionId = generateSessionId();
      const battle = new Battle(playerId, enemyId);

      const dummySend = () => { };
      const agent = createBattleAgent(apiKey, baseUrl, model, dummySend);

      sessions.set(sessionId, {
        battle, agent, apiKey, baseUrl, model,
        deepseekMode: !!deepseekMode,
        turnSnapshots: [battle.snapshot()],  // 保存初始状态
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId, snapshot: battle.snapshot() }));
      return;
    }

    // ---- API: 玩家行动 (SSE 流式) ----
    if (url.pathname === "/api/battle/action" && req.method === "POST") {
      const body = await readBody(req);
      const { sessionId, moveIndex } = body;

      const gs = sessions.get(sessionId);
      if (!gs) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "会话不存在" }));
        return;
      }

      // 设置 SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        await executeTurn(gs, moveIndex, sendEvent);
      } catch (err: any) {
        sendEvent("error", { message: err.message || "未知错误" });
      }

      sendEvent("done", {});
      res.end();
      return;
    }

    // ---- API: 回溯到指定回合 ----
    if (url.pathname === "/api/battle/rewind" && req.method === "POST") {
      const body = await readBody(req);
      const { sessionId, turnIndex } = body;

      const gs = sessions.get(sessionId);
      if (!gs) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "会话不存在" }));
        return;
      }

      if (turnIndex < 0 || turnIndex >= gs.turnSnapshots.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "无效的回合索引" }));
        return;
      }

      // 从快照恢复 Battle
      const targetSnapshot = gs.turnSnapshots[turnIndex];
      gs.battle = Battle.fromSnapshot(targetSnapshot);

      // 截断快照历史到目标回合
      gs.turnSnapshots = gs.turnSnapshots.slice(0, turnIndex + 1);

      const dummySend = () => { };
      gs.agent = createBattleAgent(gs.apiKey, gs.baseUrl, gs.model, dummySend);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        snapshot: gs.battle.snapshot(),
        currentTurn: gs.battle.turn,
        totalSnapshots: gs.turnSnapshots.length,
      }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (err: any) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ========================
//  对战回合执行
// ========================

function pushCurrentSnapshot(gs: GameSession): BattleSnapshot {
  const snapshot = gs.battle.snapshot();
  gs.turnSnapshots = gs.turnSnapshots.slice(0, snapshot.turn + 1);
  gs.turnSnapshots[snapshot.turn] = snapshot;
  return snapshot;
}

function sendRewindInfo(gs: GameSession, sendEvent: (event: string, data: any) => void): void {
  sendEvent("rewind_info", {
    currentTurn: gs.battle.turn,
    canRewind: gs.battle.turn > 0,
    totalSnapshots: gs.turnSnapshots.length,
  });
}

function sendBattleEnd(gs: GameSession, sendEvent: (event: string, data: any) => void): void {
  const snapshot = pushCurrentSnapshot(gs);
  sendRewindInfo(gs, sendEvent);
  sendEvent("battle_end", { winner: gs.battle.winner, snapshot });
}

async function executeTurn(
  gs: GameSession,
  playerMoveIndex: number,
  sendEvent: (event: string, data: any) => void
): Promise<void> {
  const { battle } = gs;
  const snap = battle.snapshot();

  if (battle.isOver) {
    sendBattleEnd(gs, sendEvent);
    return;
  }

  const playerMoveName = snap.playerTemplate.moves[playerMoveIndex]?.name;
  if (!playerMoveName) {
    sendEvent("error", { message: "无效的技能索引" });
    return;
  }

  const playerSpeed = snap.playerTemplate.speed;
  const enemySpeed = snap.enemyTemplate.speed;
  const playerFirst = playerSpeed >= enemySpeed;

  battle.nextTurn();

  const agent = gs.agent;
  agent.removeAllListeners();
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
      sendEvent("tool_call_start", { name: ev.name });
    })
    .on(StreamEventType.TOOL_CALL_DONE, (e) => {
      const ev = e as ToolCallDoneEvent;
      sendEvent("tool_call_done", { name: ev.name, arguments: ev.arguments });
    });

  if (playerFirst) {
    sendEvent("phase", { phase: "player_attack" });
    const playerResult = battle.executeMove("player", playerMoveName);
    sendEvent("move_result", playerResult);

    if (battle.isOver) {
      sendBattleEnd(gs, sendEvent);
      return;
    }

    sendEvent("phase", { phase: "enemy_thinking" });
    const aiMove = await getAIMove(agent, battle, sendEvent, gs.deepseekMode);
    sendEvent("phase", { phase: "enemy_attack" });
    const enemyResult = battle.executeMove("enemy", aiMove);
    sendEvent("move_result", enemyResult);
  } else {
    sendEvent("phase", { phase: "enemy_thinking" });
    const aiMove = await getAIMove(agent, battle, sendEvent, gs.deepseekMode);
    sendEvent("phase", { phase: "enemy_attack" });
    const enemyResult = battle.executeMove("enemy", aiMove);
    sendEvent("move_result", enemyResult);

    if (battle.isOver) {
      sendBattleEnd(gs, sendEvent);
      return;
    }

    sendEvent("phase", { phase: "player_attack" });
    const playerResult = battle.executeMove("player", playerMoveName);
    sendEvent("move_result", playerResult);
  }

  if (battle.isOver) {
    sendBattleEnd(gs, sendEvent);
  } else {
    const snapshot = pushCurrentSnapshot(gs);
    sendEvent("snapshot", snapshot);
    sendRewindInfo(gs, sendEvent);
  }

}


async function getAIMove(
  agent: Agent,
  battle: Battle,
  sendEvent: (event: string, data: any) => void,
  deepseekMode: boolean = false
): Promise<string> {
  const desc = battle.describeForAI();
  const snap = battle.snapshot();

  // DeepSeek 系列模型要求工具调用时回传 reasoning_content，否则会报错
  const runOptions: Record<string, unknown> = deepseekMode
    ? { serializeOptions: { thinking: { mode: "native" as const, scope: "tool_call" as const } } }
    : {};

  try {
    const reply = await agent.run(
      `当前战场状态:\n${desc}\n\n请分析局势并使用choose_move选择你的技能。`,
      runOptions
    );

    // 从工具调用中提取选择的技能
    const toolCalls = reply.toolCalls;
    if (toolCalls.length > 0) {
      try {
        const args = JSON.parse(toolCalls[0].arguments);
        if (args.move_name) {
          sendEvent("ai_reason", { reason: args.reason || "" });
          return args.move_name;
        }
      } catch { }
    }

    // 从文本中提取（兜底）
    for (const move of snap.enemyTemplate.moves) {
      if (reply.text.includes(move.name)) {
        return move.name;
      }
    }
  } catch (err: any) {
    sendEvent("ai_error", { message: err.message });
  }

  //兜底：随机选一个有PP的技能
  const available = snap.enemyTemplate.moves
    .map((m, i) => ({ name: m.name, pp: snap.enemy.pp[i] }))
    .filter((m) => m.pp > 0);
  return available.length > 0
    ? available[Math.floor(Math.random() * available.length)].name
    : snap.enemyTemplate.moves[0].name;
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
  console.log("  🎮 精灵对战 Demo — AgentEngine");
  console.log("═".repeat(50));
  console.log(`\n本机访问: http://localhost:${PORT}`);
  console.log(`  局域网:http://${localIp}:${PORT}`);
  console.log(`\n  分享局域网地址给朋友即可一起玩！`);
  console.log("═".repeat(50) + "\n");
});