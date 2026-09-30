import { ModelError } from './errors.ts';

/**
 * Keyless weather client (Open-Meteo).
 *
 * Why this source: 《方案》§27 lists `get_weather` in the minimum tool set, and a
 * companion that cannot answer "明天天气怎么样？" deflects on one of the most common
 * household questions — the first conversation evaluation flagged exactly that.
 * Open-Meteo needs no API key, so there is no new secret to manage (§20.4).
 *
 * Everything here is read-only (permission level L1, §19.2) and returns a small
 * structured result the model can phrase; the model never sees the raw payload.
 */

export interface WeatherDay {
  readonly date: string;
  readonly weekday: string;
  readonly summary: string;
  readonly temperatureMaxC: number;
  readonly temperatureMinC: number;
  readonly precipitationChance: number | null;
}

export interface WeatherReport {
  readonly place: string;
  readonly timezone: string;
  readonly days: readonly WeatherDay[];
  readonly today: WeatherDay | null;
  readonly tomorrow: WeatherDay | null;
}

export interface WeatherClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly geocodeUrl?: string;
  readonly forecastUrl?: string;
}

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO weather codes, phrased the way a person would say them in Chinese. */
const WMO_ZH: Record<number, string> = {
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

export function describeWeatherCode(code: number | null): string {
  if (code === null) return '天气不明';
  return WMO_ZH[code] ?? `未知天气(${code})`;
}

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface GeocodeResponse {
  results?: { name?: string; latitude?: number; longitude?: number; timezone?: string; admin1?: string }[];
}

interface ForecastResponse {
  timezone?: string;
  daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
}

export class WeatherClient {
  #fetch: typeof fetch;
  #timeoutMs: number;
  #geocodeUrl: string;
  #forecastUrl: string;
  #cache = new Map<string, { at: number; report: WeatherReport }>();

  constructor(options: WeatherClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#geocodeUrl = options.geocodeUrl ?? GEOCODE_URL;
    this.#forecastUrl = options.forecastUrl ?? FORECAST_URL;
  }

  async #getJson<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (cause) {
      throw new ModelError('NETWORK', 'weather service is unreachable', {
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!response.ok) {
      throw new ModelError(response.status === 400 ? 'BAD_REQUEST' : 'PROVIDER', 'weather service refused the request', {
        status: response.status,
      });
    }
    return (await response.json()) as T;
  }

  /**
   * Forecast for a place name. Cached for 30 minutes: a household asks about the
   * same town repeatedly, and re-asking upstream each time is both slow and rude.
   */
  async report(place: string, cacheMs = 30 * 60_000): Promise<WeatherReport> {
    const key = place.trim();
    const cached = this.#cache.get(key);
    if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.report;

    const geocoded = await this.#getJson<GeocodeResponse>(
      `${this.#geocodeUrl}?name=${encodeURIComponent(key)}&count=1&language=zh&format=json`,
    );
    const hit = geocoded.results?.[0];
    if (hit?.latitude === undefined || hit.longitude === undefined) {
      throw new ModelError('BAD_REQUEST', `unknown place: ${place}`);
    }

    const forecast = await this.#getJson<ForecastResponse>(
      `${this.#forecastUrl}?latitude=${hit.latitude}&longitude=${hit.longitude}` +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&forecast_days=3&timezone=Asia%2FShanghai',
    );

    const daily = forecast.daily;
    const days: WeatherDay[] = (daily?.time ?? []).map((date, index) => {
      const parsed = new Date(`${date}T12:00:00+08:00`);
      return {
        date,
        weekday: WEEKDAYS_ZH[parsed.getUTCDay()] ?? '',
        summary: describeWeatherCode(daily?.weather_code?.[index] ?? null),
        temperatureMaxC: Math.round(daily?.temperature_2m_max?.[index] ?? 0),
        temperatureMinC: Math.round(daily?.temperature_2m_min?.[index] ?? 0),
        precipitationChance: daily?.precipitation_probability_max?.[index] ?? null,
      };
    });

    const report: WeatherReport = {
      place: [hit.name, hit.admin1].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' '),
      timezone: forecast.timezone ?? hit.timezone ?? 'Asia/Shanghai',
      days,
      today: days[0] ?? null,
      tomorrow: days[1] ?? null,
    };
    this.#cache.set(key, { at: Date.now(), report });
    return report;
  }
}
