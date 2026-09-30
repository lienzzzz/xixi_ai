// 西西 DSH 侧工具集：时间 + 天气。
//
// 为什么这个文件存在：走 `--dsh` 时工具由本插件注册，直连路径的
// `packages/brain-adapter/src/tools.ts` 不参与。审计结论是「DSH 路径没有天气工具」，
// 所以 `--dsh` 问天气时模型只能编造或回避。
//
// 权限边界（《方案》§27、铁律 7）：两个工具都是**只读**（L0 内部只读 + L1 外部只读），
// 参数封闭（additionalProperties: false 且执行前再校验一次），传入非法参数不是静默忽略
// 而是带错误的工具结果。写入类、外部通信类、高风险类工具一律后置。
//
// 数据源与直连路径完全一致：Open-Meteo（geocoding + forecast，无需密钥），
// 见 packages/model-adapters/src/weather.ts。这里重新实现一份而不是 import 包，
// 是因为插件是独立的 DSH 插件包（只有 peerDependency: dsh-tools），
// 而铁律 9 要求 Harness 相关代码不外泄；工具契约的一致性由
// tests/unit/core/plugin-tools.test.ts 与直连路径逐字段比对来保证。
import { readFileSync } from 'node:fs';

import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'xixi-tools';
export const inject = ['tools'];

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 3;
const FORECAST_DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';

/** WMO 天气码 → 中文口语（与直连路径同一张表）。 */
const WMO_ZH = {
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴冰雹',
};

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function describeWeatherCode(code) {
  if (typeof code !== 'number') return '天气不明';
  return WMO_ZH[code] ?? `未知天气(${code})`;
}

/** 模型可以传的参数：封闭集合，缺省即默认地点 / 明天。 */
export const WEATHER_PARAMETER_SPEC = {
  place: { type: 'string', description: '城市或地名，例如“成都”。省略则用配置里的默认地点。' },
  day: {
    type: 'string',
    enum: ['today', 'tomorrow', 'day_after_tomorrow'],
    description: '要问哪一天，默认明天。',
  },
};

const WEATHER_PARAMETERS = {
  type: 'object',
  properties: WEATHER_PARAMETER_SPEC,
  additionalProperties: false,
};

const WEATHER_DAY_VALUES = {
  day: { type: 'string' },
  date: { type: 'string' },
  summary: { type: 'string' },
  temperatureMaxC: { type: 'number' },
  temperatureMinC: { type: 'number' },
  precipitationChance: { oneOf: [{ type: 'number' }, { type: 'null' }] },
  advice: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  daysUntil: { type: 'number' },
  requestedAt: { type: 'string' },
  timezone: { type: 'string' },
};

// Two exact shapes (success / refusal). `required` is not allowed inside a
// `oneOf` branch, so the fields are declared optional here and the branch
// discriminator is `error` itself: a refusal can never be rendered as a forecast.
const WEATHER_OK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    place: { type: 'string' },
    ...WEATHER_DAY_VALUES,
    error: { type: 'null' },
  },
};

const WEATHER_ERROR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    place: { type: 'string' },
    error: { type: 'string' },
  },
};

const DAY_LABELS = { today: '今天', tomorrow: '明天', day_after_tomorrow: '后天' };
const DAY_INDEX = { today: 0, tomorrow: 1, day_after_tomorrow: 2 };
const DAY_OFFSET = { today: 0, tomorrow: 1, day_after_tomorrow: 2 };

/** 只读天气客户端，行为与 packages/model-adapters/src/weather.ts 对齐（含 30 分钟缓存）。 */
export class WeatherClient {
  #fetchImpl;
  #timeoutMs;
  #cache = new Map();

  constructor(options = {}) {
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async #getJson(url) {
    let response;
    try {
      response = await this.#fetchImpl(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (cause) {
      throw new Error(`天气服务不可达：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!response.ok) throw new Error(`天气服务拒绝了请求（HTTP ${response.status}）`);
    return await response.json();
  }

  /** 今明后三天的预报；同一地名 30 分钟内复用缓存。 */
  async report(place, cacheMs = 30 * 60_000) {
    const key = String(place).trim();
    const cached = this.#cache.get(key);
    if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.report;

    const geocoded = await this.#getJson(
      `${GEOCODE_URL}?name=${encodeURIComponent(key)}&count=1&language=zh&format=json`,
    );
    const hit = geocoded?.results?.[0];
    if (hit?.latitude === undefined || hit.longitude === undefined) {
      throw new Error(`不认识的地名：${place}`);
    }

    const forecast = await this.#getJson(
      `${FORECAST_URL}?latitude=${hit.latitude}&longitude=${hit.longitude}` +
        `&daily=${FORECAST_DAILY}&forecast_days=${FORECAST_DAYS}&timezone=Asia%2FShanghai`,
    );

    const daily = forecast?.daily ?? {};
    const days = (daily.time ?? []).map((date, index) => {
      const parsed = new Date(`${date}T12:00:00+08:00`);
      return {
        date,
        weekday: WEEKDAYS_ZH[parsed.getUTCDay()] ?? '',
        summary: describeWeatherCode(daily.weather_code?.[index] ?? null),
        temperatureMaxC: Math.round(daily.temperature_2m_max?.[index] ?? 0),
        temperatureMinC: Math.round(daily.temperature_2m_min?.[index] ?? 0),
        precipitationChance: daily.precipitation_probability_max?.[index] ?? null,
      };
    });

    const report = {
      place: [hit.name, hit.admin1].filter((part) => typeof part === 'string' && part.length > 0).join(' '),
      timezone: forecast?.timezone ?? hit.timezone ?? 'Asia/Shanghai',
      days,
      today: days[0] ?? null,
      tomorrow: days[1] ?? null,
    };
    this.#cache.set(key, { at: Date.now(), report });
    return report;
  }
}

/**
 * One client per plugin installation, so the 30-minute cache lives as long as the
 * harness profile does (the direct path keeps the same lifetime by constructing
 * the tool once). `WeakMap` instead of a module-level singleton keeps two
 * installations from sharing a cache.
 */
const WEATHER_CLIENTS = new WeakMap();
export function weatherClientFor(owner) {
  const key = owner ?? WEATHER_CLIENTS;
  let client = WEATHER_CLIENTS.get(key);
  if (client === undefined) {
    client = new WeatherClient();
    WEATHER_CLIENTS.set(key, client);
  }
  return client;
}

/**
 * 默认地点：与直连路径同一来源（`config/xixi.yaml` 的 `identity.place`，缺失时用
 * `config/xixi.example.yaml`）。这里不用 js-yaml —— 插件包只有一个 peerDependency，
 * 读一行标量不值得引入解析器；读不到就诚实返回空串，让工具请用户说地名。
 */
export function resolveDefaultPlace(env = process.env, readFile = readFileSync) {
  const fromEnv = typeof env.XIXI_PLACE === 'string' ? env.XIXI_PLACE.trim() : '';
  if (fromEnv.length > 0) return fromEnv;

  const root = env.XIXI_REPO_ROOT ?? process.cwd();
  for (const relative of ['config/xixi.yaml', 'config/xixi.example.yaml']) {
    let text;
    try {
      text = readFile(`${root}/${relative}`);
    } catch {
      continue;
    }
    const match = /^\s*place:\s*("?)([^"\r\n#]+)\1/m.exec(text);
    const value = match?.[2]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return '';
}

function requestedDay(report, day) {
  if (day === 'today') return report.today;
  if (day === 'day_after_tomorrow') return report.days[2] ?? null;
  return report.tomorrow;
}

function registerCurrentTime(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'xixi_get_current_time',
      description: 'Return the current time as an ISO-8601 timestamp. Takes no arguments.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            iso: { type: 'string', required: true, description: 'Current time in ISO-8601 format.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.iso }],
      },
      async execute() {
        return { iso: new Date().toISOString() };
      },
    }),
  );
}

export function registerWeather(ctx) {
  const client = weatherClientFor(ctx);
  ctx.tools.register(
    defineTool({
      name: 'xixi_get_weather',
      description:
        '查询某地今明后三天的天气（只读，Open-Meteo）。用户问天气时使用；没提地名就用默认地点。' +
        '返回结构化数据，请用自己的话简短转述，不要念 JSON。',
      parameters: WEATHER_PARAMETER_SPEC,
      output: {
        // Two exact shapes (success / refusal), so a failure can never be
        // rendered as if it were a forecast.
        schema: { oneOf: [WEATHER_OK_OUTPUT, WEATHER_ERROR_OUTPUT] },
        render: (_args, value) => {
          if (typeof value.error === 'string') return [{ type: 'text', text: value.error }];
          return [
            {
              type: 'text',
              text: `${value.place} ${value.day}：${value.summary}，${value.temperatureMinC}~${value.temperatureMaxC}℃`,
            },
          ];
        },
      },
      async execute(args) {
        // The registry does not enforce `additionalProperties: false` on an
        // implicit parameter root (verified against dsh-tools 0.1.7-rc.2), so the
        // closed contract is re-checked here before anything touches the network.
        const rejection = rejectUnknownArguments(args);
        if (rejection !== null) return { place: '', error: rejection };

        const place = typeof args.place === 'string' && args.place.trim().length > 0 ? args.place.trim() : resolveDefaultPlace();
        if (place.length === 0) {
          return {
            place: '',
            error: '不知道你常说的地名，请先告诉我是哪个城市（例如“成都”），或设置 config/xixi.yaml 的 identity.place。',
          };
        }
        const day = typeof args.day === 'string' && args.day in DAY_LABELS ? args.day : 'tomorrow';

        let report;
        try {
          report = await client.report(place);
        } catch (cause) {
          return { place, error: cause instanceof Error ? cause.message : String(cause) };
        }

        const chosen = requestedDay(report, day);
        if (chosen === null) return { place: report.place, error: '没有可用的预报' };
        return {
          place: report.place,
          day: DAY_LABELS[day],
          date: chosen.date,
          summary: chosen.summary,
          temperatureMaxC: chosen.temperatureMaxC,
          temperatureMinC: chosen.temperatureMinC,
          precipitationChance: chosen.precipitationChance,
          // Enough for a natural phrasing without dumping the payload.
          advice:
            chosen.precipitationChance !== null && chosen.precipitationChance >= 40 ? '可能下雨，建议带伞' : null,
          daysUntil: DAY_OFFSET[day],
          requestedAt: new Date().toISOString(),
          timezone: report.timezone,
        };
      },
    }),
  );
}

/** 封闭参数的运行时校验：返回第一个问题，或 null。 */
export function rejectUnknownArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '参数必须是对象。';
  const allowed = Object.keys(WEATHER_PARAMETER_SPEC);
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return `不认识的参数「${key}」；本工具只接受 ${allowed.join('、')}。`;
  }
  if (args.day !== undefined && !(typeof args.day === 'string' && args.day in DAY_LABELS)) {
    return 'day 只能是 today / tomorrow / day_after_tomorrow。';
  }
  if (args.place !== undefined && typeof args.place !== 'string') return 'place 必须是字符串。';
  return null;
}

/** 供测试断言「DSH 侧契约与直连侧一致」的原始参数 schema。 */
export const XIXI_WEATHER_PARAMETERS = WEATHER_PARAMETERS;

export function apply(ctx) {
  registerCurrentTime(ctx);
  registerWeather(ctx);
}
