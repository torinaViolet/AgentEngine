import type { ImagePart, AudioPart, VideoPart, FilePart } from "../message";
import type { ChatProvider } from "./Provider";

export type MediaKind = "image" | "audio" | "video";
export type MediaSource = { type: "url"; url: string } | { type: "bytes"; bytes: Uint8Array } | { type: "base64"; base64: string };
export interface MediaArtifact<K extends MediaKind = MediaKind> {
    kind: K;
    mimeType: string;
    source: MediaSource;
    metadata?: Record<string, unknown>;
}
export interface MediaGenerationRequest<P extends Record<string, unknown> = Record<string, unknown>> {
    model: string;
    /** For speech synthesis this is the text to speak. */
    prompt: string;
    inputs?: readonly (ImagePart | AudioPart | VideoPart | FilePart)[];
    /** Media-specific parameters, independent of chat GenerationConfig. */
    parameters?: P;
}
export type ImageGenerationRequest<P extends Record<string, unknown> = Record<string, unknown>> = MediaGenerationRequest<P>;
export type AudioGenerationRequest<P extends Record<string, unknown> = Record<string, unknown>> = MediaGenerationRequest<P>;
export type VideoGenerationRequest<P extends Record<string, unknown> = Record<string, unknown>> = MediaGenerationRequest<P>;
export interface MediaGenerationResult<K extends MediaKind = MediaKind> {
    artifacts: MediaArtifact<K>[];
    model?: string;
    usage?: Record<string, number>;
    metadata?: Record<string, unknown>;
}
export type ImageGenerationResult = MediaGenerationResult<"image">;
export type AudioGenerationResult = MediaGenerationResult<"audio">;
export type MediaEvent = { type: "mediaPreview"; artifact: MediaArtifact }
    | { type: "mediaChunk"; kind: MediaKind; bytes: Uint8Array; mimeType: string; index: number }
    | { type: "mediaProgress"; status: "queued" | "running" | "receiving"; taskId?: string; progress?: number };
export interface MediaCallOptions {
    signal?: AbortSignal;
    stream?: boolean;
    onEvent?: (event: MediaEvent) => void | Promise<void>;
}
export interface ImageProvider<P extends Record<string, unknown> = Record<string, unknown>> {
    generateImages(request: ImageGenerationRequest<P>, options?: MediaCallOptions): Promise<ImageGenerationResult>;
}
export interface AudioProvider<P extends Record<string, unknown> = Record<string, unknown>> {
    generateAudio(request: AudioGenerationRequest<P>, options?: MediaCallOptions): Promise<AudioGenerationResult>;
}
/** Plain task data. Save its ID before polling; cancellation of local waiting is not remote cancellation. */
export interface VideoTask {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    model?: string;
    artifacts?: MediaArtifact<"video">[];
    error?: string;
    metadata?: Record<string, unknown>;
}
export interface VideoProvider<P extends Record<string, unknown> = Record<string, unknown>> {
    createVideo(request: VideoGenerationRequest<P>, options?: MediaCallOptions): Promise<VideoTask>;
    getVideoTask(taskId: string, options?: MediaCallOptions): Promise<VideoTask>;
    cancelVideoTask?(taskId: string, options?: MediaCallOptions): Promise<VideoTask | void>;
}
export interface EmbeddingRequest {
    model: string;
    input: string | readonly string[];
    dimensions?: number;
    providerOptions?: Record<string, unknown>;
}
export interface EmbeddingResult {
    embeddings: { index: number; vector: number[] }[];
    model?: string;
    usage?: { inputTokens: number; totalTokens: number };
}
export interface EmbeddingProvider { embed(request: EmbeddingRequest, options?: { signal?: AbortSignal }): Promise<EmbeddingResult>; }
export type ProviderCapability = "chat" | "image" | "audio" | "video" | "embedding";
export function supportsCapability(provider: unknown, capability: "chat"): provider is ChatProvider;
export function supportsCapability(provider: unknown, capability: "image"): provider is ImageProvider;
export function supportsCapability(provider: unknown, capability: "audio"): provider is AudioProvider;
export function supportsCapability(provider: unknown, capability: "video"): provider is VideoProvider;
export function supportsCapability(provider: unknown, capability: "embedding"): provider is EmbeddingProvider;
export function supportsCapability(provider: unknown, capability: ProviderCapability): boolean;
export function supportsCapability(provider: unknown, capability: ProviderCapability): boolean {
    if (!provider || typeof provider !== "object") return false;
    const methods = { chat: ["generate"], image: ["generateImages"], audio: ["generateAudio"], video: ["createVideo", "getVideoTask"], embedding: ["embed"] }[capability];
    return !!methods && methods.every(method => typeof (provider as Record<string, unknown>)[method] === "function");
}
