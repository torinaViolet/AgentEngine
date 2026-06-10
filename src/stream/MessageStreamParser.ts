import { Message } from "../message/Message";
import { FinishReason, StreamEvent } from "./StreamEvent";

/** Converts provider-native stream chunks into AgentEngine stream events. */
export interface MessageStreamParser {
  feed(chunk: unknown): StreamEvent[];
  finish(): StreamEvent[];
  readonly snapshot: Message;
  readonly finishReason?: FinishReason;
  readonly hasSnapshotContent: boolean;
  reset(): void;
}

export type MessageStreamParserFactory = () => MessageStreamParser;
