import { assert, copy, id, immutable } from "../core/data";
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}
export type RunStatus = "running" | "completed" | "interrupted" | "failed";
export interface TurnRecord {
    id: string;
    inputMessageIds: string[];
    createdAt: string;
}
export interface RunRecord {
    id: string;
    turnId?: string;
    kind: "chat" | "run" | "continue" | "resume";
    status: RunStatus;
    stopReason?: string;
    targetMessageId?: string;
    resumedFrom?: string;
    createdAt: string;
}
export interface StepRecord {
    id: string;
    runId: string;
    index: number;
    status: RunStatus;
    messageId?: string;
    usage?: TokenUsage;
    finishReason?: string;
    error?: string;
}
export type ToolStatus = "awaitingApproval" | "rejected" | "running" | "completed" | "failed" | "interrupted";
export interface ToolExecutionRecord {
    id: string;
    runId?: string;
    stepId?: string;
    toolCallId: string;
    name: string;
    status: ToolStatus;
    arguments: Record<string, unknown>;
    resultMessageId?: string;
    error?: string;
}
export interface Contribution {
    messageId: string;
    revision: number;
    runId: string;
    stepId: string;
    operation: "create" | "append" | "replace";
}
export interface TraceData {
    turns: TurnRecord[];
    runs: RunRecord[];
    steps: StepRecord[];
    tools: ToolExecutionRecord[];
    contributions: Contribution[];
}
export class ExecutionTrace {
    private data: TraceData = { turns: [], runs: [], steps: [], tools: [], contributions: [] };
    get records(): Readonly<TraceData> {
        return immutable(copy(this.data));
    }
    turn(inputs: string[]): TurnRecord {
        const record = { id: id("turn"), inputMessageIds: [...inputs], createdAt: new Date().toISOString() };
        this.data.turns.push(record);
        return copy(record);
    }
    run(kind: RunRecord["kind"], turnId?: string, targetMessageId?: string, resumedFrom?: string): RunRecord {
        const record: RunRecord = { id: id("run"), kind, turnId, targetMessageId, resumedFrom, status: "running", createdAt: new Date().toISOString() };
        this.data.runs.push(record);
        return copy(record);
    }
    step(runId: string): StepRecord {
        const record: StepRecord = { id: id("step"), runId, index: this.data.steps.filter(s => s.runId === runId).length, status: "running" };
        this.data.steps.push(record);
        return copy(record);
    }
    updateRun(runId: string, patch: Partial<Omit<RunRecord, "id">>): void {
        const record = this.data.runs.find(r => r.id === runId);
        assert(record, "Unknown run");
        Object.assign(record, copy(patch));
    }
    updateStep(stepId: string, patch: Partial<Omit<StepRecord, "id">>): void {
        const record = this.data.steps.find(s => s.id === stepId);
        assert(record, "Unknown step");
        Object.assign(record, copy(patch));
    }
    tool(record: ToolExecutionRecord): void {
        const index = this.data.tools.findIndex(t => t.id === record.id);
        if (index < 0)
            this.data.tools.push(copy(record));
        else
            this.data.tools[index] = copy(record);
    }
    contribute(record: Contribution): void {
        this.data.contributions.push(copy(record));
    }
    source(messageId: string): Contribution | undefined {
        return copy(this.data.contributions.find(c => c.messageId === messageId));
    }
    usage(runId?: string): TokenUsage {
        return this.data.steps.filter(s => !runId || s.runId === runId).reduce((sum, s) => ({ inputTokens: sum.inputTokens + (s.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + (s.usage?.outputTokens ?? 0), totalTokens: sum.totalTokens + (s.usage?.totalTokens ?? 0) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
    toJSON(): TraceData {
        return JSON.parse(JSON.stringify(this.data)) as TraceData;
    }
    static fromJSON(data: TraceData): ExecutionTrace {
        const trace = new ExecutionTrace();
        assert(data && [data.turns, data.runs, data.steps, data.tools, data.contributions].every(Array.isArray), "Invalid execution trace");
        const identifiers = new Set<string>();
        for (const record of [...data.turns, ...data.runs, ...data.steps, ...data.tools]) {
            assert(typeof record.id === "string" && !identifiers.has(record.id), "Duplicate execution identity");
            identifiers.add(record.id);
        }
        const statuses = ["running", "completed", "interrupted", "failed"];
        for (const turn of data.turns)
            assert(Array.isArray(turn.inputMessageIds) && turn.inputMessageIds.every(key => typeof key === "string"), "Invalid turn inputs");
        for (const run of data.runs) {
            assert(statuses.includes(run.status) && ["chat", "run", "continue", "resume"].includes(run.kind), "Invalid run record");
            assert(!run.turnId || data.turns.some(t => t.id === run.turnId), "Unknown turn reference");
            assert(!run.resumedFrom || data.runs.some(r => r.id === run.resumedFrom && r.id !== run.id), "Unknown resumed run");
        }
        for (const step of data.steps) {
            assert(statuses.includes(step.status) && Number.isSafeInteger(step.index) && step.index >= 0, "Invalid model step");
            assert(data.runs.some(r => r.id === step.runId), "Unknown run reference");
            if (step.usage)
                assert([step.usage.inputTokens, step.usage.outputTokens, step.usage.totalTokens].every(value => Number.isFinite(value) && value >= 0), "Invalid token usage");
        }
        for (const tool of data.tools) {
            assert(["awaitingApproval", "rejected", ...statuses].includes(tool.status) && typeof tool.toolCallId === "string" && typeof tool.name === "string" && tool.arguments && typeof tool.arguments === "object", "Invalid tool record");
            assert(!tool.runId || data.runs.some(run => run.id === tool.runId), "Unknown tool run reference");
            assert(!tool.stepId || data.steps.some(s => s.id === tool.stepId && (!tool.runId || s.runId === tool.runId)), "Unknown tool step reference");
        }
        for (const contribution of data.contributions) {
            assert(typeof contribution.messageId === "string" && Number.isSafeInteger(contribution.revision) && contribution.revision >= 0 && ["create", "append", "replace"].includes(contribution.operation), "Invalid message contribution");
            assert(data.steps.some(s => s.id === contribution.stepId && s.runId === contribution.runId), "Unknown contribution reference");
        }
        trace.data = copy(data);
        return trace;
    }
}
