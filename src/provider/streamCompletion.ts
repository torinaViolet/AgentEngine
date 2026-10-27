import { IncompleteStreamError, ProviderStreamError } from "./Provider";

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
    constructor(private protocol: ChatProtocol) {}
    feed(value: unknown): void {
        assertNoResponseError(value);
        const event = value as any;
        if (this.protocol === "openai") {
            const reason = event?.choices?.[0]?.finish_reason;
            this.completed ||= typeof reason === "string" && reason.length > 0;
        } else if (this.protocol === "gemini") {
            const reason = event?.candidates?.[0]?.finishReason;
            this.completed ||= typeof reason === "string" && reason.length > 0;
        } else if (this.protocol === "anthropic") {
            this.completed ||= event?.type === "message_stop";
        } else {
            this.completed ||= event?.type === "response.completed" || event?.type === "response.incomplete";
        }
    }
    finish(): void {
        if (!this.completed) throw new IncompleteStreamError(this.protocol);
    }
}
