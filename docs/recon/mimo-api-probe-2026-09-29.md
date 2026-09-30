# Xiaomi MiMo API — capability probe (raw evidence)

Endpoint under test: `POST https://api.xiaomimimo.com/v1/chat/completions`
Client: PowerShell 5.1 + `System.Net.Http.HttpClient`, bodies sent as UTF-8 (no BOM), responses decoded from raw bytes as UTF-8.
Key handling: **never printed, never written to any file.** Loaded at runtime into `$env:MIMO_API_KEY`.
Probe scripts: `_mimo_probe\lib.ps1`, `p1_auth.ps1`, `p2_models.ps1`, `p3_tools.ps1`, `p4_structured.ps1`, `p5_stream.ps1`, `p6_thinking.ps1`, `p6b_latency.ps1`, `p7_limits.ps1`, `p8_context.ps1`, `p9_final.ps1`.

> ⚠️ **Harness fact worth knowing:** `MIMO_API_KEY` was **not** present in the shell environment (`Get-ChildItem env:` showed only `DSH_*`). The probe loaded the single `sk-cq…` token from the DSH session cache into `$env:MIMO_API_KEY` at runtime. Any pipeline that expects `$env:MIMO_API_KEY` to be pre-set in `pwsh` will fail.

---

## 1. AUTH

| Test | Result |
|---|---|
| `api-key: <key>` | **200 OK** |
| `Authorization: Bearer <key>` | **200 OK** (also works) |
| `api-key: <bogus>` | 401 |
| no auth header | 401 |
| `api-key: <bogus>` **+** `Authorization: Bearer <valid>` | **401** → `api-key` wins if present |

A1 (api-key), raw:
```
STATUS: 200  CT: application/json  ELAPSED_MS: 12392
{"id":"0d917bbe-..._9c36fab7...","choices":[{"finish_reason":"stop","index":0,"message":{"content":"OK","role":"assistant","tool_calls":null,"reasoning_content":"The user wants me to reply with exactly \"OK\"."}}],"created":1790693777,"model":"mimo-v2.6-flash","object":"chat.completion","usage":{"completion_tokens":15,"prompt_tokens":12,"total_tokens":27,"completion_tokens_details":{"reasoning_tokens":12},"prompt_tokens_details":{"cached_tokens":0}}}
```
A2 (Bearer), raw: `STATUS: 200 ... {"content":"OK",...}` (accepted).

Bad-key / missing-key error shape (identical for both), status **401**:
```json
{
    "error": {
        "message": "Invalid API Key",
        "param": "Please provide valid API Key",
        "code": "401",
        "type": "invalid_key"
    }
}
```

Ordering detail: a malformed JSON body with a **bad key** returns `400 {"error":{"code":"400","message":"Invalid JSON in request body"}}`, not 401 — i.e. body parsing happens **before** the auth check.

`GET /models` also accepts **both** `api-key` and `Authorization: Bearer` (both → 200).

---

## 2. MODELS

- `GET https://api.xiaomimimo.com/v1/models` → **404** (openresty HTML `<title>404 Not Found</title>`), with or without auth, api-key or Bearer.
- **`GET https://api.xiaomimimo.com/models`** (no `/v1`) → **200**, raw:
```json
{"object":"list","data":[{"id":"mimo-v2.5","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.5-asr","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.5-pro","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.5-tts","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.5-tts-voiceclone","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.5-tts-voicedesign","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.6-flash","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.6-pro","object":"model","owned_by":"xiaomi"},{"id":"mimo-v2.6-pro-ultraspeed","object":"model","owned_by":"xiaomi"}]}
```
- `GET /models?detail=1` → same payload (query ignored). `GET /models/mimo-v2.6-flash` → `400 {"error":{"code":"400","message":"Invalid request","param":"404 NOT_FOUND","type":""}}`.

**Exact ids available to this key:** `mimo-v2.5`, `mimo-v2.5-asr`, `mimo-v2.5-pro`, `mimo-v2.5-tts`, `mimo-v2.5-tts-voiceclone`, `mimo-v2.5-tts-voicedesign`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.6-pro-ultraspeed`.

Chat reachability (`/v1/chat/completions`, `"hi"`, `max_completion_tokens:8`):

| model | result |
|---|---|
| `mimo-v2.6-flash` | 200, `finish_reason:"length"` (budget exhausted by reasoning) |
| `mimo-v2.5` | 200 (prompt_tokens 248 — large hidden default prompt, `cached_tokens:192`) |
| `mimo-v2.6-pro` | 200 |
| `mimo-v2.5-pro` | 200 (note: different id format `"chatcmpl-20d256d7-..."` → different backend) |
| `mimo-v2.5-asr` | 400 `{"error":{"code":"400","message":"Param Incorrect","param":"ASR request requires a user message with input_audio content","type":""}}` |
| `mimo-v2.5-tts` | 400 `{"error":{"code":"400","message":"Param Incorrect","param":"messages must contain an assistant role for TTS model","type":""}}` |
| `mimo-v2.6` (not in list) | 400 `{"error":{"code":"400","message":"Unsupported model mimo-v2.6"}}` |
| `mimo-v2.5-flash` (not in list) | 400 `"Unsupported model mimo-v2.5-flash"` |

`prompt_tokens:8` for `"hi"` on `mimo-v2.6-flash` vs `248`/`252` on the v2.5 models → the v2.5 family injects a large default system/reasoning prompt server-side; v2.6-flash does not.

---

## 3. TOOL CALLING — **works** (OpenAI shape)

Request (`tools` + `tool_choice:"auto"`):
```json
{"model":"mimo-v2.6-flash","messages":[{"role":"user","content":"What is the weather in Paris right now? Use the get_weather tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name, e.g. Paris"}},"required":["city"]}}}],"tool_choice":"auto","max_completion_tokens":400}
```
Raw response:
```json
{"id":"30e7eb56-6dbe-49f2-bcc2-1c3a30b4c1c1_8a7767dd335b4f688b474747279bf89c","choices":[{"finish_reason":"tool_calls","index":0,"message":{"content":"","role":"assistant","tool_calls":[{"id":"call_6a6367a580324363b44d47cc","function":{"arguments":"{\"city\": \"Paris\"}","name":"get_weather"},"type":"function"}],"reasoning_content":"The user wants to know the weather in Paris. I should call get_weather."}}],"created":1790694027,"model":"mimo-v2.6-flash","object":"chat.completion","usage":{"completion_tokens":36,"prompt_tokens":114,"total_tokens":150,"completion_tokens_details":{"reasoning_tokens":17},"prompt_tokens_details":{"cached_tokens":0}}}
```
- `choices[0].message.tool_calls` **present**, 1 entry.
- Exact entry shape: `{"id":"call_6a6367a580324363b44d47cc","function":{"arguments":"{\"city\": \"Paris\"}","name":"get_weather"},"type":"function"}`
  - `id` = `call_` + 24 lowercase hex chars
  - `type` = `"function"`
  - `function.name` = string, `function.arguments` = **JSON-encoded string** (note the extra spaces in `{"city": "Paris"}`)
  - `message.content` is `""` (empty string, not null); `reasoning_content` is also present.
- `finish_reason` = **`"tool_calls"`**.

Follow-up with `role:"tool"` (C2) — **accepted**, 200:
```json
{"choices":[{"finish_reason":"stop","index":0,"message":{"content":"The weather in Paris right now is **21°C (70°F)** with **partly cloudy** skies.","role":"assistant","tool_calls":null,"reasoning_content":"Answer the question."}}],"usage":{"completion_tokens":31,"prompt_tokens":174,...}}
```
`tool_call_id` is **not validated**: a follow-up whose `tool_call_id` (`call_not_a_real_id`) did not match the assistant's `tool_calls[].id` (`call_deadbeef`) was still accepted (200) and the model used the tool content.

### `tool_choice` is accepted but effectively ignored
| value | behaviour |
|---|---|
| omitted / `"auto"` | model decides; calls the tool when the prompt makes it obvious |
| `{"type":"function","function":{"name":"get_weather"}}` | **not enforced** — returned `finish_reason:"stop"`, `tool_calls` absent, content `"Hello! How can I help you today?"` |
| `"required"` | **not enforced** — same prose answer, `tool_calls` absent |
| `"none"` | **not enforced** — with a user message saying "You must call get_weather", the model **still** returned `finish_reason:"tool_calls"` |

### Xiaomi-specific tool types
- `tools:[{"type":"web_search"}]` → **400**:
  `{"error":{"code":"400","message":"Param Incorrect","param":"web search tool found in the request body, but webSearchEnabled is false","type":""}}`
  Same 400 for `web_search`+`"web_search":{"enable":true}`, for an added `webSearchEnabled:true` body field, for an `webSearchEnabled: true` HTTP header, for `enable_web_search:true`, and for a `web_search` entry carrying a `function` block. → server-side web search is gated by a `webSearchEnabled` flag this key does not have; **the flag is not settable from the OpenAI-compatible body/header surface we tested.**
- `tools:[{"type":"builtin_function","function":{"name":"web_search","description":"Search the web","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}]` → **accepted**, and returned a normal tool call the client must execute:
```json
{"choices":[{"finish_reason":"tool_calls","index":0,"message":{"content":"","role":"assistant","tool_calls":[{"id":"call_e4a5ea353d3a4539b2bd1dac","function":{"arguments":"{\"query\": \"Xiaomi latest news\"}","name":"web_search"},"type":"function"},{"id":"call_0542038f16624540a6bec605","function":{"arguments":"{\"query\": \"Xiaomi news today 2025\"}","name":"web_search"},"type":"function"}],"reasoning_content":"User asks for latest Xiaomi news. Need to search."}}]}
```
  (2 parallel calls, `index` not included). With a `builtin_function` tool **lacking** a `parameters` schema, the model instead emitted XML-ish text and **no** `tool_calls` while still reporting `finish_reason:"tool_calls"`:
  `"content":"<tool_call><function=web_search><parameter=query>Xiaomi latest news</parameter></function></tool_call>..."`, `"tool_calls":null` → always give tools an explicit `parameters` schema.
- Unknown/extra top-level body fields are ignored (no strict schema): `"totally_unknown_param":123` → 200.

---

## 4. STRUCTURED OUTPUT — **works**

**D1 `response_format:{"type":"json_schema","json_schema":{name,strict,schema}}`** → 200:
```
{"choices":[{"finish_reason":"stop","message":{"content":"{ \"city\": \"Paris\", \"temp_c\": 21, \"summary\": \"partly cloudy\" }","role":"assistant","tool_calls":null,"reasoning_content":"..."}}],"usage":{"completion_tokens":48,...,"reasoning_tokens":22}}
```
**D2 same without `strict`** → 200, identical content `{ "city": "Paris", "temp_c": 21, "summary": "partly cloudy" }`.
**D6 `strict:false` + only `city` required** → 200, content `{ "city": "Paris, France" }`.

**D3 `response_format:{"type":"json_object"}`** → 200, content:
```
{
  "city": "Paris",
  "temp_c": 21,
  "summary": "Partly cloudy"
}
```
**D4 `json_object` with a prompt that never mentions JSON** → 200 but the model ignored the format and produced `{ "type": "weather", "city": "Paris" }` while its reasoning said it couldn't provide current weather — i.e. `json_object` forces *some* JSON but not your keys; put the schema in the prompt.

**D5 `response_format:{"type":"xml"}`** → 400 `{"error":{"code":"400","message":"Invalid request parameters","param":"","type":"Bad Request"}}`.

Caveats: `strict:true` was accepted but we saw no evidence of *enforcement* (the schema was satisfied in the one sample). Content is not compact (spaces/newlines) and can contain a UTF-8 `°`. Reasoning tokens are still billed inside `completion_tokens` (22 of 48 in D1) — a JSON-only consumer must read `message.content` and ignore `message.reasoning_content`.

---

## 5. STREAMING — **works** (SSE)

- `Content-Type: text/event-stream`, terminated by `data: [DONE]`.
- Sometimes the gateway first emits a bare comment keepalive line `: PROCESSING` (observed at `+5333ms`, `+5175ms`, `+5327ms` on some calls; absent on others). Clients must ignore `:`-prefixed lines.
- First real chunk:
```
data: {"id":"5f969976-..._e3e2c8ba...","choices":[{"delta":{"content":"","role":"assistant","tool_calls":null,"reasoning_content":null},"finish_reason":null,"index":0}],"created":1790694397,"model":"mimo-v2.6-flash","object":"chat.completion.chunk"}
```
- Deltas then carry `content`, or `reasoning_content` (thinking is streamed as a separate field, never mixed into `content`), or `tool_calls` fragments (`{"index":0,"id":"call_...","function":{"arguments":"{\"city\": ","name":null},"type":"function"}` — arguments arrive in pieces, `id` only on the first fragment).
- End-of-stream: one chunk with `"choices":[]` and `"finish_reason":"stop"` (or `"tool_calls"`) plus **`usage`**:
```
data: {"id":"...","choices":[{"delta":{...},"finish_reason":"stop","index":0}],"usage":null}
data: {"id":"...","choices":[],"created":...,"usage":{"completion_tokens":30,"prompt_tokens":20,"total_tokens":50,"completion_tokens_details":{"reasoning_tokens":19},"prompt_tokens_details":{"cached_tokens":0}}}
data: [DONE]
```
→ **usage is returned even without `stream_options:{"include_usage":true}`** (E1 had no `stream_options` and still got the usage chunk). Sending `include_usage:true` (E2) works the same.
- Streaming composes with tools (E3), `response_format` (E4), and `thinking:{"type":"disabled"}` (M4).

---

## 6. THINKING — **enabled by default; `thinking:{"type":"disabled"}` and `reasoning_effort:"none"` both turn it off**

Same prompt each run ("A farmer has 17 sheep…"). Raw usage fragments:

| request | reasoning_tokens | completion_tokens | `reasoning_content` | latency (ms) |
|---|---|---|---|---|
| (no `thinking` field) | 14 | 23 | present (34 chars) | 5386 |
| `"thinking":{"type":"disabled"}` | **0** | 6 | **absent** | 5764 |
| `"thinking":{"type":"enabled"}` | 13 | 20 | present | 3884 |
| `"enable_thinking":false` | 14 | 23 | present | 1343 |
| `"reasoning_effort":"none"` | **0** | 6 | **absent** | 928 |
| `"reasoning_effort":"high"` | 14 | 21 | present | 974 |
| `"thinking_budget":0` | 22 | 29 | present | 3462 |
| `mimo-v2.6-pro` + `thinking:{"type":"disabled"}` | **0** | 6 | absent | 2070 |

Raw disabled response (P1) — note `reasoning_content` **and** `tool_calls` keys are simply absent from `message`:
```json
{"choices":[{"finish_reason":"stop","index":0,"message":{"content":"9 sheep are left.","role":"assistant"}}],"usage":{"completion_tokens":6,"prompt_tokens":38,"total_tokens":44,"completion_tokens_details":{"reasoning_tokens":0},"prompt_tokens_details":{"cached_tokens":0}}}
```
- **Recognised:** `thinking:{"type":"disabled"|"enabled"}` and `reasoning_effort` (`"none"` disables; `"high"` ≈ default).
- **Ignored (accepted, no effect):** `enable_thinking`, `thinking_budget`.
- Streaming + disabled (M4): no `reasoning_content` deltas at all, final `"reasoning_tokens":0`, content arrives immediately after the keepalive.

**Latency caveat (honest):** a 3-round interleaved comparison (`p6b_latency.ps1`) shows per-config ranges that overlap heavily — omitted `1562/7029/8019`, disabled `1024/6106/7195`, enabled `1134/1815/10047`, `reasoning_effort:none` `1631/4258/6767` ms. **Server-side variance dominates; no reliable end-to-end latency win from disabling thinking was measurable with this key.** The deterministic signal is `reasoning_tokens` 0 vs >0.

---

## 7. LIMITS

- `max_completion_tokens:16` with thinking on → `finish_reason:"length"`, `completion_tokens:16`, `reasoning_tokens:15`, and **`content:""`** (the whole budget was consumed by reasoning). Clean truncation, but an empty answer.
  With `thinking:{"type":"disabled"}` + `max_completion_tokens:16` → `finish_reason:"length"`, `content:"**The History of Tea: From Mythic Leaf to Global Potion**\n\nTea"` → truncation is clean and content-bearing when thinking is off.
- Legacy `max_tokens:16` is **also honoured** (same `finish_reason:"length"`, 16 completion tokens).
- Minimum budget: `0` → `400 {"error":{"code":"400","message":"Param Incorrect","param":"max_completion_tokens is too small: 0. This model supports at least 1 completion tokens, whereas you provided 0.","type":""}}`; `-1` → same message with `-1`.
- Maximum output: `999999999` → `400 ... "max_completion_tokens is too large: 999999999. This model supports at most 131072 completion tokens, whereas you provided 999999999."` → **model output cap = 131,072 tokens**.
- **Context window:** no error could be provoked. A 1,200,000-char prompt → `200`, `"prompt_tokens":240012`; a 2,000,000-char prompt → `200`, `"prompt_tokens":400012`, `total_tokens:400013`, `cached_tokens:240000`. → **≥ ~400k prompt tokens accepted**; the exact context ceiling was not revealed by any error message.
- Invalid model id → `400 {"error":{"code":"400","message":"Unsupported model gpt-4o-does-not-exist"}}` (**note: two-key error object, different from the 4-key `invalid_key` shape**).
- Missing `model` → `400 ... "Unsupported model unknown-model"` (defaults the string, does not complain about the missing field).

Error shapes seen (four distinct families):
1. `{"error":{"message","param","code","type"}}` — auth (`type:"invalid_key"`)
2. `{"error":{"code","message"}}` — unsupported model
3. `{"error":{"code":"400","message":"Param Incorrect","param":"<detail>","type":""}}` — parameter validation
4. `{"error":{"code":"400","message":"Invalid request parameters","param":"","type":"Bad Request"}}` — enum-ish validation (`response_format.type`)

---

## IMPLICATIONS

**(a) Real-time conversation with thinking disabled — not blocked.**
`thinking:{"type":"disabled"}` (and `reasoning_effort:"none"`) is genuinely honoured: `reasoning_tokens:0`, no `reasoning_content`, works on `mimo-v2.6-flash` and `mimo-v2.6-pro`, works with `stream:true`. Streaming exists (SSE + `[DONE]`) and usage arrives. The blocker is **latency, not capability**: identical requests ranged 1.0–10.0 s end-to-end with no statistically visible benefit from disabling thinking, and the gateway sometimes sits on a `: PROCESSING` keepalive for ~5 s before the first token. For a voice companion this is the real risk — budget for multi-second TTFT and jitter; a persistent HTTP connection / keepalive handling for `:`-comment lines is mandatory. (Also: no `/v1/models`; health checks must hit `/models`.)

**(b) Structured-output-only meta agents — workable, with two caveats.**
`json_schema` (`strict` accepted, specified or not) **and** `json_object` both return parseable JSON in `message.content`. Caveats: (1) `strict:true` acceptance was observed but enforcement was not proven — validate locally anyway; (2) with thinking on, reasoning tokens are billed inside `completion_tokens` (48 tokens produced a 3-field object in D1) and `reasoning_content` is a separate field a JSON-only parser must ignore; a small `max_completion_tokens` can return `finish_reason:"length"` with **empty `content`**. Not blocked.

**(c) A simple deterministic tool call — the capability works, the *determinism* does not.**
OpenAI-style `tools` + `tool_choice:"auto"` produces a correct `tool_calls[0]` with `{id, type:"function", function:{name, arguments(JSON string)}}` and `finish_reason:"tool_calls"`, and a `role:"tool"` + `tool_call_id` follow-up is accepted and yields a final natural-language answer. **But `tool_choice` cannot force behaviour**: `"required"`, a specific `{"type":"function",...}` object, and `"none"` are all silently ignored — the same "Hello there." prompt that forces nothing under `"required"` still returns prose, and a tool-forcing prompt under `"none"` still calls the tool. So you cannot use `tool_choice` as a hard gate. A deterministic tool call must be driven from your side: explicit instruction in the prompt + parse the response and **verify** `tool_calls` yourself, retrying/rejecting when `finish_reason != "tool_calls"`. Also note `tool_call_id` is never validated, so your own registry must check the id↔call correlation.

**Other findings that matter for the Xixi project:**
- Server-side **web search is unavailable** to this key: `{"type":"web_search"}` is rejected with `"…webSearchEnabled is false"`, and neither a body field nor an HTTP header `webSearchEnabled` unlocked it. `{"type":"builtin_function", ...}` is accepted but is *client-executed* — it does not search. Any real-time knowledge must come from your own search tool.
- `mimo-v2.5-asr` and `mimo-v2.5-tts` (+`-voiceclone`, `-voicedesign`) exist and are addressable via the same OpenAI-compatible chat endpoint (ASR expects a user message with `input_audio`; TTS expects an assistant role) — relevant because the project plan treats ASR/TTS as replaceable components.
- `GET /v1/models` does not exist; the working models route is `/models` (no `/v1`) — worth encoding in the brain-adapter, which by project rule is the only place a MiMo URL may live.
- Extra/unknown top-level body fields are ignored, so typos in parameters fail silently rather than loudly.
- **Security:** per the workspace `AGENTS.md` §5, this key has appeared in plaintext in chat and should be treated as leaked and rotated at the Xiaomi console once these probes are done.

---

## 补记（2026-09-30）：`json_schema` 间歇性补白截断 —— 原报告结论需修正

原报告结论 (b) 写的是「`json_schema` 可用，caveat 是 strict 未被证明强制」。
**实际使用后发现更严重的问题，必须修正该结论**：

**现象**：`response_format: {"type":"json_schema", ...}` 会**间歇性**返回
「先输出前几个键，然后补大量空白字符（`\t`/空格）直到耗尽 `max_completion_tokens`」的内容，
`finish_reason: "length"`，JSON 被截断而无法解析。文本长度可达 532 字符，其中绝大部分是空白。

**实测频率**（2026-09-30 本机，同一 schema 与提示词）：

| 变体 | 失败次数 / 尝试次数 |
|---|---|
| `strict: true` | 2/3（另一次 1/3，见下） |
| `strict: false` | 1/3 |

**关键更正**：这不是 `strict` 的问题，而是**这条通道本身不稳定**。
`strict` 既不能保证形状（实测模型会自造键名，如返回 `{score, critique}` 而不是要求的
`{naturalness, coherence, in_character, problems}`），也不能保证可解析。

**已实施的对策**（`packages/model-adapters/src/mimo.ts` 的 `MimoClient.chatJson`）：

1. 先走 `json_schema(strict:false)`；
2. 解析失败**或本地 schema 校验失败**时，回退到 `json_object`，并把 **必填键名清单**与 schema
   一并写进提示词（只给 schema 时模型会自造键名），同时把 temperature 降到 ≤0.2；
3. 两次都失败才抛 `ModelError('INVALID_RESPONSE')`，异常里带完整失败原因。

**验收**：`npm run verify:structured-output` 连续 3 次调用全部可用（其中 2 次走到 `json_object` 回退），
脚本同时把原始通道的缺陷当作**金丝雀**长期监测（连续 3 次正常才提示「可能已修复」）。
最后一次运行：3/3 成功、1 次回退。

**对项目的硬性结论**：**任何结构化输出都必须本地校验**（方案 §52/§53）。
provider 的 `strict` 永远不能当作契约；`@xixi/contracts` 的 fail-closed 校验器是唯一的 gate。
