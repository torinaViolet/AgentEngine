import { Message } from "../message/Message";

/** The conversation operations required by Agent. Tree-specific APIs remain on Session. */
export interface AgentSession {
  readonly cursor: Message;
  history(includeRoot?: boolean): Message[];
  addMessage(message: Message): Message;
  addAssistant(message: Message): Message;
  addTool(messages: Message[]): void;
  /** Optional execution boundary: a tool loop belongs to one reply candidate. */
  beginGeneration?(): void;
  endGeneration?(): void;
}
