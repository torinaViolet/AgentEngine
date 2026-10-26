import { assert } from "../core/data";
import type { SessionData } from "./types";
import { BaseSession } from './BaseSession';
import { TreeSession } from './TreeSession';
import { ListSession } from './ListSession';
import { AgentSession } from './AgentSession';
export function restoreSession(data: SessionData): BaseSession {
    assert(data && ["tree", "list", "agent"].includes(data.type), "Unknown session type");
    return data.type === "tree" ? TreeSession.fromJSON(data) : data.type === "agent" ? AgentSession.fromJSON(data) : ListSession.fromJSON(data);
}
