/**
 * The tool seam (§27).
 *
 * Tools are plain deterministic functions with a declared argument shape. The
 * model may *ask* for one; the program decides whether it exists, what it is
 * allowed to touch, and what the result is. Nothing here lets a model change
 * rules, permissions or state (§2.4, §41.4).
 *
 * PoC tool set — deliberately minimal and read-only:
 *   * `xixi_get_current_time` (L0, no arguments)
 *   * `xixi_get_weather`      (L1, read-only external)
 * No shell, no filesystem, no messaging, no high-risk actions exist yet (§27).
 */
import { WeatherClient } from '@xixi/model-adapters';

export interface XixiTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, passed to the provider verbatim. */
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
}

export interface ToolContext {
  /** IANA timezone for relative dates such as "明天". */
  readonly timezone: string;
  readonly now: Date;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

export function createCurrentTimeTool(now: () => Date = () => new Date()): XixiTool {
  return {
    name: 'xixi_get_current_time',
    description: '获取当前日期与时间。用户问“今天几号”“现在几点”时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const at = now();
      return {
        iso: at.toISOString(),
        localDate: at.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        weekday: at.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }),
      };
    },
  };
}

export interface WeatherToolOptions {
  readonly client?: WeatherClient;
  /** The household's usual place, so "明天天气" works without naming a city. */
  readonly defaultPlace: string;
  readonly now?: () => Date;
}

/**
 * Weather as a tool rather than as prompt context: the model asks only when the
 * conversation needs it, so most turns pay nothing for the capability.
 */
export function createWeatherTool(options: WeatherToolOptions): XixiTool {
  const client = options.client ?? new WeatherClient();
  const now = options.now ?? (() => new Date());
  return {
    name: 'xixi_get_weather',
    description:
      '查询某地今明后三天的天气。用户问天气时使用；没提地名就用默认地点。' +
      '返回结构化数据，请用自己的话简短转述，不要念 JSON。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '城市或地名，例如“成都”“镇上”。省略则用默认地点。' },
        day: { type: 'string', enum: ['today', 'tomorrow', 'day_after_tomorrow'], description: '要问哪一天，默认明天。' },
      },
      additionalProperties: false,
    },
    async execute(args, context) {
      const place = typeof args.place === 'string' && args.place.trim().length > 0 ? args.place.trim() : options.defaultPlace;
      const day = typeof args.day === 'string' ? args.day : 'tomorrow';
      const report = await client.report(place);
      const chosen = day === 'today' ? report.today : day === 'day_after_tomorrow' ? (report.days[2] ?? null) : report.tomorrow;
      if (chosen === null) return { place: report.place, error: '没有可用的预报' };
      const daysUntil = day === 'today' ? 0 : day === 'day_after_tomorrow' ? 2 : 1;
      return {
        place: report.place,
        day: day === 'today' ? '今天' : day === 'day_after_tomorrow' ? '后天' : '明天',
        date: chosen.date,
        summary: chosen.summary,
        temperatureMaxC: chosen.temperatureMaxC,
        temperatureMinC: chosen.temperatureMinC,
        precipitationChance: chosen.precipitationChance,
        // Enough context for a natural phrasing without dumping the payload.
        advice: chosen.precipitationChance !== null && chosen.precipitationChance >= 40 ? '可能下雨，建议带伞' : null,
        daysUntil,
        requestedAt: now().toISOString(),
        timezone: context.timezone,
      };
    },
  };
}

/** Default PoC registry. New tools join here and nowhere else. */
export function defaultTools(options: { readonly defaultPlace: string; readonly now?: () => Date }): XixiTool[] {
  return [createCurrentTimeTool(options.now), createWeatherTool({ defaultPlace: options.defaultPlace, now: options.now })];
}
