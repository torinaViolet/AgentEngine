export interface ResolvedMedia {
    base64: string;
    mimeType: string;
}
/** Resolve an attachment only when a protocol needs its encoded content. */
export interface MediaResolver {
    resolve(url: string): Promise<ResolvedMedia>;
}
