/** JSON-shaped values are copied at module boundaries, never shared with callers. */
export function copy<T>(value: T): T {
    return structuredClone(value);
}
export function immutable<T>(value: T, seen = new WeakSet<object>()): T {
    if (value && typeof value === "object" && !Object.isFrozen(value) && !seen.has(value)) {
        seen.add(value);
        for (const child of Object.values(value))
            immutable(child, seen);
        Object.freeze(value);
    }
    return value;
}
/** Optional fields may be undefined; persisted content must otherwise be JSON data. */
export function assertJson(value: unknown, ancestors = new Set<object>()): void {
    if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number") {
        assert(Number.isFinite(value), "Non-finite JSON number");
        return;
    }
    assert(typeof value === "object", "Content must contain JSON data");
    const prototype = Object.getPrototypeOf(value);
    assert(Array.isArray(value) || prototype === null || (Object.getPrototypeOf(prototype) === null && prototype.constructor?.name === "Object"), "Content must contain JSON data");
    assert(!ancestors.has(value), "Cyclic content cannot be persisted");
    ancestors.add(value);
    for (const child of Object.values(value))
        assertJson(child, ancestors);
    ancestors.delete(value);
}
export function id(prefix: string): string {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
export function assert(condition: unknown, message: string): asserts condition {
    if (!condition)
        throw new Error(message);
}
export function errorOf(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
export async function abortable<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted)
        return await Promise.race([Promise.resolve(work), Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))]);
    if (!signal)
        return await work;
    return new Promise<T>((resolve, reject) => {
        const aborted = () => {
            cleanup();
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        const cleanup = () => signal.removeEventListener("abort", aborted);
        signal.addEventListener("abort", aborted, { once: true });
        Promise.resolve(work).then(value => {
            cleanup();
            resolve(value);
        }, error => {
            cleanup();
            reject(error);
        });
    });
}
export class Events<E extends {
    type: string;
}> {
    private handlers = new Map<string, Set<(event: E) => unknown>>();
    on(type: E["type"] | "*", handler: (event: E) => unknown): () => void {
        const handlers = this.handlers.get(type) ?? new Set();
        handlers.add(handler);
        this.handlers.set(type, handlers);
        return () => handlers.delete(handler);
    }
    async emit(event: E): Promise<void> {
        for (const handler of [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])])
            await handler(event);
    }
}
