/**
 * The tool seam (§27) and the pack's Phase 2 built-in tool set.
 *
 * Tools are plain deterministic functions with a declared argument shape. The
 * model may *ask* for one; the program decides whether it exists, what it is
 * allowed to touch, and what the result is. Nothing here lets a model change
 * rules, permissions or state (§2.4, §41.4).
 *
 * Phase 2 set — three built-ins:
 *   * `xixi_get_current_time`  (read)   — local date/time/weekday
 *   * `xixi_get_weather`       (read)   — short forecast from the weather client
 *   * `xixi_set_reminder`      (write)  — records a reminder
 *
 * V0.3 P2-D removed the fourth one, `xixi_news_stub`: news is a **plugin** now
 * (`@xixi/plugins/news` contributes `news.search` / `news.latest` / `news.for_interests`), so this
 * package no longer carries a news seam at all. The `xixi_` namespace is the core's own
 * (`RESERVED_TOOL_PREFIXES`), and a news tool belongs to the plugin that owns the provider.
 *
 * `risk` and `scopes` are the program's own metadata: `ToolRegistry` (see
 * `tool-registry.ts`) filters what the model may even see, and re-checks before
 * executing. No shell, no filesystem, no messaging, no high-risk actions (§27).
 */
import { WeatherClient } from '@xixi/model-adapters';

/** How much damage a tool could do if misused (`dangerous` is refused in the PoC, 铁律 7). */
export type ToolRisk = 'read' | 'write' | 'dangerous';

/** Which agent-facing surface a tool belongs to (the pack's `AgentScope`). */
export type AgentScope = 'conversation' | 'proactive' | 'admin' | 'guest';

export interface XixiTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, passed to the provider verbatim. */
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
}

/**
 * A tool with the program-owned metadata the registry needs. Argument shapes stay
 * closed (`additionalProperties: false`): an undeclared argument is refused, never
 * silently ignored.
 */
export interface AgentTool extends XixiTool {
  readonly risk: ToolRisk;
  /** Surfaces this tool is declared for; the permission policy can narrow it further. */
  readonly scopes: readonly AgentScope[];
  /** Hard ceiling for one execution; the executor contains a hang as a failed call. */
  readonly timeoutMs?: number;
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

/** Everything a conversation turn may reach; `proactive`/`admin`/`guest` are narrower. */
const CONVERSATION_SCOPES: readonly AgentScope[] = ['conversation', 'proactive', 'admin'];
const READ_EVERYWHERE: readonly AgentScope[] = ['conversation', 'proactive', 'admin', 'guest'];
/** A reminder is a *write*: not while she is talking to herself, not for a guest. */
const WRITE_SCOPES: readonly AgentScope[] = ['conversation', 'admin'];

export function createCurrentTimeTool(now: () => Date = () => new Date()): AgentTool {
  return {
    name: 'xixi_get_current_time',
    description: '获取当前日期与时间。用户问“今天几号”“现在几点”时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    scopes: READ_EVERYWHERE,
    async execute(_args, context) {
      const at = now();
      const timezone = context.timezone;
      return {
        iso: at.toISOString(),
        localDate: at.toLocaleDateString('zh-CN', { timeZone: timezone }),
        weekday: at.toLocaleDateString('zh-CN', { timeZone: timezone, weekday: 'long' }),
        localTime: at.toLocaleTimeString('zh-CN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }),
        timezone,
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
export function createWeatherTool(options: WeatherToolOptions): AgentTool {
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
    risk: 'read',
    scopes: CONVERSATION_SCOPES,
    timeoutMs: 20_000,
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

// ------------------------------------------------------------------------ reminder

export interface ScheduledReminder {
  readonly id: string;
  readonly what: string;
  readonly when: string;
  readonly recordedAt: string;
}

/**
 * Where `xixi_set_reminder` puts a reminder. The default here is in-process
 * ({@link createMemoryReminderSink}); a deployment that wants the reminder to survive a restart wires
 * the durable one instead (`DurableReminderSink` in `@xixi/runtime`, backed by the `reminders` table).
 */
export interface ReminderSink {
  schedule(input: { readonly what: string; readonly when: string; readonly recordedAt: string }): Promise<ScheduledReminder> | ScheduledReminder;
}

export interface ReminderToolOptions {
  readonly sink?: ReminderSink;
  readonly now?: () => Date;
}

/** The default sink: in-memory only. Nothing is persisted and nothing rings yet. */
export function createMemoryReminderSink(): ReminderSink & { readonly reminders: readonly ScheduledReminder[] } {
  const reminders: ScheduledReminder[] = [];
  return {
    reminders,
    schedule(input) {
      const reminder: ScheduledReminder = { id: `rem_${reminders.length + 1}`, what: input.what, when: input.when, recordedAt: input.recordedAt };
      reminders.push(reminder);
      return reminder;
    },
  };
}

/**
 * `xixi_set_reminder` — the one *write* tool: the first one in the PoC, so it is the one the
 * permission policy has to narrow (resident only, conversation/admin scope, never for a guest,
 * never while she is talking to herself).
 *
 * V0.3 P2.5-E renamed it from `xixi_set_reminder_stub`: the `_stub` suffix and the return text that
 * admitted 「到点不会自动响」 both described the in-process sink, and both stopped being true once the
 * durable sink and the scheduler landed. There is **no** compatibility alias — a second registration
 * of the same capability under the old name would be exactly the two-names-for-one-thing the rename
 * is meant to end.
 */
export function createReminderTool(options: ReminderToolOptions = {}): AgentTool {
  const sink = options.sink ?? createMemoryReminderSink();
  const now = options.now ?? (() => new Date());
  return {
    name: 'xixi_set_reminder',
    description: '帮用户记一件事，到点提醒。用户说“提醒我……”时使用。记下后用自己的话说一声就好，不要念字段名。',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: '要提醒什么，例如“吃药”“给儿子打电话”。' },
        when: { type: 'string', description: '什么时候提醒，例如“晚上七点”“明天早上”。没说就写“尽快”。' },
      },
      required: ['what'],
      additionalProperties: false,
    },
    risk: 'write',
    scopes: WRITE_SCOPES,
    timeoutMs: 5_000,
    async execute(args) {
      const what = typeof args.what === 'string' ? args.what.trim() : '';
      if (what.length === 0) return { registered: false, error: '要提醒什么还不清楚' };
      const when = typeof args.when === 'string' && args.when.trim().length > 0 ? args.when.trim() : '尽快';
      const recordedAt = now().toISOString();
      const reminder = await sink.schedule({ what, when, recordedAt });
      return { registered: true, id: reminder.id, what: reminder.what, when: reminder.when, recordedAt, note: '已经记下' };
    },
  };
}

/** Options for the built-in set; every data source is injectable for offline tests. */
export interface DefaultToolsOptions {
  readonly defaultPlace: string;
  readonly now?: () => Date;
  readonly weatherClient?: WeatherClient;
  readonly reminderSink?: ReminderSink;
}

/** The three Phase 2 built-ins. New tools join here and nowhere else. */
export function defaultTools(options: DefaultToolsOptions): AgentTool[] {
  return [
    createCurrentTimeTool(options.now),
    createWeatherTool({
      defaultPlace: options.defaultPlace,
      ...(options.weatherClient === undefined ? {} : { client: options.weatherClient }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    createReminderTool({ ...(options.reminderSink === undefined ? {} : { sink: options.reminderSink }), ...(options.now === undefined ? {} : { now: options.now }) }),
  ];
}

/**
 * Accept a tool that predates the registry. A caller that hands in a bare `XixiTool`
 * gets read-only, conversation-scope semantics — the narrowest useful default.
 */
export function asAgentTool(tool: XixiTool | AgentTool): AgentTool {
  if ('risk' in tool && 'scopes' in tool) return tool as AgentTool;
  return {
    ...tool,
    risk: 'read',
    scopes: ['conversation'],
  };
}
