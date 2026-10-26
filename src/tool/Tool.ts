import { assert, copy, immutable } from "../core/data";
import type { ToolDefinition } from "../provider";
import Ajv, { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
export interface ToolContext {
    signal?: AbortSignal;
    runId?: string;
    stepId?: string;
    toolExecutionId: string;
    toolCallId: string;
    throwIfAborted(): void;
}
export interface ToolOptions<A extends Record<string, unknown> = Record<string, unknown>> extends ToolDefinition {
    execute: (arguments_: A, context: ToolContext) => unknown | Promise<unknown>;
    requiresApproval?: boolean;
}
export class Tool<A extends Record<string, unknown> = Record<string, unknown>> {
    private validator: ValidateFunction;
    private options: ToolOptions<A>;
    constructor(options: ToolOptions<A>) {
        assert(options.name.trim() && typeof options.execute === "function", "Invalid tool definition");
        this.options = { ...options, parameters: immutable(copy(options.parameters)) };
        const compiler = String(options.parameters.$schema ?? "").includes("2020-12") ? new Ajv2020({ allErrors: true }) : new Ajv({ allErrors: true });
        addFormats(compiler);
        this.validator = compiler.compile(copy(options.parameters));
    }
    static define<A extends Record<string, unknown>>(options: ToolOptions<A>): Tool<A> {
        return new Tool(options);
    }
    get name(): string {
        return this.options.name;
    }
    get requiresApproval(): boolean {
        return this.options.requiresApproval ?? false;
    }
    get definition(): ToolDefinition {
        return copy({ name: this.name, description: this.options.description, parameters: this.options.parameters });
    }
    validate(arguments_: unknown): A {
        if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_) || !this.validator(arguments_))
            throw new ToolArgumentsError(this.validator.errors?.map(error => `${error.instancePath || "/"} ${error.message}`).join("; ") || "Tool arguments must be an object");
        return arguments_ as A;
    }
    execute(arguments_: A, context: ToolContext): unknown | Promise<unknown> {
        return this.options.execute(arguments_, context);
    }
}
export class ToolArgumentsError extends Error {
    readonly code = "TOOL_ARGUMENTS";
    constructor(message: string) {
        super(message);
        this.name = "ToolArgumentsError";
    }
}
