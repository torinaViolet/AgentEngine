import { assert } from "../core/data";
import type { ToolCallPart } from "../message";
import { IncompleteStreamError, ProviderStreamError } from "./Provider";
import type { HttpProviderOptions } from "./Provider";

export type ChatProtocol = "openai" | "responses" | "anthropic" | "gemini";

/** Native HTTP response validation; legacy parser finish() only assembles the available snapshot. */
export function assertNoResponseError(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const event = value as Record<string, any>;
    const error = event.error ?? (event.type === "response.failed" ? event.response?.error ?? event : event.type === "error" ? event : undefined);
    if (error !== undefined && error !== null) throw new ProviderStreamError(error);
}

export class StreamCompletion {
    private completed = false;
    private receivedResponse = false;
    private receivedDone = false;
    constructor(private protocol: ChatProtocol, private policy: HttpProviderOptions["streamCompletion"] = "strict") {}
    feed(value: unknown): void {
        assertNoResponseError(value);
        const event = value as any;
        if (this.protocol === "openai") {
            const choice = event?.choices?.[0];
            const reason = choice?.finish_reason;
            this.completed ||= typeof reason === "string" && reason.length > 0;
            const delta = choice?.delta;
            this.receivedResponse ||= delta?.role === "assistant" || typeof delta?.content === "string"
                || typeof delta?.reasoning_content === "string" || typeof delta?.thinking === "string"
                || Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
        } else if (this.protocol === "gemini") {
            const reason = event?.candidates?.[0]?.finishReason;
            this.completed ||= typeof reason === "string" && reason.length > 0;
        } else if (this.protocol === "anthropic") {
            this.completed ||= event?.type === "message_stop";
        } else {
            this.completed ||= event?.type === "response.completed" || event?.type === "response.incomplete";
        }
    }
    done(): void { this.receivedDone = true; }
    finish(toolCalls: readonly ToolCallPart[] = []): void {
        if (this.completed) return;
        if (this.protocol !== "openai" || this.policy !== "compatible" || !this.receivedDone || !this.receivedResponse)
            throw new IncompleteStreamError(this.protocol);
        // DONE supplies no model stop reason. Do not infer one or execute structurally unfinished calls.
        for (const call of toolCalls) {
            assert(typeof call.toolCallId === "string" && call.toolCallId.trim() && typeof call.name === "string" && call.name.trim(), "Incomplete OpenAI tool call: missing ID or name");
            let args: unknown;
            try { args = JSON.parse(call.arguments); }
            catch { throw new Error("Incomplete OpenAI tool call: arguments must be valid JSON"); }
            assert(args && typeof args === "object" && !Array.isArray(args), "Invalid OpenAI tool call: arguments must be a JSON object");
        }
    }
}
