import { Message } from "../message/Message";
import { MessagePart } from "../message/MessagePart";
import { Role } from "../message/Role";
import { generateId } from "../utils";
import { AgentSession } from "./AgentSession";

export interface ListCandidate {
  id: string;
  /** A plain reply has one message; tool replies retain the entire execution trace. */
  messages: Message[];
  messageIds: string[];
  context: string;
}
export interface ListRow {
  id: string;
  selectedCandidateId: string;
  candidates: ListCandidate[];
}
function messageData(message: Message): Record<string, unknown> {
  return JSON.parse(JSON.stringify({role: message.role, parts: message.parts,
    metadata: message.metadata, tags: [...message.tags], model: message.model,
    usage: message.usage?.toJSON()}));
}
// Compact deterministic prefix fingerprint; stores no duplicate history or attachments.
function fingerprint(text: string): string {
  let a=2166136261, b=0x9e3779b9;
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,2246822519);}
  return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
function readMessage(value: unknown): Message {
  if (!value || typeof value !== 'object') throw new Error('Invalid message');
  const data = value as Record<string, unknown>;
  if (!Object.values(Role).includes(data.role as Role) || !Array.isArray(data.parts) || data.children)
    throw new Error('Invalid list message');
  return Message.fromJSON(JSON.parse(JSON.stringify(data)));
}

/** Linear rows of alternatives. Changing a selection never creates a tree or erases later rows. */
export class ListSession implements AgentSession {
  readonly id: string;
  readonly createdAt: Date;
  title?: string;
  private readonly system: Message;
  private items: ListRow[] = [];
  private generating = false;
  private target: number | null = null;
  private active: ListCandidate | null = null;
  private pendingTarget: number | null = null;

  private constructor(system: Message, id = generateId(), createdAt = new Date()) {
    this.system = system; this.id = id; this.createdAt = createdAt;
  }
  static create(systemPrompt = ''): ListSession {
    return new ListSession(Message.system(systemPrompt));
  }
  get rows(): readonly ListRow[] { return this.items; }
  /** Convenient two-dimensional projection; tool candidates expose their final message here. */
  get alternatives(): Message[][] {
    return this.items.map(row => row.candidates.map(candidate => candidate.messages.at(-1)!));
  }
  get cursor(): Message { return this.history().at(-1)!; }
  get messages(): Message[] { return this.history(); }
  get systemPrompt(): string { return this.system.text; }
  set systemPrompt(value: string) {
    this.assertIdle(); this.system.parts.splice(0, this.system.parts.length, {type:'text', text:value});
    this.system.invalidateCache();
  }
  private selected(row: ListRow): ListCandidate {
    const result = row.candidates.find(candidate => candidate.id === row.selectedCandidateId);
    if (!result) throw new Error('Invalid selected candidate');
    return result;
  }
  private keys(end = this.items.length): string[] {
    let key = fingerprint(JSON.stringify(messageData(this.system)));
    const keys = [key];
    for (const row of this.items.slice(0,end)) {
      const candidate=this.selected(row);
      key=fingerprint(JSON.stringify([key,row.id,candidate.id,candidate.messages.map(messageData)]));
      keys.push(key);
    }
    return keys;
  }
  private key(end: number): string { return this.keys(end)[end]; }
  get staleRowIds(): string[] {
    const keys=this.keys();
    return this.items.filter((row,index)=>this.selected(row).context!==keys[index]).map(row=>row.id);
  }
  /** Explicit acceptance of retained downstream content after changing an earlier alternative. */
  acceptHistory(): void {
    this.assertIdle();
    const keys=this.keys();
    for (let i=0;i<this.items.length;i++) this.selected(this.items[i]).context = keys[i];
  }
  private assertIdle(): void { if (this.generating) throw new Error('Session is generating'); }
  private rowIndex(id: string): number {
    const index = this.items.findIndex(row => row.id === id);
    if (index < 0) throw new Error('Unknown row');
    return index;
  }
  history(includeRoot = true): Message[] {
    const end = this.generating ? this.target : this.pendingTarget;
    const rows = end === null ? this.items : this.items.slice(0,end);
    const messages = rows.flatMap(row => this.selected(row).messages);
    if (this.generating && this.active) messages.push(...this.active.messages);
    return includeRoot ? [this.system, ...messages] : messages;
  }
  select(rowId: string, candidateId: string): void {
    this.assertIdle(); this.pendingTarget = null;
    const row = this.items[this.rowIndex(rowId)];
    if (!row.candidates.some(candidate => candidate.id === candidateId)) throw new Error('Unknown candidate');
    row.selectedCandidateId = candidateId;
  }
  /** Next Agent.generate() creates an alternative here, using only preceding rows as context. */
  regenerate(rowId: string): void {
    this.assertIdle();
    const index = this.rowIndex(rowId);
    if (this.selected(this.items[index]).messages[0].role !== Role.Assistant)
      throw new Error('Only assistant rows can be regenerated');
    this.pendingTarget = index;
  }
  cancelRegeneration(): void { this.assertIdle(); this.pendingTarget = null; }
  truncateAfter(rowId: string | null): void {
    this.assertIdle(); this.pendingTarget = null;
    this.items.splice(rowId === null ? 0 : this.rowIndex(rowId)+1);
  }
  removeCandidate(rowId: string, candidateId: string): void {
    this.assertIdle(); this.pendingTarget = null;
    const row = this.items[this.rowIndex(rowId)];
    const index = row.candidates.findIndex(candidate => candidate.id === candidateId);
    if (index < 0 || row.candidates.length === 1) throw new Error('Cannot remove candidate');
    row.candidates.splice(index,1);
    if (row.selectedCandidateId === candidateId) row.selectedCandidateId = row.candidates[Math.min(index,row.candidates.length-1)].id;
  }
  addCandidate(rowId: string, message: Message | Message[]): ListCandidate {
    this.assertIdle(); this.pendingTarget = null;
    const index = this.rowIndex(rowId);
    const messages = Array.isArray(message) ? message : [message];
    if (!messages.length) throw new Error('Empty candidate');
    if (messages[0].role !== this.selected(this.items[index]).messages[0].role) throw new Error('Candidate role mismatch');
    const candidate = this.makeCandidate(messages,index);
    this.items[index].candidates.push(candidate);
    this.items[index].selectedCandidateId = candidate.id;
    return candidate;
  }
  private makeCandidate(messages: Message[], index: number): ListCandidate {
    // Do not mutate parent/children on messages belonging to an existing tree.
    const copies = messages.map(message => readMessage(messageData(message)));
    return {id:generateId(),messages:copies,messageIds:copies.map(()=>generateId()),context:this.key(index)};
  }
  addUser(content: string | MessagePart | MessagePart[]): Message { return this.addMessage(Message.user(content)); }
  addMessage(message: Message): Message {
    this.assertIdle();
    if (this.pendingTarget !== null) throw new Error('Regeneration requires generate(), not run()');
    if (this.staleRowIds.length) throw new Error('History changed: regenerate, truncate, or explicitly acceptHistory()');
    const candidate = this.makeCandidate([message],this.items.length);
    this.items.push({id:generateId(),selectedCandidateId:candidate.id,candidates:[candidate]});
    return candidate.messages[0];
  }
  addAssistant(message: Message): Message {
    if (!this.generating) return this.addMessage(message);
    this.appendGenerated(message); return message;
  }
  addTool(messages: Message[]): void {
    if (!this.generating) throw new Error('Tool results require a generation');
    for (const message of messages) this.appendGenerated(message);
  }
  private appendGenerated(message: Message): void {
    const index = this.target!;
    if (!this.active) {
      this.active = {id:generateId(),messages:[],messageIds:[],context:this.key(index)};
      if (index === this.items.length) this.items.push({id:generateId(),selectedCandidateId:this.active.id,candidates:[]});
      this.items[index].candidates.push(this.active);
      this.items[index].selectedCandidateId = this.active.id;
    }
    // Agent owns generated messages; retain their identity for partial/commit hooks, without linking trees.
    this.active.messages.push(message); this.active.messageIds.push(generateId());
  }
  beginGeneration(): void {
    this.assertIdle();
    const target = this.pendingTarget ?? this.items.length;
    if (this.staleRowIds.some(id => this.rowIndex(id)<target)) {
      this.pendingTarget=null;
      throw new Error('History changed: explicitly accept or regenerate earlier rows first');
    }
    this.target=target; this.pendingTarget=null; this.active=null; this.generating=true;
  }
  endGeneration(): void { this.generating=false; this.target=null; this.active=null; }
  clear(): void { this.assertIdle(); this.items=[]; this.pendingTarget=null; this.systemPrompt=''; }
  toJSON(): Record<string,unknown> {
    return {format:'agent-engine-list-session',version:1,id:this.id,title:this.title,createdAt:this.createdAt.toISOString(),
      system:messageData(this.system), rows:this.items.map(row=>({...row,candidates:row.candidates.map(candidate=>({
        ...candidate,messages:candidate.messages.map(messageData)}))}))};
  }
  static fromJSON(value: Record<string,unknown>): ListSession {
    if (value.format !== 'agent-engine-list-session' || value.version !== 1 || !Array.isArray(value.rows))
      throw new Error('Unsupported ListSession format');
    const ids = new Set<string>();
    const id = (value:unknown):string => {
      if(typeof value!=='string'||!value||ids.has(value)) throw new Error('Invalid or duplicate identity');
      ids.add(value);return value;
    };
    const date = new Date(value.createdAt as string);
    if(!Number.isFinite(date.getTime())) throw new Error('Invalid creation date');
    const session = new ListSession(readMessage(value.system),id(value.id),date);
    if(session.system.role!==Role.System) throw new Error('Invalid system message');
    session.title = typeof value.title==='string' ? value.title : undefined;
    session.items = value.rows.map((row:any)=>{
      if(!row||!Array.isArray(row.candidates)||!row.candidates.length) throw new Error('Empty row');
      const rowId=id(row.id);
      const candidates:ListCandidate[]=row.candidates.map((candidate:any)=>{
        if(!candidate||!Array.isArray(candidate.messages)||!candidate.messages.length||
          !Array.isArray(candidate.messageIds)||candidate.messageIds.length!==candidate.messages.length||typeof candidate.context!=='string')
          throw new Error('Invalid candidate');
        return {id:id(candidate.id),messages:candidate.messages.map(readMessage),messageIds:candidate.messageIds.map(id),context:candidate.context};
      });
      if(!candidates.some(candidate=>candidate.id===row.selectedCandidateId)) throw new Error('Invalid selection');
      if(candidates.some(candidate=>candidate.messages[0].role!==candidates[0].messages[0].role)) throw new Error('Candidate role mismatch');
      return {id:rowId,selectedCandidateId:row.selectedCandidateId,candidates};
    });
    return session;
  }
}
