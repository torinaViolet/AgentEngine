# Changelog

## 3.0.0 - 2026-10-26

- CE feedback: business Message metadata/tags and Session metadata can change during runs without invalidating request leases; content and protocol edits still conflict. Custom request metadata keys persist alongside separate request revisions.
- Continuation temporary messages now enter PromptBuilder before transforms, with tags/source labels and matching continuation previews. Default merges retain business metadata/tags; awaited beforeAppend hooks edit detached merged targets without overwriting unrelated concurrent annotations.
- Tool-related continuation thinking is stored once with its native signatures; independent thinking blocks remain available for display.
- Version 3 session structures are publicly typed. Flat tree imports preserve external message/node IDs, explicit root/sibling order and selection.
- Prompt transforms can return messages with source descriptors while retaining Message[] compatibility. Transport requests include explicit stream and purpose; Generator/Agent thinking defaults accept per-call overrides.
- Added EmbeddingProvider capability contract for inheritable custom providers; no built-in vendor embedding protocol yet. Added 16 CE feedback regression cases and documented the integration contract in docs/CE-FEEDBACK-3.0.md.
- Provider is now an inheritable HTTP base; ChatProvider remains a structural chat capability. Separate ImageProvider, AudioProvider and VideoProvider contracts support media outputs without requiring chat.
- Shared subclass hooks handle authentication, JSON/multipart/binary requests, GET task queries, SSE and bounded binary reading. Video submission/query/optional remote cancellation are distinct operations.
- VideoPart and Message.addVideo support video persistence in all session types; chat subclasses can extend serializeMessages, while unsupported built-in video input fails explicitly.

- New independent editable Message model with content-block IDs, revisions and flat serialization.
- TreeSession, sequence/turn ListSession, and interaction-based AgentSession share querying and Turn/Run/Step/tool execution records.
- SDK-free HTTP providers for OpenAI compatible, OpenAI Responses, Anthropic and Gemini, with injectable transport/media and SSE cancellation.
- Generator performs a single model request; Agent orchestrates chat/run/continue/resume and contextual tool loops.
- Standalone ToolExecutor validates JSON Schema and handles authorization, manual approval, timeout and cancellation; tool availability is dynamic.
- Independent async PromptBuilder provides detached contexts, source tracking and non-consuming previews.
- Awaited commit hooks, continuation merging, generation contribution/usage tracking, partial progress retention and session edit conflict detection.
- Breaking: root/subpath APIs and session storage format are 3.0. The 2.x implementation remains available through explicit `/legacy` imports; existing demos use this compatibility entry.
- Vendor SDKs are no longer runtime/peer dependencies; Ajv provides tool validation. Browser and explicit Node media entries remain separate.
- See docs/API.md and docs/MIGRATION-3.0.md. CharacterEditor and live model integration are not migrated by this release work.

## 2.2.0 - 2026-09-07

### Added

- `ListSession`: a linear alternative-list conversation model alongside the tree-based `Session`. Each row holds multiple candidates, and one tool loop's full message trace belongs to a single candidate.
- `AgentSession` interface describing the conversation operations `Agent` needs, so custom session models can drive the Agent loop.
- Optional `beginGeneration()` / `endGeneration()` session lifecycle hooks, called by `Agent` around a run so a session can group a whole tool loop into one candidate.
- `ListSession` selection and history APIs: `select()`, `addCandidate()`, `removeCandidate()`, `regenerate()`, `cancelRegeneration()`, `truncateAfter()`, `acceptHistory()`, plus `rows`, `alternatives` and `staleRowIds`.
- `ListSession.toJSON()` / `ListSession.fromJSON()` preserving every candidate, trace and selection, with strict validation on restore.

### Changed

- `Agent` is now generic over its session type (`Agent<S extends AgentSession = Session>`); `agent.session` keeps the concrete type that was passed in.

### Compatibility

- Fully backward compatible. `Agent` defaults to `Session`, so existing code keeps tree-specific APIs such as `agent.session.root` without changes.

## 2.1.0 - 2026-06-19

### Added

- `Message.isEmpty` and `Message.pruneEmpty()` for shared empty-message handling.
- `PromptBuilder` support for using empty messages as anchors while dropping them from the final context by default.
- `dropEmptyMessages: false` build option for debugging or custom context pipelines that need to retain empty messages.

### Changed

- `Message.getHistory(true)` now preserves an empty system root instead of silently omitting it.
- `Agent` prunes empty messages at the model request boundary, including `runRaw()`, so incompatible providers do not receive empty messages.
- API documentation now describes empty-root history behavior and PromptBuilder empty-message cleanup.

## 2.0.0 - 2026-06-11

### Added

- `agent.generate()` for generating from the current Session without appending a User message.
- Awaitable `BEFORE_ASSISTANT_COMMIT` lifecycle handlers before Session persistence.
- `agent.emitAsync()` for ordered, error-propagating asynchronous events.
- Safe `Message.setText()` and `Message.setParts()` mutation APIs.
- Browser-safe `BrowserMediaResolver` and an explicit `@notic/agent-engine/node` media subpath.
- Browser bundling and package export smoke tests.

### Changed

- Built-in adapters now default to `BrowserMediaResolver` so the package root contains no Node.js builtin imports.
- Local file media resolution now requires `DefaultMediaResolver` from `@notic/agent-engine/node` or a custom resolver.

### Breaking

- `DefaultMediaResolver` is no longer exported from the package root. Import it from `@notic/agent-engine/node` in Node.js applications.

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
