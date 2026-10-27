import { abortable, assert, copy, errorOf, Events, id } from "../core/data";
import { Message, ToolCallPart } from "../message";
import type { ToolExecutionRecord } from "../session/trace";
import { Tool, ToolArgumentsError, ToolContext } from './Tool';
import { ToolKit } from './ToolKit';
export class ToolExecutionError extends Error {
    readonly code = "TOOL_EXECUTION";
    constructor(message: string, readonly record: ToolExecutionRecord, readonly cause?: unknown) {
        super(message);
        this.name = "ToolExecutionError";
    }
}
export interface ApprovalRequest {
    approvalId: string;
    toolExecutionId: string;
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    runId?: string;
    stepId?: string;
}
export type ApprovalDecision = "allow" | "deny" | "ask" | {
    action: "allow" | "deny" | "ask";
    reason?: string;
};
export interface ToolExecutorOptions {
    toolkit: ToolKit;
    approval?: "auto" | "manual" | ((request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>);
    approvalTimeoutMs?: number;
    errorPolicy?: "return" | "throw";
}
export type ToolEvent = {
    type: "approvalRequired";
    request: ApprovalRequest;
} | {
    type: "toolUpdated";
    record: ToolExecutionRecord;
};
export interface ToolOutcome {
    message: Message;
    record: ToolExecutionRecord;
}
export class ToolExecutor {
    readonly toolkit: ToolKit;
    private events = new Events<ToolEvent>();
    private pending = new Map<string, {
        request: ApprovalRequest;
        resolve: (decision: {
            approved: boolean;
            reason?: string;
        }) => void;
    }>();
    constructor(private options: ToolExecutorOptions) {
        this.toolkit = options.toolkit;
    }
    on(type: ToolEvent["type"] | "*", handler: (event: ToolEvent) => unknown): () => void {
        return this.events.on(type, handler);
    }
    get pendingApprovals(): ApprovalRequest[] {
        return copy([...this.pending.values()].map(item => item.request));
    }
    approve(approvalId: string): boolean {
        const pending = this.pending.get(approvalId);
        if (!pending)
            return false;
        pending.resolve({ approved: true });
        return true;
    }
    reject(approvalId: string, reason = "Rejected by user"): boolean {
        const pending = this.pending.get(approvalId);
        if (!pending)
            return false;
        pending.resolve({ approved: false, reason });
        return true;
    }
    async execute(call: ToolCallPart, context: {
        signal?: AbortSignal;
        runId?: string;
        stepId?: string;
        onRecord?: (record: ToolExecutionRecord) => void | Promise<void>;
        errorPolicy?: "return" | "throw";
        /** Synchronous ownership/precondition check at the actual execution boundary. */
        assertCanExecute?: () => void;
    } = {}): Promise<ToolOutcome> {
        const record: ToolExecutionRecord = { id: id("execution"), name: call.name, toolCallId: call.toolCallId, runId: context.runId, stepId: context.stepId, arguments: {}, status: "running" };
        const update = async () => {
            await context.onRecord?.(copy(record));
            await this.events.emit({ type: "toolUpdated", record: copy(record) });
        };
        try {
            context.signal?.throwIfAborted();
            context.assertCanExecute?.();
            const tool: Tool<any> | undefined = this.toolkit.get(call.name);
            assert(tool && this.toolkit.isEnabled(call.name), `Unavailable tool: ${call.name}`);
            let args: unknown;
            try {
                args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
            }
            catch {
                throw new ToolArgumentsError("Tool arguments are not valid JSON");
            }
            const validated = tool.validate(args);
            record.arguments = copy(validated);
            const request: ApprovalRequest = { approvalId: id("approval"), toolExecutionId: record.id, toolCallId: call.toolCallId, name: call.name, arguments: copy(validated), runId: context.runId, stepId: context.stepId };
            const decision = typeof this.options.approval === "function" ? await abortable(Promise.resolve(this.options.approval(request)), context.signal) : this.options.approval === "manual" || tool.requiresApproval ? "ask" : "allow";
            const action = typeof decision === "string" ? decision : decision.action;
            let accepted: {
                approved: boolean;
                reason?: string;
            } = { approved: action === "allow", reason: typeof decision === "object" ? decision.reason : undefined };
            if (action === "ask") {
                record.status = "awaitingApproval";
                await update();
                accepted = await this.wait(request, context.signal);
            }
            if (!accepted.approved) {
                record.status = "rejected";
                record.error = accepted.reason ?? "Tool execution denied";
                const message = Message.tool(call.toolCallId, { error: record.error, rejected: true }, call.name);
                record.resultMessageId = message.id;
                await update();
                return { message, record: copy(record) };
            }
            context.signal?.throwIfAborted();
            assert(this.toolkit.isEnabled(call.name), `Tool disabled before execution: ${call.name}`);
            record.status = "running";
            await update();
            // Notifications and approval waits may cancel, disable, replace or invalidate the call.
            context.assertCanExecute?.();
            context.signal?.throwIfAborted();
            assert(this.toolkit.isEnabled(call.name), `Tool disabled before execution: ${call.name}`);
            assert(this.toolkit.get(call.name) === tool, `Tool changed before execution: ${call.name}`);
            const toolContext: ToolContext = { signal: context.signal, runId: context.runId, stepId: context.stepId, toolExecutionId: record.id, toolCallId: call.toolCallId, throwIfAborted: () => context.signal?.throwIfAborted() };
            const result = await abortable(Promise.resolve(tool.execute(validated, toolContext)), context.signal);
            const message = Message.tool(call.toolCallId, result, call.name);
            record.status = "completed";
            record.resultMessageId = message.id;
            await update();
            return { message, record: copy(record) };
        }
        catch (error) {
            record.status = context.signal?.aborted ? "interrupted" : "failed";
            record.error = errorOf(error).message;
            const message = Message.tool(call.toolCallId, { error: record.error, interrupted: record.status === "interrupted" }, call.name);
            record.resultMessageId = message.id;
            await update();
            if (context.signal?.aborted)
                throw new ToolExecutionError(record.error, copy(record), error);
            if ((context.errorPolicy ?? this.options.errorPolicy) === "throw")
                throw new ToolExecutionError(record.error, copy(record), error);
            return { message, record: copy(record) };
        }
    }
    private async wait(request: ApprovalRequest, signal?: AbortSignal): Promise<{
        approved: boolean;
        reason?: string;
    }> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const promise = new Promise<{
            approved: boolean;
            reason?: string;
        }>(resolve => {
            this.pending.set(request.approvalId, { request: copy(request), resolve });
            if (this.options.approvalTimeoutMs !== undefined)
                timer = setTimeout(() => resolve({ approved: false, reason: "Approval timed out" }), this.options.approvalTimeoutMs);
        });
        try {
            await this.events.emit({ type: "approvalRequired", request: copy(request) });
            return await abortable(promise, signal);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            this.pending.delete(request.approvalId);
        }
    }
}
