import { assert, copy } from "../core/data";
import { Message, Role, PROTOCOL_METADATA_KEYS, MessagePart } from "../message";

function withSignatures(message: Message): MessagePart[] {
    return copy([...message.parts]).map(part => part.type !== "thinking" ? part : {
        ...part,
        metadata: { ...(message.metadata.thinkingSignature ? { thinkingSignature: message.metadata.thinkingSignature } : {}), ...(message.metadata.geminiThinkingSignature ? { geminiThinkingSignature: message.metadata.geminiThinkingSignature } : {}), ...part.metadata },
    });
}
/** Detached default merge. Tool-related thinking belongs only to the tool-call message. */
export function prepareContinuation(target: Message, generated: Message): { draft: Message; toolMessage?: Message } {
    assert(target.role === Role.Assistant && generated.role === Role.Assistant, "Continuation requires assistant messages");
    const hasCalls = generated.toolCalls.length > 0;
    const generatedParts = withSignatures(generated);
    const transferable = generatedParts.filter(part => part.type !== "tool_call" && !(hasCalls && part.type === "thinking"));
    const metadata = { ...copy(target.metadata) };
    for (const [key, value] of Object.entries(generated.metadata)) {
        if (hasCalls && (PROTOCOL_METADATA_KEYS as readonly string[]).includes(key)) continue;
        Object.defineProperty(metadata, key, { value: copy(value), enumerable: true, configurable: true, writable: true });
    }
    if (!hasCalls && Array.isArray(generated.metadata.openaiReasoningItems)) metadata.openaiReasoningItems = [...(Array.isArray(target.metadata.openaiReasoningItems) ? target.metadata.openaiReasoningItems : []), ...generated.metadata.openaiReasoningItems];
    const draft = target.snapshot().update({ parts: [...withSignatures(target), ...transferable], metadata, tags: [...target.tags, ...generated.tags], requestMetadataKeys: generated.requestMetadataKeys });
    const toolMessage = hasCalls ? new Message(Role.Assistant, generatedParts.filter(part => part.type === "tool_call" || part.type === "thinking"), copy(generated.metadata), { id: generated.id, tags: [...generated.tags], requestMetadataKeys: [...generated.requestMetadataKeys] }) : undefined;
    return { draft, toolMessage };
}
/** Rebase hook edits on fresh business metadata without overwriting unrelated concurrent writes. */
export function rebaseContinuationDraft(current: Message, draft: Message, baseline: Message): Message {
    assert(draft.id === current.id && draft.role === current.role, "Continuation draft must preserve target identity and role");
    const next = current.snapshot();
    if (JSON.stringify(draft.parts) !== JSON.stringify(baseline.parts)) next.setParts(draft.parts);
    for (const key of new Set([...Object.keys(baseline.metadata), ...Object.keys(draft.metadata)])) {
        if (JSON.stringify(draft.metadata[key]) === JSON.stringify(baseline.metadata[key])) continue;
        if (Object.hasOwn(draft.metadata, key)) next.setMeta(key, draft.metadata[key]); else next.deleteMeta(key);
    }
    next.untag(...baseline.tags.filter(tag => !draft.tags.includes(tag))).tag(...draft.tags.filter(tag => !baseline.tags.includes(tag)));
    return next.update({ requestMetadataKeys: draft.requestMetadataKeys });
}
