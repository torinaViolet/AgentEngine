import type { SessionData, AgentSessionData } from "./types";
import { ListSession } from './ListSession';
export class AgentSession extends ListSession {
    readonly type = "agent" as const;
    constructor(options: {
        systemPrompt?: string;
        id?: string;
    } = {}) {
        super({ ...options, candidateUnit: "turn" });
    }
    static create(options: {
        systemPrompt?: string;
    } = {}): AgentSession {
        return new AgentSession(options);
    }
    get turns() {
        return this.query.turns();
    }
    toJSON(): AgentSessionData { return super.toJSON() as AgentSessionData; }
    static fromJSON(data: SessionData): AgentSession {
        const session = new AgentSession({ id: data.id });
        session.load(data);
        return session;
    }
}
