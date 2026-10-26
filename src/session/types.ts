import { Message, MessageContent, MessageData, Role } from "../message";
import { ExecutionTrace, TraceData } from "./trace";
import type { SessionQuery } from "./SessionQuery";
import type { TreeStructure, ListStructure, AgentStructure } from "./structures";
export class SessionConflictError extends Error {
    readonly code = "SESSION_CONFLICT";
    constructor() {
        super("The session changed while generation was in progress");
        this.name = "SessionConflictError";
    }
}
export type QueryScope = "active" | "all";
export type SessionQueries = Pick<SessionQuery, "messages" | "turns" | "runs" | "steps" | "toolExecutions">;
export interface MessageCriteria {
    id?: string;
    role?: Role;
    tags?: readonly string[];
    content?: string | RegExp;
    partType?: MessageData["parts"][number]["type"];
    metadata?: Record<string, unknown>;
    turnId?: string;
    runId?: string;
    stepId?: string;
    toolCallId?: string;
    scope?: QueryScope;
    offset?: number;
    limit?: number;
    predicate?: (message: Message) => boolean;
}
export interface SessionDataBase {
    format: "agent-engine-session";
    version: 3;
    id: string;
    title?: string;
    metadata?: Record<string, unknown>;
    systemMessageId: string;
    messages: MessageData[];
    trace: TraceData;
}
export interface TreeSessionData extends SessionDataBase { type: "tree"; structure: TreeStructure; }
export interface ListSessionData extends SessionDataBase { type: "list"; structure: ListStructure; }
export interface AgentSessionData extends SessionDataBase { type: "agent"; structure: AgentStructure; }
export type SessionData = TreeSessionData | ListSessionData | AgentSessionData;
export interface ContinuationCommitOptions { draft?: Message; baseline?: Message; }
export interface SessionLike {
    readonly id: string;
    readonly type: SessionData["type"];
    readonly trace: ExecutionTrace;
    readonly query: SessionQueries;
    readonly currentTurnId: string | undefined;
    readonly isGenerating: boolean;
    readonly metadata: Readonly<Record<string, unknown>>;
    setMeta(key: string, value: unknown): this; deleteMeta(key: string): this;
    history(): Message[];
    addMessage(message: Message): Message;
    addUser(content: MessageContent): Message;
    getMessage(id: string): Message | undefined;
    editMessage(id: string, edit: (message: Message) => void): Message;
    beginGeneration(): void;
    assertGenerationUnchanged(): void;
    appendGenerated(message: Message): Message;
    appendContinuation(targetId: string, generated: Message, options?: ContinuationCommitOptions): Message;
    endGeneration(): void;
    toJSON(): SessionData;
}
