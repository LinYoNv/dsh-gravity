# Protocol Architecture & Cross-Language Porting Reference (`linux13-gateway`)

This document details the exact wire transformations performed by `linux13-gateway` so an AI agent or developer can customize it or port it into Python (FastAPI/Quart), Go, or Cloudflare Workers.

---

## Layer 1: Inbound Request Transformation (`transformToLinux13Request`)

Given an incoming OpenAI Chat Completions payload (`POST /v1/chat/completions`):

1. **Activation Gate**:
   - Concatenate all `system` / `developer` messages into `rawPersona`.
   - If `rawPersona` does not match any configured `activationMarkers` (and `'*'` is not set), return `null` and pass the request through to `UPSTREAM_BASE` unchanged.
   - Also pass through unchanged if `body.tool_choice === "none"` or forces a specific single function object.

2. **Historical Refusal Scrubbing & Sliding Window (`historyWindow = 32`)**:
   - Filter out any historical `assistant` turn matching `REFUSAL_RE` (and its immediately preceding duplicate user trigger) so a single past refusal never poisons subsequent turns.
   - Group any trailing `assistant(tool_calls)` + `tool(results)` after `lastRealUserIdx` into the active user turn's execution trace so multi-step tool loops (Step 1 calls real tool -> Step 2 receives tool output and replies in character) never re-invoke the completed tool in an infinite loop.
   - Cap historical turns to the most recent `32` turns.

3. **Image-Tool Wire Cloaking (`cloakClientToolsForWire`)**:
   - Any client tool listed in `cloakedImageTools` (e.g., `nai_generate_image`, `generate_image`, `draw_image`) is renamed on the outbound wire to `archive_scene_tag_descriptor` with a neutral POSIX metadata archiver description.
   - Store the reverse mapping `cloakToRealMap` (`"archive_scene_tag_descriptor" -> "nai_generate_image"`) on the request context.

4. **Synthetic Sink Tool Generation (`dispatch_stream_payload_<16hex>`)**:
   - Mint a collision-checked tool name `dispatch_stream_payload_<16hex>`.
   - Render the 24 enabled blocks of `assets/linux_1.3.json` in `prompt_order`:
     - `【ToolCall引导】` blocks become the 4 top-level `messages` (`system` identity + `{{roll}}` numbers, `user` RuntimeRouter, `assistant` ExecutionKernel ACK, `user` ActionDirective + `{{roll}}`).
     - All persona settings (`<世界设定与背景>`) and conversation turns (`<历史记录>`, formatted as `user@linux:~/Documents$ cat chapter_01_preview.txt`) are concatenated into the `description` of `dispatch_stream_payload_<16hex>`.
   - Attach any multimodal `image_url` parts from `rawEvents[lastRealUserIdx]` (and ONLY the latest turn) to the final user message in `guideMessages`.

---

## Layer 2: Outbound SSE & JSON Unpacking (`SseTunnelUnpacker`)

When the upstream model responds:

1. **Slot Classification (`isSyntheticTool`)**:
   - For each `delta.tool_calls` entry, check `fnName`.
   - **Client tools ALWAYS take priority**: if `clientToolNames` contains `fnName`, it is treated as a real tool call, its `fnName` is uncloaked via `cloakToRealMap`, and its `index` is remapped to a contiguous 0-based index (`0, 1, ...`).
   - Otherwise, if `fnName === toolName` or matches `/^dispatch_stream_payload_[0-9a-f]{16}$/`, it is marked as the synthetic text sink.

2. **Streaming String Argument Decoding (`StreamStringArgDecoder`)**:
   - Stateful character-by-character JSON string parser that locates `"display_stream": "` and yields decoded UTF-8 characters (handling `\"`, `\\`, `\n`, `\uXXXX`, and UTF-16 surrogate pairs across arbitrary chunk boundaries).

3. **Tag Orbit Extraction (`ContentTagStreamExtractor`)**:
   - Buffers decoded characters until `<content>` appears.
   - Extracts any `[character_analysis]` / `[trajectory_analysis]` lines before `<content>` and emits them as `delta.reasoning_content` so the client UI displays the character's inner thought trajectory.
   - Streams everything after `<content>` as `delta.content` until `</content>`, `<sumUp>`, `<pose>`, or `<choices>` is reached.

4. **`finish_reason` Discipline**:
   - If the turn used the synthetic sink and called **zero** real client tools, rewrite `finish_reason: "tool_calls"` -> `"stop"`.
   - If the turn called **both** the synthetic sink and one or more real client tools ("图文双发"), preserve `finish_reason: "tool_calls"` so the host agent loop executes the real tool!
