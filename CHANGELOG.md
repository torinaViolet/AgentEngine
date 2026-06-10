# Changelog

## 1.2.0 - 2026-06-11

### Added

- Low-coupling Provider architecture composed from `ModelClient`, `MessageAdapter`, and `MessageStreamParser`.
- Native presets for OpenAI Responses, Anthropic Messages, and Gemini, alongside OpenAI-compatible Chat Completions.
- Non-streaming Agent requests through `agent.run(..., { stream: false })` and `runRaw()`.
- Complete-response transport support through optional `ModelClient.complete()`.
- Provider capability inspection through `provider.supportsComplete`.
- Native stream parsers for OpenAI Responses, Anthropic, and Gemini.
- Protocol-preserving reasoning and function-call state for multi-turn tool execution.

### Improved

- Tool approval, interruption, recovery, parser errors, and partial-message handling.
- Provider-specific request option mapping, usage parsing, thinking signatures, and multimodal serialization.
- Session and Message mutation consistency, tool error handling, exports, tests, and package subpaths.
- README and API documentation for Provider configuration and streaming modes.

### Compatibility

- Existing OpenAI-compatible `client` initialization remains supported.
- Existing custom `ModelClient` implementations that only provide `stream()` remain valid.
- Streaming remains the default behavior.
