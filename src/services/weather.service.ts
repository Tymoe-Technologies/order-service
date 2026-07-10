/**
 * 天气服务
 * 通过 Open-Meteo（免费、无需 API key）按经纬度获取当前天气快照。
 *
 * 设计要点：
 * - 缓存：按"经纬度(2位小数) + 15分钟时间窗"缓存，避免同店大量订单重复调用。
 * - 降级：任何失败返回 null，绝不阻塞 / 抛错到订单主流程。
 * - 时区：timezone=auto 让 Open-Meteo 顺带返回门店 IANA 时区，复用于时间维度计算。
 * - 归一化：把 WMO weather_code 映射成固定枚举，避免自由文本碎类别。
 */

import axios from 'axios';
import logger from '../utils/logger';

// 与 Prisma enum WeatherCondition 保持一致
export type WeatherCondition =
  | 'CLEAR'
  | 'PARTLY_CLOUDY'
  | 'CLOUDY'
  | 'FOG'
  | 'DRIZZLE'
  | 'RAIN'
  | 'FREEZING_RAIN'
  | 'SNOW'
  | 'SLEET'
  | 'THUNDERSTORM'
  | 'HAIL'
  | 'WINDY'
  | 'UNKNOWN';

export interface WeatherSnapshot {
  condition: WeatherCondition;
  temp: number | null; // ℃
  feelsLike: number | null; // ℃
  humidity: number | null; // %
  precipMm: number | null; // mm
  windKph: number | null; // km/h
  cloudPct: number | null; // %
  isRaining: boolean;
  timezone: string; // IANA 时区（如 America/Toronto）
  source: string; // 'open-meteo'
  fetchedAt: Date;
  raw: any; // 原始 current 字段，落库到 weatherRaw
}

interface CacheEntry {
  data: WeatherSnapshot;
  timestamp: number;
}

const WEATHER_BASE_URL =
  process.env.WEATHER_API_URL || 'https://api.open-meteo.com/v1/forecast';
const CACHE_WINDOW_MS = 15 * 60 * 1000; // 15 分钟时间窗
const CACHE_TTL_MS = 30 * 60 * 1000; // 缓存最多保留 30 分钟
const REQUEST_TIMEOUT_MS = 5000;

/**
 * WMO weather_code → 归一化天气枚举
 * 参考 https://open-meteo.com/en/docs（WMO Weather interpretation codes）
 */
function mapWeatherCode(code: number): WeatherCondition {
  if (code === 0) return 'CLEAR';
  if (code === 1) return 'CLEAR';
  if (code === 2) return 'PARTLY_CLOUDY';
  if (code === 3) return 'CLOUDY';
  if (code === 45 || code === 48) return 'FOG';
  if (code >= 51 && code <= 55) return 'DRIZZLE';
  if (code === 56 || code === 57) return 'FREEZING_RAIN';
  if (code >= 61 && code <= 65) return 'RAIN';
  if (code === 66 || code === 67) return 'FREEZING_RAIN';
  if (code >= 71 && code <= 75) return 'SNOW';
  if (code === 77) return 'SNOW';
  if (code >= 80 && code <= 82) return 'RAIN';
  if (code === 85 || code === 86) return 'SNOW';
  if (code === 95) return 'THUNDERSTORM';
  if (code === 96 || code === 99) return 'HAIL';
  return 'UNKNOWN';
}

// 下雨判定：毛毛雨/雨/雷暴/阵雨
function resolveIsRaining(condition: WeatherCondition, precipMm: number | null): boolean {
  if (['DRIZZLE', 'RAIN', 'FREEZING_RAIN', 'THUNDERSTORM'].includes(condition)) return true;
  return (precipMm ?? 0) > 0;
}

class WeatherService {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * 生成缓存 key：经纬度取 2 位小数 + 15 分钟时间窗
   */
  private cacheKey(lat: number, lng: number): string {
    const window = Math.floor(Date.now() / CACHE_WINDOW_MS);
    return `${lat.toFixed(2)},${lng.toFixed(2)}:${window}`;
  }

  /**
   * 按经纬度获取当前天气快照；失败返回 null（不抛错）。
   */
  async getWeather(lat: number, lng: number): Promise<WeatherSnapshot | null> {
    const key = this.cacheKey(lat, lng);
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      logger.debug('[WeatherService] 命中缓存', { lat, lng });
      return cached.data;
    }

    try {
      const response = await axios.get(WEATHER_BASE_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        params: {
          latitude: lat,
          longitude: lng,
          current:
            'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m',
          timezone: 'auto',
        },
      });

      const data = response.data;
      const current = data?.current;
      if (!current) {
        logger.warn('[WeatherService] 响应无 current 字段', { lat, lng });
        return null;
      }

      const code = Number(current.weather_code);
      const condition = mapWeatherCode(code);
      const precipMm = current.precipitation ?? null;

      const snapshot: WeatherSnapshot = {
        condition,
        temp: current.temperature_2m ?? null,
        feelsLike: current.apparent_temperature ?? null,
        humidity: current.relative_humidity_2m ?? null,
        precipMm,
        windKph: current.wind_speed_10m ?? null,
        cloudPct: current.cloud_cover ?? null,
        isRaining: resolveIsRaining(condition, precipMm),
        timezone: data.timezone || 'UTC',
        source: 'open-meteo',
        fetchedAt: new Date(),
        raw: current,
      };

      this.cache.set(key, { data: snapshot, timestamp: now });
      this.pruneCache(now);

      logger.info('[WeatherService] 天气获取成功', {
        lat,
        lng,
        condition,
        temp: snapshot.temp,
      });
      return snapshot;
    } catch (error: any) {
      logger.warn('[WeatherService] 天气获取失败（降级为 null）', {
        lat,
        lng,
        error: error.message,
      });
      return null;
    }
  }

  // 清理过期缓存项，避免无限增长
  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp >= CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}

export default new WeatherService();
