import type { Message } from "../message";
import type { ExecutionTrace } from "./trace";
import type { QueryScope, MessageCriteria } from "./types";
export interface SessionQuerySource {
    history(): Message[];
    allMessages(): Message[];
    readonly trace: ExecutionTrace;
}
export class SessionQuery {
    constructor(private session: SessionQuerySource) {
    }
    messages(criteria: MessageCriteria = {}): Message[] {
        const records = this.session.trace.records;
        const turns = records.turns.filter(t => !criteria.turnId || t.id === criteria.turnId);
        const runs = records.runs.filter(r => (!criteria.runId || r.id === criteria.runId) && (!criteria.turnId || r.turnId === criteria.turnId));
        const contributions = records.contributions.filter(c => runs.some(r => r.id === c.runId) && (!criteria.stepId || c.stepId === criteria.stepId));
        const toolIds = records.tools.filter(t => runs.some(r => r.id === t.runId) && (!criteria.stepId || t.stepId === criteria.stepId)).map(t => t.resultMessageId);
        const source = criteria.scope === "all" ? this.session.allMessages() : this.session.history();
        return source.filter(message => {
            if (criteria.id && message.id !== criteria.id)
                return false;
            if (criteria.role && message.role !== criteria.role)
                return false;
            if (criteria.tags && !criteria.tags.every(t => message.hasTag(t)))
                return false;
            if (criteria.content instanceof RegExp) {
                const regex = new RegExp(criteria.content.source, criteria.content.flags);
                if (!regex.test(message.text))
                    return false;
            }
            else if (criteria.content && !message.text.includes(criteria.content))
                return false;
            if (criteria.partType && !message.parts.some(p => p.type === criteria.partType))
                return false;
            if (criteria.metadata && !Object.entries(criteria.metadata).every(([k, v]) => JSON.stringify(message.metadata[k]) === JSON.stringify(v)))
                return false;
            if ((criteria.turnId || criteria.runId || criteria.stepId) && !contributions.some(c => c.messageId === message.id) && !toolIds.includes(message.id) && !(criteria.turnId && !criteria.runId && !criteria.stepId && turns.some(t => t.inputMessageIds.includes(message.id))))
                return false;
            if (criteria.toolCallId && !message.parts.some(p => (p.type === "tool_call" || p.type === "tool_result") && p.toolCallId === criteria.toolCallId))
                return false;
            return criteria.predicate?.(message) ?? true;
        }).slice(criteria.offset ?? 0, criteria.limit === undefined ? undefined : (criteria.offset ?? 0) + criteria.limit);
    }
    private activeRuns(scope?: QueryScope): Set<string> {
        if (scope === "all")
            return new Set(this.session.trace.records.runs.map(r => r.id));
        const active = new Set(this.session.history().map(m => m.id));
        const trace = this.session.trace.records;
        return new Set(trace.runs.filter(r => trace.contributions.some(c => c.runId === r.id && active.has(c.messageId)) || !trace.contributions.some(c => c.runId === r.id) && trace.turns.some(t => t.id === r.turnId && t.inputMessageIds.some(m => active.has(m)))).map(r => r.id));
    }
    turns(options: {
        scope?: QueryScope;
    } = {}) {
        const ids = new Set(this.session.history().map(m => m.id));
        const runs = this.activeRuns(options.scope);
        return this.session.trace.records.turns.filter(t => options.scope === "all" || t.inputMessageIds.some(m => ids.has(m)) || this.session.trace.records.runs.some(r => r.turnId === t.id && runs.has(r.id)));
    }
    runs(options: {
        turnId?: string;
        scope?: QueryScope;
    } = {}) {
        const active = this.activeRuns(options.scope);
        return this.session.trace.records.runs.filter(r => active.has(r.id) && (!options.turnId || r.turnId === options.turnId));
    }
    steps(options: {
        runId?: string;
        scope?: QueryScope;
    } = {}) {
        const active = this.activeRuns(options.scope);
        return this.session.trace.records.steps.filter(s => active.has(s.runId) && (!options.runId || s.runId === options.runId));
    }
    toolExecutions(options: {
        runId?: string;
        status?: string;
        scope?: QueryScope;
    } = {}) {
        const active = this.activeRuns(options.scope);
        return this.session.trace.records.tools.filter(t => (options.scope === "all" || !!t.runId && active.has(t.runId)) && (!options.runId || t.runId === options.runId) && (!options.status || t.status === options.status));
    }
}
