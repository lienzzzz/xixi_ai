# DSH 0.1.7-rc.2 + MiMo integration recipe (verified)

All commands were run from `E:\worker2` unless noted. `DSH_HOME` was pointed at
`E:\worker2\.scratch\dshhome` for every run, so nothing was written under
`C:\Users\zz\.dsh`. The key was only ever passed as `$env:MIMO_API_KEY` inside a
shell session; it appears in no file.

Environment note: `MIMO_API_KEY` was **not** present in the tool shell
(`($env:MIMO_API_KEY.Length)` → "not set"), so each test command set it inline
in that command only. See §2 for what that implies.

---

## 1. EXACT CONFIG for a MiMo provider route

**Wire protocol string: `openai-completions`.**
`.../dsh-llm-pi-ai/README.zh.md:62` (`api: openai-completions`), and the
generated schema restricts `api` to exactly three values —
`E:\worker2\.scratch\schema.json:1302/1308/1314` → `openai-completions`,
`openai-responses`, `anthropic-messages`.

**Route requirements** — `.../dsh-llm-pi-ai/README.zh.md:117`:
> pi-ai 不提供的路由需要 `api`、`baseURL` 与非空 `models` 列表

(`bibliography`: route not shipped by pi-ai ⇒ `api` + `baseURL` + non-empty
`models` are mandatory; a `MISSING_CREDENTIAL` route fails as shown in §2.)

**Route fields** — `.../dsh-llm-pi-ai/lib/types/config.d.ts:54-145`, defaults at
`:95-112`: `apiKeyEnv?`, `displayName?`, `api?`, `baseURL?`, `models?`,
`modelOverrides?`, `compat?`, `defaultContextWindow?` (262,144),
`defaultMaxTokens?` (32,768), `defaultInput?` (`[text]`), `headers?`,
`reasoning?`, `thinkingBudgets?`, `cacheRetention?`, `transport?`, `timeoutMs?`,
`streamIdleTimeoutMs?`, `maxRequestImageBytes?`, `retryPolicy?`.

**`PiAiModelProfile` fields** — `.../lib/types/catalog.d.ts:257-293`:

| field | req? | notes |
|---|---|---|
| `id` | **required** | string sent to the provider |
| `name` | optional | selector label |
| `contextWindow` | optional | |
| `maxTokens` | optional | output capability; a configured value also becomes the per-request default (`:264-270`) |
| `input` | optional | `["text"]` / `["text","image"]` |
| `reasoningEfforts` | optional | `false` \| `{off:null, high:"high", …}` — **not** named `reasoning` |
| `compat` | optional | `PiAiCompatProfile` (`catalog.d.ts:156-228`) |
| `cost` | **does not exist** | not part of `PiAiModelProfile`; cost is catalog-only |

`reasoning` is a **route-level** field (`config.d.ts:116`), not a model field.

**Patch file shape**: `cordis.patch.yml` is a top-level YAML **array** of patch
entries; an entry targets an existing row by `id` (`C:\Users\zz\.dsh\profiles\web\cordis.patch.yml:1-4`
+ its `agent-default-model` example). A patch replaces the row's whole `config`.

### Full working snippet — route named `mimo` (verified)

`E:\worker2\.scratch\mimo.yml`:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mimo:
        displayName: MiMo (Xiaomi)
        apiKeyEnv: MIMO_API_KEY
        api: openai-completions
        baseURL: https://api.xiaomimimo.com/v1
        defaultContextWindow: 262144
        defaultMaxTokens: 32768
        defaultInput:
          - text
        models:
          - id: mimo-v2.6-flash
            name: MiMo v2.6 Flash
            contextWindow: 262144
            maxTokens: 32768
            input:
              - text
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mimo
    model: mimo-v2.6-flash
```

To instead add it to the **web** profile permanently, append these two entries to
`C:\Users\zz\.dsh\profiles\web\cordis.patch.yml` (web already composes
`llm-pi-ai` at `dsh-base/cordis.patch.yml:127-128` and overrides
`agent-default-model` at `web/cordis.patch.yml`). `baseURL` must be the API root
**without** `/chat/completions`; pi-ai appends the path.

### Alternative that leans on pi-ai's own catalog (verified)

pi-ai ships a **`xiaomi`** provider — `.../@earendil-works/pi-ai/dist/providers/xiaomi.js`:
`id: "xiaomi"`, `baseUrl: "https://api.xiaomimimo.com/v1"`,
`api: openAICompletionsApi()`, auth env `XIAOMI_API_KEY`. Its catalog
(`dist/providers/data/xiaomi.json`) lists only `mimo-v2.5`, `mimo-v2.5-pro`,
`mimo-v2.5-pro-ultraspeed` — **not** `mimo-v2.6-flash`. Those catalog entries
carry `compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true }`,
`reasoning: true`, `contextWindow: 1048576`, `maxTokens: 131072`.

`E:\worker2\.scratch\mimo-catalog.yml` — shorter, and reuses the catalog:
```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      xiaomi:
        apiKeyEnv: MIMO_API_KEY
        compat:
          thinkingFormat: deepseek
          requiresReasoningContentOnAssistantMessages: true
        models:
          - id: mimo-v2.6-flash
            name: MiMo v2.6 Flash
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: xiaomi
    model: mimo-v2.6-flash
```
(A `models` list *replaces* the route catalog, so the three v2.5 models disappear.)

---

## 2. CREDENTIAL RESOLUTION

`apiKeyEnv` is a **harness credential reference** resolved per request through
`ctx.credentials` — not a direct `process.env` read by the adapter.
`README.zh.md:38`: "「apiKeyEnv」是按请求经 harness 凭据 seam 解析的凭据引用".
`config.d.ts:55`: "Credential reference (environment-variable name) resolved per
request through `ctx.credentials`".

Resolution order, `.../dsh-credentials-local/lib/index.js:427-490`:

```js
inherited(ref) { return launchEnvironmentOf(this.ctx).getFrom(ref, ["process"]) }   // :428-431, source "env"
dotenvFallback(ref) { return launchEnvironmentOf(this.ctx).getFrom(ref, ["project-env","user-env"]) } // :437-440
resolve(ref) {
  const inherited = this.inherited(ref); if (inherited !== undefined) return { value: inherited, source: "env" }   // :474-478
  const stored = this.values.get(ref);   if (stored    !== undefined) return { value: stored,    source: "file" }  // :479-483
  const fallback = this.dotenvFallback(ref); if (fallback !== undefined) return { value: fallback.value, source: fallback.source } // :484-488
  return undefined;                                                                                              // :489
}
```

So the value is: **process env (launch snapshot) → `$DSH_HOME/.credentials.yaml`
`refs:` → `<cwd>/.env` → `$DSH_HOME/.env`** (`README.zh.md:12,76-80`).

Exactly what must be true:

1. The reference is read from the **launch environment snapshot**
   (`dsh-launch-environment` README.zh.md:46,54,75,103), frozen at process
   start. **The DSH host's process environment is sufficient — provided the
   variable is already exported when `dsh` is launched.** Exporting it *after*
   launch is never seen (`credentials-local/README.zh.md:80`: "环境层是启动时拍摄的
   启动器环境快照，因此启动之后才导出的变量不会被看到").
2. Windows: names are upper-cased before storage (`launch-environment/README.zh.md:75`).
3. Alternatives if you cannot control launch env: put the key in
   `$DSH_HOME/.credentials.yaml` under `refs:` (`README.zh.md:86-92`:
   `version: 1` / `refs:` / `NAME: value`), or in `$DSH_HOME/.env`; env still wins
   and makes the reference read-only (`:119`).
4. A blank/empty stored value equals "absent" everywhere (`:12`, `:111`).

**Negative test (proves the env var was what resolved it, and proves the store
was not used)** — `E:\worker2\.scratch\dshhome\.credentials.yaml` does not exist
(`Test-Path` → `False`):

```
$env:DSH_HOME='E:\worker2\.scratch\dshhome'
Remove-Item Env:\MIMO_API_KEY
dsh --profile xixi --patch E:\worker2\.scratch\mimo.yml "say hi"
```
observed (stderr, exit 1):
```
dsh: MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "mimo"; its profile resolves MIMO_API_KEY, which is not set — store MIMO_API_KEY through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should authenticate from pi-ai's own environment discovery
```

---

## 3. ONE TURN + SESSION RESUME

### (a) One headless turn

`dsh --profile headless` is the one-shot app (`dsh --help`: `dsh headless "run the tests"` ≡
`dsh --profile headless "run the tests"`). Final assistant text goes to **stdout**,
diagnostics to **stderr** (`dsh-headless/README.zh.md:36`).

```
$env:DSH_HOME='E:\worker2\.scratch\dshhome'
$env:MIMO_API_KEY='<key>'
dsh --profile headless --patch E:\worker2\.scratch\mimo.yml "Reply with exactly: HELLO-DSH"
```
observed stdout, exit 0:
```
HELLO-DSH
```

To capture the session id machine-readably add `--json` (first event):
```
dsh --profile headless --patch E:\worker2\.scratch\mimo.yml --json "Reply with exactly: HELLO-DSH"
```
observed:
```
{"type":"session","sessionId":"session-e2a5d451-5521-4bbb-9b7b-662470b76dc9","cwd":"E:\\worker2"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":"The user asks to reply with exactly HELLO-DSH."}
{"type":"text","text":"HELLO-DSH"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":1608,"outputTokens":21,"totalTokens":5725,"cacheReadTokens":4096}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"HELLO-DSH"}
```

### (b) Resume in a NEW process

Flag: **`--session-id <id>`** (`dsh headless --help`; `dsh-headless/README.zh.md:54,80`).
`--json` also gives the id in the opening `session` event. A live agent holding
the id in the same process is refused; an unknown id is an error before the task runs.

```
dsh --profile headless --patch E:\worker2\.scratch\mimo.yml --session-id session-e2a5d451-5521-4bbb-9b7b-662470b76dc9 "What exact text did you reply with in your previous message? Output only that text."
```
observed (exit 0) — note `turn: 2` and `cacheReadTokens: 5696` of `totalTokens: 5768`,
i.e. the whole turn-1 history was replayed:
```
{"type":"session","sessionId":"session-e2a5d451-5521-4bbb-9b7b-662470b76dc9","cwd":"E:\\worker2"}
{"type":"status","phase":"turn_start","turn":2}
{"type":"status","phase":"step_end","turn":2,"step":1,"usage":{"inputTokens":53,"outputTokens":19,"totalTokens":5768,"cacheReadTokens":5696}}
{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}
{"type":"final","text":"HELLO-DSH"}
```

Constraints (all verified/documented):
- **Same cwd is mandatory.** From `E:\worker2\.scratch`: `dsh: session "session-e2a5d451-…" was recorded in "E:\worker2", not "E:\worker2\.scratch"` (`dsh-headless/lib/index.js:226`).
- Same **profile composition** (agent preset) is mandatory; adopting requires
  both `sessionPersistence` and `sessionQuery` services (`dsh-headless/lib/index.js:242,244`;
  README.zh.md:54).
- The **patch/route must be present again on the resume command** (`--patch …` or
  the profile's own `cordis.patch.yml`), otherwise `mimo` has no route.

### Where it lands on disk

Root is configured in `.../dsh-base/cordis.patch.yml:130-133`:
```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
```
Layout (`session-persistence-jsonl/README.zh.md:43,56-72`):
```
$DSH_HOME/sessions/<escaped-cwd>/<escaped-session-id>/session.vN.jsonl.zstd
```
Observed, `$DSH_HOME=E:\worker2\.scratch\dshhome`, cwd `E:\worker2`:
```
E:\worker2\.scratch\dshhome\sessions\--E-worker2--\session-e2a5d451-5521-4bbb-9b7b-662470b76dc9\session.v4.jsonl.zstd   10164 bytes
```
Note: the on-disk generation is **v4** (there is a `dsh-session-format-v3-to-v4`
migration package), while the packaged README still calls v3 "current".
`compression: 'none'` turns the log into plain NDJSON.

Other surfaces: the launcher has **no** resume flag of its own; `dsh tui --resume <session>`
appears only as an example in `dsh --help` and there is **no `dsh-tui` package**
in this installation (no `tui` profile either — `dsh tui --help` →
`profile "tui" does not exist`). The web app resumes through its UI.

---

## 4. MINIMAL CUSTOM TOOL PLUGIN

**Template copied from `@deepseek-ai/dsh-tool-ask-user`** — the smallest shipped
tool package (7 files, 23 KB) and the only one with a single `defineTool` call.

Registration API (`.../dsh-tool-ask-user/lib/index.js:1,11-16,116`):
```js
import { defineTool } from "@deepseek-ai/dsh-tools";
const name = "tool-ask-user";
const inject = ["tools", "userQuestions"];
function apply(ctx) { ctx.tools.register(defineTool({ … })); }
export { apply, inject, name };
```
Package export shape (`lib/types/index.d.ts:10-12`): `name`, `inject`, `apply`.
`ctx.tools.register(definition) => () => void` (`dsh-tools/lib/types/index.d.ts:636`).
`defineTool` options (`dsh-tools/lib/types/schema.d.ts:178-248`): required
`name`, `description`, `parameters` (the author DSL — the map itself is an
implicit open object root, `:77-88`), `output: { schema, render(args, value) }`,
`execute(args, exec)`. The `parameters`/`output.schema` DSL is compiled to raw
JSON Schema by `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`.

### `E:\worker2\.scratch\xixi-tool\package.json` (verbatim)
```json
{
  "name": "dsh-xixi-tool",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": "0.1.7-rc.2" },
  "peerDependenciesMeta": { "@deepseek-ai/dsh-tools": { "optional": true } },
  "dsh": { "bundle": { "patch": "cordis.patch.yml" } }
}
```
`dsh.bundle.patch` is what makes it mountable by adding its name to the profile's
`dsh.profile.bundles` (pattern from `E:\dsh\dsh-free-search\package.json` + `cordis.patch.yml`).

### `E:\worker2\.scratch\xixi-tool\index.js` (complete, verbatim)
```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'xixi-get-current-time'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'xixi_get_current_time',
    description: 'Return the current time as an ISO-8601 timestamp. Takes no arguments.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          iso: { type: 'string', required: true, description: 'Current time in ISO-8601 UTC format.' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.iso }]
    },
    async execute() {
      return { iso: new Date().toISOString() }
    }
  }))
}
```

### `E:\worker2\.scratch\xixi-tool\cordis.patch.yml`
```yaml
- insert:
    - id: xixi-get-current-time
      name: dsh-xixi-tool
```

**Verified live** (MiMo, tool calling over pi-ai `openai-completions`):
```
dsh --profile xixi --patch E:\worker2\.scratch\mimo.yml --json "Call the xixi_get_current_time tool, then report its exact output verbatim."
```
observed:
```
{"type":"tool_call","callId":"call_f6b0db51a09245418c80b91e","tool":"xixi_get_current_time","input":{}}
{"type":"tool_result","callId":"call_f6b0db51a09245418c80b91e","status":"completed","result":"2026-09-29T14:58:44.612Z"}
{"type":"final","text":"The tool returned exactly:\n\n```\n2026-09-29T14:58:44.612Z\n```"}
```

Local wiring used for this test (all inside scratch): a junction
`<profile>/node_modules/dsh-xixi-tool → E:\worker2\.scratch\xixi-tool`, plus a
junction `E:\worker2\.scratch\xixi-tool\node_modules\@deepseek-ai\dsh-tools →
C:\Users\zz\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools` so the plugin's
own `import` resolves. In a real install, `dsh plugin --profile <p> add link:<path>`
does the same thing (pnpm, hoisted linker).

---

## 5. PROFILE CREATION (`xixi`), non-interactively

`PROFILE_TEMPLATES` (`.../dsh-app-boot/lib/index.js:528-535`) = `acp`, `web`,
`headless`, `sdk`, `sdk-minimal`; `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]` (`:543`).

### From a shipped template (verified, **no prompts**)
```
$env:DSH_HOME='E:\worker2\.scratch\dshhome'
dsh --profile xixi --from-default-profile headless --dump-config
```
exit 0, silent on stderr; it created `$DSH_HOME\profiles\xixi\`:
```
cordis.patch.yml (217 B)   # the standard empty "[]" user layer
cordis.yml        (223 B)  # "[]" root
package.json      (209 B)
pnpm-workspace.yaml (61 B)
```
`profiles\xixi\package.json`:
```json
{ "name": "dsh-profile-xixi", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }
```
Re-running the same flag on the existing profile fails (alpha/exists guard,
`profile-boot-BZ2ZjNWi.js:146,153`):
```
dsh: profile "xixi" already exists at E:\worker2\.scratch\dshhome\profiles\xixi\package.json; omit --from-default-profile to use it
```
**`--from-default-profile` requires no interactivity** — it is a pure
`initProfile(dir, template.bundles)` copy (`profile-boot-BZ2ZjNWi.js:129-157`,
`app-boot/lib/index.js:575-591`). Caveats: the target name must not be a shipped
template name, the directory must not exist, and only the **bundle list** is
copied (no local state from the same-named shipped profile).

### From scratch / arbitrary name (verified)
```
$env:DSH_HOME='E:\worker2\.scratch\dshhome2'
dsh plugin --profile alpha --version
```
observed (stderr) — initializes with `DEFAULT_PROFILE_BUNDLES`:
```
dsh: initialized profile alpha at E:\worker2\.scratch\dshhome2\profiles\alpha
```
→ `bundles: ["@deepseek-ai/dsh-base"]`, plus `cordis.patch.yml` + `pnpm-workspace.yaml`.

Hand-written minimum (equivalent to `initProfile`, `app-boot/lib/index.js:575-591`):
```
$DSH_HOME\profiles\xixi\package.json          # name dsh-profile-xixi, private, dsh.profile.bundles
$DSH_HOME\profiles\xixi\cordis.yml            # []
$DSH_HOME\profiles\xixi\cordis.patch.yml      # []  (the user patch layer)
$DSH_HOME\profiles\xixi\pnpm-workspace.yaml   # packages: [.] / nodeLinker: hoisted / autoInstallPeers: false
```

### Choosing a minimal plugin set
The **`dsh.profile.bundles`** array is the lever. Verified working set:
```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-xixi-tool"]
```
`dsh-base` supplies llm / credentials / session / tools / session persistence;
`dsh-headless` supplies the one-shot runner. Anything else in the tree is turned
off in the profile's `cordis.patch.yml` with `- id: <row>` + `disabled: true`
(dsh-base itself uses that idiom, e.g. `dsh-base/cordis.patch.yml:16-18`), and new
rows are added with `- insert: [ { id, name, config } ]`.

Full verified boot:
```
dsh --profile xixi --patch E:\worker2\.scratch\mimo.yml --dump-config   # exit 0, tool row present at line 400
dsh --profile xixi --patch E:\worker2\.scratch\mimo.yml --json "Call the xixi_get_current_time tool, …"  # exit 0, tool executed
```

---

## Blockers / surprising findings

1. **No blocker on auth.** MiMo accepts **both** `api-key:` **and**
   `Authorization: Bearer` (curl, `http=200` for both with a valid key). My first
   probe returned `401 Invalid API Key` for both only because `MIMO_API_KEY` was
   unset in the tool shell. So pi-ai's `openai-completions` path (Bearer) is fine —
   no `headers:` workaround needed. Direct probe: `POST https://api.xiaomimimo.com/v1/chat/completions`, body `{"model":"mimo-v2.6-flash",…}` → `200`, content `PONG`, plus a `reasoning_content` field and `completion_tokens_details.reasoning_tokens`.
2. **`--profile web` cannot run a headless turn.** `dsh --profile web --help`
   shows only server flags (`--host/--port/--no-open/--trusted-host`); the web
   profile's app is `@deepseek-ai/dsh-web-app` (no `dsh-headless` anywhere in the
   composed tree). Use `--profile headless` (or a profile like `xixi` whose
   bundles include `@deepseek-ai/dsh-headless`) plus `--patch`, or put the MiMo
   entry in `web/cordis.patch.yml` and drive it through the Web UI.
3. **pi-ai *does* ship a Xiaomi provider.** Route key `xiaomi`, baseURL
   `https://api.xiaomimimo.com/v1`, `api: openai-completions`, auth env
   `XIAOMI_API_KEY`; catalog has only `mimo-v2.5`, `mimo-v2.5-pro`,
   `mimo-v2.5-pro-ultraspeed`. A hand-declared route is therefore **not**
   required for MiMo — but `mimo-v2.6-flash` is in no catalog, so it must be
   declared either way. Both the `mimo` hand-declared route and the `xiaomi`
   catalog route + `models` list were verified working.
4. **Set `compat` for replay fidelity on a hand-declared route.** The catalog
   Xiaomi entries carry `thinkingFormat: "deepseek"` and
   `requiresReasoningContentOnAssistantMessages: true`. My hand-declared `mimo`
   route omitted `compat` and still completed two turns plus an in-turn replay
   with a tool call, but those two flags are what the vendor catalog asserts; a
   hand-declared route silently gets pi-ai's baseURL detection instead
   (`catalog.d.ts:142-147`). Recommended to set them.
5. **`cost` is not configurable.** `PiAiModelProfile` has no `cost` field
   (`catalog.d.ts:257-293`); model-level `reasoning` does not exist either — it
   is `reasoningEfforts` on the model and `reasoning` on the route.
6. **Sessions are keyed to cwd and to the profile composition.** Resuming from a
   different cwd, or under a profile that composes a different agent preset, is
   refused before the task runs (`dsh-headless/lib/index.js:221-244`).
7. **Session generation on disk is v4** (`session.v4.jsonl.zstd`), newer than
   the "v3/current" text in `dsh-session-persistence-jsonl/README.zh.md:62-69`.
8. **The key is not inherited by tool subprocesses here.** `MIMO_API_KEY` was
   absent in the shell spawned by the running DSH host, so launch-env resolution
   only helps when the variable is exported before the *DSH host* starts (which
   is exactly the supported path — see §2).

## Files produced (all under `E:\worker2\.scratch`)
- `mimo.yml` — the `mimo` route patch (verified)
- `mimo-catalog.yml` — the `xiaomi` catalog-route variant (verified)
- `xixi-tool\` — `package.json`, `index.js`, `cordis.patch.yml` (verified live)
- `dshhome\` — scratch harness home with profiles `headless`, `xixi` and their sessions
- `dshhome2\` — scratch home proving non-template profile init
- `headless-config.yml`, `web-config.yml`, `schema.json`, `turn1..3.ndjson` — evidence dumps
