/** IDs are nonempty strings, unique within their own table; UUIDs are not required. */
export interface TreeNode { id: string; messageId: string; parentId: string | null; children: string[]; }
export interface TreeStructure {
    nodes: TreeNode[];
    /** Ordered root nodes. Older 3.0 snapshots may omit it; node table order then supplies it. */
    roots?: string[];
    cursor: string | null;
}
export interface ListCandidate { id: string; messageIds: string[]; turnId?: string; context: string; }
export interface ListRow { id: string; selectedCandidateId: string; candidates: ListCandidate[]; }
export interface ListStructure { candidateUnit: "sequence" | "turn"; rows: ListRow[]; }
export interface AgentStructure extends ListStructure { candidateUnit: "turn"; }
