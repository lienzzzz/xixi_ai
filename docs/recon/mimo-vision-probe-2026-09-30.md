# MiMo 是否支持图像输入：探测报告（2026-09-30）

> 最后更新：2026-09-30
> 目的：为「让西西看见画面」定路径——**按需把一张缩略静帧上云**，还是**本地先转成文字再给模型**。
> 探测脚本：[`scripts/probe-mimo-vision.ts`](../../scripts/probe-mimo-vision.ts)（一次性脚本，`packages/` 不依赖它）
> 上游事实：[`mimo-api-probe-2026-09-29.md`](mimo-api-probe-2026-09-29.md)（认证、模型列表、thinking 默认等）

## 0. 怎么复现（密钥只来自环境变量）

```powershell
# 密钥来源：MIMO_API_KEY 环境变量；没设时由脚本经 scripts/lib/harness.ts 的 readDotEnv() 读 .env。
# 脚本不打印、不回显、不落盘密钥：所有输出都过 redact()，图像数据只显示成 base64:<n chars>。
node scripts/probe-mimo-vision.ts                                   # 三个变体 + 模型列表（内嵌 64x64 JPEG 夹具）
node scripts/probe-mimo-vision.ts --only image_url-dataurl --image <某张.jpg>   # 换一张真图，只测接受的那种形状
node scripts/probe-mimo-vision.ts --model mimo-v2.6-pro             # 换模型
```

内嵌夹具是一张 **64×64 JPEG**（白底 + 一个红色圆盘 + 一个小蓝方块，一次性用 OpenCV 生成后压进脚本，
运行时不需要图像库）。提示词固定为「这张图里最主要的是什么颜色？只回答颜色两个字。」——
看到图应回答「红色」；**看不到图时它也会自信地猜**（见 §3 对照变体），这正是要防的失败模式。

## 1. 请求体形状与实测结果

端点 `POST https://api.xiaomimimo.com/v1/chat/completions`，认证头 `api-key`（值不打印）。
三个变体只改 `messages[0].content`，其余固定：`max_completion_tokens: 32`、`temperature: 0`、`thinking: {type:'disabled'}`、`stream: false`。

| 变体 | content 形状（打印时图像被摘要） | HTTP | 返回 |
|---|---|---|---|
| `image_url-dataurl` | `[{type:'text',text:'…'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,<2024 chars>'}}]` | **200** | `"红色"`；`usage.prompt_tokens_details.image_tokens = 9` |
| `image-source-base64` | `[{type:'text',…},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'<base64>'}}]` | **400** | `{"code":"400","message":"Invalid request parameters","param":"","type":"Bad Request"}` |
| `text-control`（对照） | 同一个提示词，**不带图**，content 是纯字符串 | 200 | `"蓝色"`（**错的**——没看图也照答） |

请求体（`image_url` 变体，实测原文，图像已摘要）：

```json
{"model":"mimo-v2.6-flash","messages":[{"role":"user","content":[{"type":"text","text":"这张图里最主要的是什么颜色？只回答颜色两个字。"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,<redacted image, 2047 chars>"}}]}],"max_completion_tokens":32,"temperature":0,"thinking":{"type":"disabled"},"stream":false}
```

关键点：返回里出现 **`image_tokens: 9`**——服务端确实把图当图像处理了，不只是把 base64 当字符串塞进上下文；
再加上**对照变体答错**（「蓝色」），可以排除「靠文本猜中」的解释。

## 2. 对哪个模型可用（同一张 64×64 夹具，同一个请求体）

| 模型 | HTTP | 结果 |
|---|---|---|
| `mimo-v2.6-flash`（项目默认） | **200** | `"红色"`，`image_tokens: 9` |
| `mimo-v2.6-pro` | **200** | `"红色"`，`image_tokens: 9` |
| `mimo-v2.5-pro` | **404** | `{"code":"404","message":"No endpoints found that support image input","param":"","type":""}` |

即**图像输入是模型级能力**，不是账号级：同一个密钥下 `mimo-v2.5-pro` 明确拒绝（错误文本就是上面那句，
可直接用来做能力探测的判据）。模型列表本身也印证了「没有专门的视觉模型 id」：

- `GET https://api.xiaomimimo.com/v1/models` → **200**，9 个 id：`mimo-v2.5`、`mimo-v2.5-asr`、`mimo-v2.5-pro`、
  `mimo-v2.5-tts`、`mimo-v2.5-tts-voiceclone`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed`。
- `GET https://api.xiaomimimo.com/models`（**不带 `/v1`**）→ **404**（openresty 的 404 HTML）。
  ⚠️ **这与 [`mimo-api-probe-2026-09-29.md`](mimo-api-probe-2026-09-29.md) §2 记录的情况相反**（那份记录说 `/v1/models` 是 404、
  只有 `/models` 是 200）。两者只差一天，值得单独核实：**现在能用的是 `/v1/models`**。

## 3. 成本：一张静帧值多少 token（本机合成图，同一提示词）

| 输入 | 图像内嵌字符数 | `image_tokens` | 该请求 `prompt_tokens` | 成功率 |
|---|---:|---:|---:|---|
| 64×64（内嵌夹具，2 KB） | 2 047 | **9** | 34 | 200，`"红色"` |
| 480×360（合成，47 KB） | 62 871 | **165** | 190 | 200，`"红色"` |
| 1280×720（合成，252 KB） | 335 495 | **880** | 905 | 200，`"红色"` |

480×360 与 1280×720 都落在 **约 1 token / 1024 像素**（≈ 0.00095 token/px）上；64×64 明显是**下限**（不是比例）。
按这个口径，一张 **480×360 的缩略静帧约 165 个图像 token**——相对一轮对话的上下文（工作记忆 + 提示词）是很小的增量；
代价主要在**隐私**（一帧房间画面）与**编码尺寸**（47 KB → base64 后 63 KB 的请求体），不在 token 费用。

## 4. 两条路径的取舍与推荐

| | A. 按需把一张缩略静帧上云 | B. 本地先转成文字再给模型 |
|---|---|---|
| 模型能看到 | 颜色/物体/大致场景，以及本地没写检测器的东西 | 只有本地检测器**已经写出来的**事实（在场、动作、亮度、运动量…） |
| 实测依据 | §1/§2/§3：`image_url` + base64 内联可用，480×360 ≈ 165 图像 token | 现成的 M6 感知边（`services/perception-edge/`）已产出 `presence.changed` 与 `world_state` 投影，不上云 |
| 隐私（铁律 6） | 需要**一次性、用户可感知**的例外；逐帧连续上传不可接受 | 图像不出本机，天然合规 |
| 确定性（铁律 1/3） | 模型看错/看糊无法预判，结论不可复现 | 判定由程序给出，可测、可回归 |
| 工程成本 | 需要改 `packages/model-adapters/src/mimo.ts`（`MimoMessage.content` 目前只允许 `string`）与一层「谁决定要图」的门禁 | 零接口改动，继续扩检测器即可 |

**推荐：默认走 B，A 作为「用户在场、单次、缩略、可感知」的按需能力。** 理由：

1. B 已经能覆盖「有人/没人、刚回来、动作幅度」这些**驱动主动开口**的判断，而铁律 6 明确要求连续音视频不上云、
   先本地过滤成事件再决定是否调用模型——**默认路径不该依赖把画面送出去**。
2. A 的价值是表达力，不是判定力：实测证明它真的能看见（`image_tokens` + 答对颜色 + 对照答错），
   因此在「用户主动问一句画面里的事」这类**单次**场景里值得开；但它必须由**程序**决定何时附带、
   由用户可见/可关，且**逐帧连续上传一律不做**（否则就是铁律 6 的违反）。
3. 成本不构成反对理由：480×360 约 165 图像 token，远小于为了写清同一场景所需的上下文开销；
   真正要盯的是隐私与「模型看错却说得像真的」这两点——所以配套要求是：帧不落盘（沿用控制台既有做法）、
   回答里不许把图像推断说成既定事实、并在事件里只记 `reason_code` 与分数（铁律 5）。

## 5. 本次只验证了什么 / 没验证什么

**验证了**

- `POST /v1/chat/completions` 接受 OpenAI 风格的 `content` 数组 + `image_url` **data URL（base64 内联）**，200 且真的处理图像。
- 另一种「猜的形状」（`{type:'image',source:{type:'base64',…}}`）被 400 拒绝，错误文本已记录。
- 模型级差异：`mimo-v2.6-flash`、`mimo-v2.6-pro` 可用；`mimo-v2.5-pro` 返回 404 `No endpoints found that support image input`。
- 不带图时模型会对同一张「不存在」的图自信作答（`"蓝色"`），即**不能把「模型回答了」当成「模型看见了」**。
- 图像 token 随像素数近似线性（约 1 token / 1024 像素），480×360 ≈ 165。
- 模型列表端点当前是 `/v1/models`（`/models` 现在 404，与 09-29 那份记录相反）。

**没验证（不要据此下结论）**

- **远程 `image_url`**（`https://…` 形式的图片 URL）：没测，不知道服务端是否代取；因此当前只按 base64 内联实现。
- 一张图之外的能力：多图同请求、图像 + 工具调用同时用、流式（`stream: true`）下的图像、`detail` 之类参数、图像尺寸/张数上限。
- 图像质量与识别能力本身：只测了一张纯色几何图（答对主色），**没有**测 OCR、小物体、暗光/模糊、真人场景，
  也没有测过真实摄像头帧（本次的 480×360 / 1280×720 都是本机合成图，只在 `%TEMP%` 里，未入库）。
- 生产接线：`packages/model-adapters` 的 `MimoMessage.content` 目前只接受 `string`，**图像路径尚未接入任何生产入口**；
  本报告只是「能不能用、怎么用」的依据，不含实现。
- 定价：只记录了 token 计数，没有把图像 token 折算成费用。
