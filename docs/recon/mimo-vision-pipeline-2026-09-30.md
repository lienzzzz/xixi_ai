# 把一张图交给模型：管道落地与真机验证（2026-09-30）

> 最后更新：2026-09-30
> 任务：t87 —— 大脑接缝与 MiMo 适配器的**可选**图像支持（纯文本路径保持不变）。
> 上游证据：[`mimo-vision-probe-2026-09-30.md`](mimo-vision-probe-2026-09-30.md)（API 是否接受图像、接受什么形状、成本）。
> 回归测试：[`tests/unit/core/mimo-image-payload.test.ts`](../../tests/unit/core/mimo-image-payload.test.ts)（4 项，逐字节钉住两种请求体）。

## 1. 落地了什么（纯文本路径一行不改）

| 位置 | 变化 |
|---|---|
| `packages/brain-adapter/src/types.ts` | 新增 `BrainImageInput { mediaType, base64 }`；`UserTurnInput` 增加**可选** `images`（只属于当前这一轮）。 |
| `packages/brain-adapter/src/mimo.ts` | `#messages()` 把 `images` 挂到**最后一个 user 消息**上（prompt 路径与 context 路径都覆盖）。 |
| `packages/model-adapters/src/mimo.ts` | `MimoMessage` 增加可选 `images`；`#body()` 只有在**本轮真的带图时**才改写 messages——不带图时 `messages: options.messages` 原样交给 `JSON.stringify`，所以请求体逐字节与改动前一致。带图的消息转成 OpenAI 风格 `content: [text?, {type:'image_url',image_url:{url:'data:<mime>;base64,<bytes>'}}]`，并把本地字段 `images` 摘掉（不发明线上字段）。新增导出 `imageDataUrl()`。 |
| `packages/brain-adapter/src/dsh.ts` | DSH 路径（把一轮压成一个 task 字符串）**发不了图**，因此**拒绝**而不是丢弃：`BrainError('BAD_REQUEST', 'the DSH harness path cannot send images yet', { detail: '…use the direct MiMo path…' })`，且在任何 transport 调用之前抛出。**静默丢图会让模型以为它看见了画面**，这是这里唯一不能接受的选项。 |
| `packages/brain-adapter/src/fake.ts` | 离线替身**故意忽略** `images`（它不对「看见」做任何承诺），注释里写明；要验证管道就看线上请求体。 |

回归测试钉住两件事（`npm run test:unit` 会跑）：

1. **不带图**：请求体等于字面量（逐字节比较 `JSON.stringify` 结果，不是解析后比较）。
2. **带图**：请求体等于含 `image_url` + base64 data URL 的字面量；`"images"` 字样**不得**出现在请求体里；同一轮里不含图的消息仍是纯字符串。
3. 接缝层：加图只改 `messages`（其余字段与不带图那一轮逐字段相等）。
4. DSH 路径：拒绝带图的一轮（`BAD_REQUEST`），且 transport 一次都没被调用。

```powershell
node --test tests/unit/core/mimo-image-payload.test.ts   # 4/4
```

## 2. 真实密钥的真机验证（带图 200 + 不带图对照）

`scripts/` 不在 t87 的改动范围里，所以这次验证用一个**仓库外**的临时脚本（内容见下），跑的是**生产管道**
`MimoBrainAdapter → MimoClient`，不是裸 `fetch`。密钥只经环境变量传入，脚本只打印结论：

```powershell
# 密钥：MIMO_API_KEY（本次由 .env 读入进程环境；值不打印、不落盘）
$env:MIMO_API_KEY = ((Get-Content .env | Select-String -Pattern '^MIMO_API_KEY=') -replace '^MIMO_API_KEY=','').Trim()
$env:XIXI_T87_IMAGE = "$env:TEMP\xixi-t87-64x64.jpg"   # 64x64：白底 + 红圆盘 + 小蓝方块（cv2 生成）
node "$env:TEMP\xixi-t87-live-vision.ts"
```

临时脚本（`%TEMP%\xixi-t87-live-vision.ts`，约 30 行，可直接照抄重跑）：

```ts
import { readFileSync } from 'node:fs';
import { MimoBrainAdapter, collectTurn } from 'file:///E:/worker2/packages/brain-adapter/src/index.ts';

const jpeg = readFileSync(process.env['XIXI_T87_IMAGE'] as string);
const images = [{ mediaType: 'image/jpeg', base64: jpeg.toString('base64') }];
const prompt = '这张图里最主要的是什么颜色？只回答颜色两个字。';

const adapter = new MimoBrainAdapter({ stream: true, maxCompletionTokens: 32, temperature: 0 });
const withImage = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_t87', text: prompt, images }));
console.log(JSON.stringify({ variant: 'with-image', action: withImage.result.action, text: withImage.result.text }));
const control = await collectTurn(await adapter.handleUserTurn({ sessionId: 'sess_t87', text: prompt }));
console.log(JSON.stringify({ variant: 'text-control', action: control.result.action, text: control.result.text }));
```

实测输出（原样，两轮都是真实调用）：

```
image: C:\Users\zz\AppData\Local\Temp\xixi-t87-64x64.jpg (1516 bytes) | describe: {"provider":"mimo-direct","model":"mimo-v2.6-flash","transport":"https-api","mode":"live"}
{"variant":"with-image","action":"SPEAK","text":"红色","model":"mimo-v2.6-flash","latencyMs":1179,"chunks":1}
{"variant":"text-control","action":"SPEAK","text":"蓝色","model":"mimo-v2.6-flash","latencyMs":958,"chunks":1}
```

怎么读这两行：

- **带图 → 「红色」，答对**。非 2xx 在 `MimoClient.#post` 里会变成 `ModelError`、再由适配器转成 `BrainError`
  （401→AUTH、400→BAD_REQUEST…），所以「这一轮正常以 `SPEAK` 收束」就是 **HTTP 200** 的证据；本轮没有抛错。
- **不带图的对照 → 「蓝色」，答错**：同一个提示词、同一个模型、同一个进程，唯一差别是没挂图。
  这既证明「答对」不是提示词猜出来的，也再次说明**模型被问到看不见的东西时不会承认看不见**——
  所以「何时挂图」必须由程序决定（铁律 1/3），不能交给模型。
- 首字延迟 1179ms / 958ms 与纯文本轮同量级，图像没有带来明显额外的等待。

**密钥检查**：整段输出（`%TEMP%\xixi-t87-live.log`）里密钥出现 **0** 次（用密钥原值做 `Select-String -SimpleMatch` 实测）；
本次新增/修改的仓库文件中密钥出现 0 次、无 `sk-` 字面量；临时脚本只读 `process.env`，从不打印它。

## 3. 本次验证了什么 / 没验证什么

**验证了**

- 工程管道：`UserTurnInput.images` → 最后一个 user 消息 → OpenAI 风格 `image_url` data URL → 真实 API **200 且答出图中内容**（上表）。
- 纯文本路径未变：请求体逐字节相等（单测，不是「看起来一样」）。
- 接缝的诚实性：发不了图的 DSH 路径**拒绝**（`BAD_REQUEST`，transport 零调用），不静默丢图。
- 对照实验：同一提示词不带图时答错。

**没验证（不要据此下结论）**

- 多图同请求、图像 + 工具调用同用、`stream:false` 下的带图轮（本次真机验证走的是默认流式路径）、远程 `https` 图片 URL。
- 识别质量：只测了一张纯色几何图的主色；**没有**测真摄像头帧、暗光/模糊、OCR、小物体。
- 模型覆盖面：只跑了 `mimo-v2.6-flash`；`mimo-v2.5-pro` 已由上游报告证明返回 404，其余 id 未测。
- 生产入口接线：目前**没有任何生产入口传 `images`**（控制台/CLI 都还没接）；本任务是「管道可用」，不是「西西已经会看」。
- 成本/隐私取舍：见上游报告 §3/§4（480×360 ≈ 165 图像 token；帧不落盘、不得连传）。

## 4. 顺带订正

[`mimo-api-probe-2026-09-29.md`](mimo-api-probe-2026-09-29.md) §2 关于模型列表端点的记录**已对调**：
现在 `GET /v1/models` → **200**、`GET /models`（不带 `/v1`）→ **404**，与 09-29 那次观察相反。
该文档保留了 09-29 的原始观察并加了 2026-09-30 的订正说明（不擦掉历史，只标明哪句已作废）。
