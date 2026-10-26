import { assert, copy, id, immutable } from "../core/data";
import { Message } from "../message";
import type { SessionData, TreeSessionData } from "./types";
import type { TreeNode, TreeStructure } from "./structures";
import { BaseSession } from './BaseSession';
export class TreeSession extends BaseSession {
    readonly type = "tree" as const;
    private tree = new Map<string, TreeNode>();
    private selected: string | null = null;
    private roots: string[] = [];
    static create(systemPrompt = ""): TreeSession {
        return new TreeSession(systemPrompt);
    }
    get cursorNodeId(): string | null {
        return this.selected;
    }
    get rootNodeIds(): readonly string[] { return immutable([...this.roots]); }
    get nodes(): readonly TreeNode[] {
        return immutable(copy([...this.tree.values()]));
    }
    history(): Message[] {
        const path: Message[] = [];
        for (let node = this.selected ? this.tree.get(this.selected) : undefined; node; node = node.parentId ? this.tree.get(node.parentId) : undefined)
            path.push(this.messages.get(node.messageId)!);
        return [this.system, ...path.reverse()];
    }
    protected append(message: Message): Message {
        this.register(message);
        const node: TreeNode = { id: id("node"), messageId: message.id, parentId: this.selected, children: [] };
        if (this.selected)
            this.tree.get(this.selected)!.children.push(node.id);
        else this.roots.push(node.id);
        this.tree.set(node.id, node);
        this.selected = node.id;
        this.structureVersion++;
        return message;
    }
    addMessage(message: Message): Message {
        this.input(message);
        return this.append(message);
    }
    select(nodeId: string | null): void {
        assert(nodeId === null || this.tree.has(nodeId), "Unknown tree node");
        this.selected = nodeId;
        this.structureVersion++;
        this.refreshTurn();
    }
    nodeFor(messageId: string): TreeNode | undefined {
        return copy([...this.tree.values()].find(n => n.messageId === messageId));
    }
    remove(nodeId: string, mode: "prune" | "graft" = "prune"): void {
        const node = this.tree.get(nodeId);
        assert(node, "Unknown tree node");
        const removed = new Set<string>([nodeId]);
        if (mode === "prune") {
            const pending = [...node.children];
            while (pending.length) {
                const key = pending.pop()!;
                removed.add(key);
                pending.push(...this.tree.get(key)!.children);
            }
        }
        if (node.parentId) {
            const parent = this.tree.get(node.parentId)!;
            const index = parent.children.indexOf(nodeId);
            parent.children.splice(index, 1, ...(mode === "graft" ? node.children : []));
        }
        else { const index = this.roots.indexOf(nodeId); this.roots.splice(index, 1, ...(mode === "graft" ? node.children : [])); }
        if (mode === "graft")
            for (const child of node.children)
                this.tree.get(child)!.parentId = node.parentId;
        if (this.selected && removed.has(this.selected))
            this.selected = node.parentId;
        for (const key of removed) {
            const messageId = this.tree.get(key)!.messageId;
            this.tree.delete(key);
            if (![...this.tree.values()].some(n => n.messageId === messageId))
                this.unregister(messageId);
        }
        this.structureVersion++;
        this.refreshTurn();
    }
    protected structure(): TreeStructure {
        return { nodes: [...this.tree.values()], roots: [...this.roots], cursor: this.selected };
    }
    toJSON(): TreeSessionData { return super.toJSON() as TreeSessionData; }
    static fromJSON(data: SessionData): TreeSession {
        const session = new TreeSession("", data.id);
        session.restore(data);
        const structure = data.structure as TreeStructure;
        assert(structure && Array.isArray(structure.nodes), "Invalid tree structure");
        for (const node of structure.nodes) {
            assert(typeof node.id === "string" && node.id && !session.tree.has(node.id) && session.messages.has(node.messageId) && node.messageId !== data.systemMessageId && (node.parentId === null || typeof node.parentId === "string") && Array.isArray(node.children) && node.children.every(key => typeof key === "string" && key), "Invalid tree node");
            session.tree.set(node.id, copy(node));
        }
        const roots = structure.nodes.filter(n => n.parentId === null).map(n => n.id);
        const rootSet = new Set(roots);
        session.roots = copy(structure.roots ?? roots);
        assert(Array.isArray(session.roots) && session.roots.length === roots.length && new Set(session.roots).size === roots.length && session.roots.every(key => rootSet.has(key)), "Invalid root node order");
        const visited = new Set<string>();
        const pending = [...session.roots];
        while (pending.length) {
            const key = pending.pop()!;
            assert(!visited.has(key), "Cyclic or duplicate tree edge");
            visited.add(key);
            const node = session.tree.get(key)!;
            for (const child of node.children) {
                assert(session.tree.get(child)?.parentId === key, "Invalid tree parent reference");
                pending.push(child);
            }
        }
        assert(visited.size === session.tree.size, "Unreachable tree nodes");
        session.select(structure.cursor);
        return session;
    }
}
