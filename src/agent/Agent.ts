import { abortable, assert, errorOf, Events, id } from "../core/data";
import { Generator, GenerationEvent } from "../generator";
import { Message, MessageContent, Role } from "../message";
import { GenerationConfig, GenerationError, ChatProvider, ThinkingConfig } from "../provider";
import { PromptBuilder, PromptContext, PromptBuildOptions } from "../prompt";
import { AgentSession, ListSession, RunRecord, SessionConflictError, SessionLike, TokenUsage, TreeSession, prepareContinuation, ContinuationCommitOptions } from "../session";
import { ToolEvent, ToolExecutionError, ToolExecutor, ToolExecutorOptions, ToolKit, ToolOutcome } from "../tool";
export interface AgentExecutionConfig {
    maxSteps?: number;
    timeoutMs?: number;
    toolErrorPolicy?: "return" | "pause" | "throw";
    toolConcurrency?: "sequential" | "parallel";
}
export interface RunOptions {
    signal?: AbortSignal;
    stream?: boolean;
    generation?: GenerationConfig;
    execution?: AgentExecutionConfig;
    thinking?: ThinkingConfig;
}
export interface ContinueOptions extends RunOptions { targetMessageId?: string; instruction?: string; carryThinking?: boolean; }
export type PreviewContextOptions = { kind?: "run" } | ({ kind: "continue" } & Pick<ContinueOptions, "targetMessageId" | "instruction" | "carryThinking">) | { kind: "resume" };
export const TEMPORARY_PROMPT_TAG = "agent-engine:temporary";
export const CONTINUATION_INSTRUCTION_TAG = "agent-engine:continue-instruction";
export const CONTINUATION_THINKING_TAG = "agent-engine:continue-thinking";
export interface CommitContext {
    runId: string;
    stepId: string;
    operation: "create" | "append";
    targetMessageId?: string;
    /** Detached snapshot, safe to inspect without editing the live target. */
    targetMessage?: Message;
}
export interface AppendCommitContext extends CommitContext { targetMessage: Message; generatedMessage: Message; }
export interface AgentHooks {
    beforeRequest?: (context: PromptContext, identity: {
        runId: string;
        stepId: string;
    }) => void | Promise<void>;
    beforeCommit?: (message: Message, context: CommitContext) => Message | void | Promise<Message | void>;
    beforeAppend?: (draft: Message, context: AppendCommitContext) => Message | void | Promise<Message | void>;
    afterCommit?: (message: Message, context: CommitContext) => void | Promise<void>;
    afterRun?: (result: AgentResult) => void | Promise<void>;
}
type ModelOptions = {
    generator: Generator;
    provider?: never;
    model?: never;
} | {
    generator?: never;
    provider: ChatProvider;
    model: string;
    generation?: GenerationConfig;
};
type SessionOptions<S extends SessionLike> = {
    session: S;
    mode?: never;
} | {
    session?: never;
    mode: "tree" | "list" | "agent";
    sessionOptions?: {
        systemPrompt?: string;
        candidateUnit?: "sequence" | "turn";
    };
};
export type AgentOptions<S extends SessionLike = SessionLike> = ModelOptions & SessionOptions<S> & {
    promptBuilder?: PromptBuilder;
    toolkit?: ToolKit;
    toolExecutor?: ToolExecutor;
    tools?: Omit<ToolExecutorOptions, "toolkit">;
    execution?: AgentExecutionConfig;
    thinking?: ThinkingConfig;
    hooks?: AgentHooks;
    onHandlerError?: (error: Error) => void;
};
export interface AgentResult {
    runId: string;
    turnId?: string;
    status: "completed" | "interrupted" | "failed";
    stopReason: string;
    message?: Message;
    usage: TokenUsage;
    error?: Error;
    unapplied?: Message;
    unappliedToolResults?: Message[];
}
export type AgentEvent = GenerationEvent | ToolEvent | {
    type: "runStarted" | "runFinished";
    runId: string;
    result?: AgentResult;
} | {
    type: "messageCommitted";
    runId: string;
    stepId: string;
    message: Message;
    operation: "create" | "append";
};
export class AgentRunError extends Error {
    constructor(readonly result: AgentResult, readonly cause: unknown) {
        super(errorOf(cause).message);
        this.name = result.status === "interrupted" ? errorOf(cause).name : "AgentRunError";
    }
}
/** Stateful autonomous orchestration, built entirely on independent public modules. */
export class Agent<S extends SessionLike = SessionLike> {
    readonly session: S;
    readonly promptBuilder: PromptBuilder;
    readonly generator: Generator;
    readonly toolExecutor: ToolExecutor;
    private events = new Events<AgentEvent>();
    private controller?: AbortController;
    private last?: AgentResult;
    constructor(private options: AgentOptions<S>) {
        assert(options.session || options.mode, "Supply a session or an explicit mode");
        assert(!(options.session && options.mode), "Session and mode are mutually exclusive");
        assert(!options.mode || ["tree", "list", "agent"].includes(options.mode), "Invalid agent mode");
        assert(!(options.generator && options.provider), "Generator and provider are mutually exclusive");
        const sessionOptions = "sessionOptions" in options ? options.sessionOptions ?? {} : {};
        this.session = (options.session ?? (options.mode === "tree" ? TreeSession.create(sessionOptions.systemPrompt) : options.mode === "list" ? ListSession.create(sessionOptions) : AgentSession.create(sessionOptions))) as S;
        this.generator = options.generator ?? new Generator({ provider: options.provider!, model: options.model!, generation: "generation" in options ? options.generation : undefined });
        this.promptBuilder = options.promptBuilder ?? new PromptBuilder();
        assert(!options.toolExecutor || !options.toolkit || options.toolExecutor.toolkit === options.toolkit, "Conflicting tool registries");
        this.toolExecutor = options.toolExecutor ?? new ToolExecutor({ ...options.tools, toolkit: options.toolkit ?? new ToolKit() });
    }
    on(type: AgentEvent["type"] | "*", handler: (event: AgentEvent) => unknown): () => void {
        return this.events.on(type, handler);
    }
    get isRunning(): boolean {
        return !!this.controller;
    }
    get lastRunState(): AgentResult | undefined {
        return this.last;
    }
    get pendingApprovals() {
        return this.toolExecutor.pendingApprovals;
    }
    approve(approvalId: string): boolean {
        return this.toolExecutor.approve(approvalId);
    }
    reject(approvalId: string, reason?: string): boolean {
        return this.toolExecutor.reject(approvalId, reason);
    }
    abort(reason = "Generation cancelled"): boolean {
        if (!this.controller || this.controller.signal.aborted)
            return false;
        this.controller.abort(new DOMException(reason, "AbortError"));
        return true;
    }
    private idle(): void {
        assert(!this.isRunning && !this.session.isGenerating, "Agent or session already has an active run");
    }
    private async notify(event: AgentEvent): Promise<void> {
        try {
            await this.events.emit(event);
        }
        catch (error) {
            (this.options.onHandlerError ?? (error => console.error(error)))(errorOf(error));
        }
    }
    async chat(input: MessageContent | Message, options: RunOptions = {}): Promise<AgentResult> {
        this.idle();
        options.signal?.throwIfAborted();
        const message = input instanceof Message ? input : Message.user(input);
        assert(message.role === Role.User, "chat requires a user message");
        this.session.addMessage(message);
        return this.execute("chat", options);
    }
    /** Autonomous execution from already prepared context, without adding a user input. */
    async run(options: RunOptions = {}): Promise<AgentResult> {
        this.idle();
        return this.execute("run", options);
    }
    private continuationTarget(options: Pick<ContinueOptions, "targetMessageId">): Message {
        const history = this.session.history();
        const target = options.targetMessageId ? this.session.getMessage(options.targetMessageId) : [...history].reverse().find(m => m.role === Role.Assistant);
        assert(target?.role === Role.Assistant && history.includes(target), "Continuation requires an assistant in the selected history");
        assert(history.at(-1) === target && !target.toolCalls.length, "Continue a final selected reply; unfinished tool calls require resume");
        return target;
    }
    async continue(options: ContinueOptions = {}): Promise<AgentResult> {
        this.idle();
        const target = this.continuationTarget(options);
        return this.execute("continue", options, target, options.instruction ?? "Continue the previous response without repeating it.", options.carryThinking !== false);
    }
    async resume(options: RunOptions = {}): Promise<AgentResult> {
        this.idle();
        assert(this.last && this.last.status !== "completed" && this.last.stopReason !== "conflict", "No resumable in-process run");
        return this.execute("resume", options, undefined, "Continue the interrupted task. Do not repeat completed tool operations.", false, this.last.runId);
    }
    private promptInput(history: Message[], kind: RunRecord["kind"], target?: Message, instruction?: string, carryThinking = false): { messages: Message[]; options: PromptBuildOptions } {
        const messages = [...history]; const sources: NonNullable<PromptBuildOptions["sources"]>[number][] = [];
        if (instruction) {
            if (carryThinking && target?.thinking) {
                const thinking = Message.assistant(target.thinking).tag(TEMPORARY_PROMPT_TAG, CONTINUATION_THINKING_TAG);
                messages.push(thinking); sources.push({ messageId: thinking.id, sourceMessageId: target.id, sourceRevision: target.revision, injected: true, source: "agent.continue.thinking" });
            }
            const user = Message.user(instruction).tag(TEMPORARY_PROMPT_TAG, kind === "continue" ? CONTINUATION_INSTRUCTION_TAG : "agent-engine:resume-instruction");
            messages.push(user); sources.push({ messageId: user.id, injected: true, source: `agent.${kind}.instruction` });
        }
        return { messages, options: { sources } };
    }
    async previewContext(options: PreviewContextOptions = {}): Promise<PromptContext> {
        const kind = options.kind ?? "run";
        const target = options.kind === "continue" ? this.continuationTarget(options) : undefined;
        if (kind === "resume") assert(this.last && this.last.status !== "completed" && this.last.stopReason !== "conflict", "No resumable in-process run");
        const instruction = options.kind === "continue" ? options.instruction ?? "Continue the previous response without repeating it." : kind === "resume" ? "Continue the interrupted task. Do not repeat completed tool operations." : undefined;
        const input = this.promptInput(this.session.history(), kind, target, instruction, options.kind === "continue" && options.carryThinking !== false);
        return this.promptBuilder.preview(input.messages, input.options);
    }
    private async prepareCommit(generated: Message, context: CommitContext, signal?: AbortSignal): Promise<{ generated: Message; append?: ContinuationCommitOptions }> {
        if (context.targetMessageId) context.targetMessage = this.session.getMessage(context.targetMessageId)?.snapshot();
        const transformed = await abortable(Promise.resolve(this.options.hooks?.beforeCommit?.(generated, context)), signal);
        if (transformed) generated = transformed;
        assert(generated.role === Role.Assistant, "Model commit must be an assistant message");
        this.session.assertGenerationUnchanged();
        if (context.operation !== "append") return { generated };
        const target = this.session.getMessage(context.targetMessageId!); assert(target, "Continuation target no longer exists");
        const prepared = prepareContinuation(target, generated); const baseline = prepared.draft.snapshot();
        const draft = await abortable(Promise.resolve(this.options.hooks?.beforeAppend?.(prepared.draft, { ...context, targetMessage: target.snapshot(), generatedMessage: generated.snapshot() })), signal) ?? prepared.draft;
        this.session.assertGenerationUnchanged();
        return { generated, append: { draft, baseline } };
    }
    private async execute(kind: RunRecord["kind"], options: RunOptions, target?: Message, instruction?: string, carryThinking = false, resumedFrom?: string): Promise<AgentResult> {
        const config = { maxSteps: 10, ...this.options.execution, ...options.execution };
        assert(Number.isSafeInteger(config.maxSteps) && config.maxSteps > 0, "maxSteps must be a positive integer");
        if (config.timeoutMs !== undefined)
            assert(Number.isFinite(config.timeoutMs) && config.timeoutMs > 0, "timeoutMs must be positive");
        const controller = new AbortController();
        this.controller = controller;
        const externalAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", externalAbort, { once: true });
        if (options.signal?.aborted)
            externalAbort();
        const timer = config.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new DOMException("Agent run timed out", "TimeoutError")), config.timeoutMs);
        const session = this.session;
        const trace = session.trace;
        const turnId = resumedFrom ? trace.records.runs.find(r => r.id === resumedFrom)?.turnId : session.currentTurnId;
        const run = trace.run(kind, turnId, target?.id, resumedFrom);
        let lastMessage: Message | undefined;
        let stepId: string | undefined;
        let generated: Message | undefined;
        let first = true;
        let started = false;
        let modelCompleted = false;
        let unappliedToolResults: Message[] = [];
        let result: AgentResult | undefined;
        const toolEvents = this.toolExecutor.on("*", event => {
            const eventRun = event.type === "approvalRequired" ? event.request.runId : event.record.runId;
            if (eventRun === run.id)
                return this.notify(event);
        });
        try {
            session.beginGeneration();
            started = true;
            await this.notify({ type: "runStarted", runId: run.id });
            for (let index = 0; index < config.maxSteps; index++) {
                controller.signal.throwIfAborted();
                session.assertGenerationUnchanged();
                const step = trace.step(run.id);
                stepId = step.id;
                modelCompleted = false;
                const input = this.promptInput(session.history(), kind, target, first ? instruction : undefined, carryThinking);
                const context = await abortable(this.promptBuilder.buildContext(input.messages, input.options), controller.signal);
                await abortable(Promise.resolve(this.options.hooks?.beforeRequest?.(context, { runId: run.id, stepId })), controller.signal);
                session.assertGenerationUnchanged();
                const response = await this.generator.generate({ messages: context.messages, tools: this.toolExecutor.toolkit.definitions, generation: options.generation, signal: controller.signal, stream: options.stream,
                    thinking: { mode: "auto", scope: "tool_call", ...this.generator.options.thinking, ...this.options.thinking, ...options.thinking }, identity: { runId: run.id, stepId }, onEvent: event => this.notify(event) });
                generated = response.message;
                modelCompleted = true;
                trace.updateStep(stepId, { status: "completed", finishReason: response.finishReason, usage: response.usage });
                const commitContext: CommitContext = { runId: run.id, stepId, operation: target && first ? "append" : "create", targetMessageId: target && first ? target.id : undefined };
                const prepared = await this.prepareCommit(generated, commitContext, controller.signal); generated = prepared.generated;
                session.assertGenerationUnchanged();
                const previousIds = new Set(session.history().map(message => message.id));
                lastMessage = target && first ? session.appendContinuation(target.id, generated, prepared.append) : session.appendGenerated(generated);
                trace.updateStep(stepId, { messageId: lastMessage.id });
                trace.contribute({ messageId: lastMessage.id, revision: lastMessage.revision, runId: run.id, stepId, operation: commitContext.operation });
                for (const message of session.history())
                    if (!previousIds.has(message.id) && message.id !== lastMessage.id)
                        trace.contribute({ messageId: message.id, revision: message.revision, runId: run.id, stepId, operation: "create" });
                const calls = [...generated.toolCalls];
                generated = undefined;
                await this.notify({ type: "messageCommitted", runId: run.id, stepId, message: lastMessage.snapshot(), operation: commitContext.operation });
                await this.options.hooks?.afterCommit?.(lastMessage, commitContext);
                first = false;
                if (response.finishReason === "length")
                    throw new Error("Model output limit reached");
                if (!calls.length) {
                    result = { runId: run.id, turnId, status: "completed", stopReason: "final", message: lastMessage, usage: trace.usage(run.id) };
                    break;
                }
                const executeTool = (call: typeof calls[number]) => this.toolExecutor.execute(call, { signal: controller.signal, runId: run.id, stepId,
                    errorPolicy: config.toolErrorPolicy === "pause" || config.toolErrorPolicy === "throw" ? "throw" : "return", onRecord: record => {
                        trace.tool(record);
                    } });
                let failure: unknown;
                const outcomes: ToolOutcome[] = [];
                if (config.toolConcurrency === "parallel") {
                    const settled = await Promise.allSettled(calls.map(executeTool));
                    for (let i = 0; i < settled.length; i++) {
                        const item = settled[i];
                        if (item.status === "fulfilled")
                            outcomes.push(item.value);
                        else {
                            failure ??= item.reason;
                            outcomes.push(this.failedTool(calls[i], item.reason, run.id, stepId));
                        }
                    }
                }
                else {
                    for (let i = 0; i < calls.length; i++) {
                        if (failure) {
                            outcomes.push(this.failedTool(calls[i], new Error("Not executed after an earlier tool failure"), run.id, stepId));
                            continue;
                        }
                        try {
                            outcomes.push(await executeTool(calls[i]));
                        }
                        catch (error) {
                            failure = error;
                            outcomes.push(this.failedTool(calls[i], error, run.id, stepId));
                        }
                    }
                }
                unappliedToolResults = outcomes.map(outcome => outcome.message);
                for (const outcome of outcomes) {
                    session.appendGenerated(outcome.message);
                    trace.tool(outcome.record);
                    unappliedToolResults.shift();
                }
                if (failure)
                    throw failure;
            }
            if (!result)
                throw new Error("Agent reached maxSteps without a final reply");
        }
        catch (error) {
            const partial = error instanceof GenerationError ? error.partial?.message : undefined;
            const interrupted = controller.signal.aborted;
            let conflict = error instanceof SessionConflictError;
            let unappliedPartial = partial;
            if (stepId && !modelCompleted)
                trace.updateStep(stepId, { status: interrupted ? "interrupted" : "failed", error: errorOf(error).message });
            if (partial && !partial.isEmpty && (!target || interrupted) && started && stepId) {
                try {
                    const commitContext: CommitContext = { runId: run.id, stepId, operation: target && first ? "append" : "create", targetMessageId: target?.id };
                    const prepared = await this.prepareCommit(partial, commitContext); const transformed = prepared.generated;
                    lastMessage = target && first ? session.appendContinuation(target.id, transformed, prepared.append) : session.appendGenerated(transformed);
                    unappliedPartial = undefined;
                    trace.updateStep(stepId, { messageId: lastMessage.id });
                    trace.contribute({ messageId: lastMessage.id, revision: lastMessage.revision, runId: run.id, stepId, operation: commitContext.operation });
                    for (const call of transformed.toolCalls)
                        session.appendGenerated(Message.tool(call.toolCallId, { error: "Incomplete tool call; no operation was executed", interrupted: true }, call.name));
                    await this.notify({ type: "messageCommitted", runId: run.id, stepId, message: lastMessage.snapshot(), operation: commitContext.operation });
                }
                catch (commitError) {
                    if (commitError instanceof SessionConflictError)
                        conflict = true;
                }
            }
            if (started && !conflict && stepId) {
                try {
                    session.assertGenerationUnchanged();
                    const history = session.history();
                    const answered = new Set(history.flatMap(message => message.parts.filter(part => part.type === "tool_result").map(part => part.toolCallId)));
                    for (const message of history)
                        for (const call of message.toolCalls)
                            if (!answered.has(call.toolCallId)) {
                                const outcome = this.failedTool(call, new Error("Run stopped before this tool produced a result; operation was not started by this step"), run.id, stepId);
                                session.appendGenerated(outcome.message);
                                trace.tool(outcome.record);
                                answered.add(call.toolCallId);
                            }
                }
                catch { /* External edits take precedence over protocol repairs. */
                }
            }
            result = { runId: run.id, turnId, status: interrupted ? "interrupted" : "failed", stopReason: conflict ? "conflict" : interrupted ? errorOf(controller.signal.reason).name === "TimeoutError" ? "timeout" : "abort" : error instanceof ToolExecutionError ? "toolError" : errorOf(error).message.includes("maxSteps") ? "maxSteps" : "error", message: lastMessage, usage: trace.usage(run.id), error: errorOf(error), unapplied: generated ?? unappliedPartial, unappliedToolResults: unappliedToolResults.length ? unappliedToolResults : undefined };
        }
        finally {
            if (started)
                session.endGeneration();
            toolEvents();
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener("abort", externalAbort);
            this.controller = undefined;
        }
        this.last = result!;
        trace.updateRun(run.id, { status: result!.status, stopReason: result!.stopReason });
        await this.notify({ type: "runFinished", runId: run.id, result: result! });
        try {
            await this.options.hooks?.afterRun?.(result!);
        }
        catch (error) {
            throw new AgentRunError(result!, error);
        }
        if (result!.error)
            throw new AgentRunError(result!, result!.error);
        return result!;
    }
    private failedTool(call: Message["toolCalls"][number], error: unknown, runId: string, stepId: string): ToolOutcome {
        const message = Message.tool(call.toolCallId, { error: errorOf(error).message }, call.name);
        const record = error instanceof ToolExecutionError ? { ...error.record, resultMessageId: message.id } : { id: id("execution"), runId, stepId, toolCallId: call.toolCallId, name: call.name, arguments: {}, status: "failed" as const, resultMessageId: message.id, error: errorOf(error).message };
        return { message, record };
    }
}
