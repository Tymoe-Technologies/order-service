/**
 * 地理编码服务
 * 把门店地址（城市/省份/国家）换算成经纬度，供天气服务使用。
 *
 * 设计要点：
 * - 优先使用 org 已有的经纬度；缺失时才用地址做地理编码。
 * - 数据源：Open-Meteo Geocoding（免费、无需 key），城市级精度对天气足够。
 * - 缓存：地址几乎不变，按"城市|省|国家"长期缓存（默认 7 天），避免重复请求。
 * - 降级：任何失败返回 null，不抛错。
 */

import axios from 'axios';
import logger from '../utils/logger';

const GEOCODING_URL =
  process.env.GEOCODING_API_URL || 'https://geocoding-api.open-meteo.com/v1/search';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const REQUEST_TIMEOUT_MS = 5000;

export interface Coordinates {
  lat: number;
  lng: number;
}

// 门店地址（取自 OrganizationInfo 的子集）
export interface AddressInput {
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  location?: string | null;
}

interface CacheEntry {
  data: Coordinates | null; // null 也缓存，避免反复请求无法解析的地址
  timestamp: number;
}

class GeoService {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * 解析门店坐标：优先 org 自带经纬度，否则按地址地理编码。
   * 解析不出返回 null。
   */
  async resolveCoordinates(addr: AddressInput): Promise<Coordinates | null> {
    // 1. org 已有经纬度，直接用
    if (addr.latitude != null && addr.longitude != null) {
      return { lat: addr.latitude, lng: addr.longitude };
    }

    // 2. 用地址地理编码（城市级）
    const place = addr.city || addr.location;
    if (!place) {
      logger.debug('[GeoService] 无城市/地点信息，无法地理编码');
      return null;
    }

    const key = [place, addr.province, addr.country]
      .filter(Boolean)
      .join('|')
      .toLowerCase();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    const coords = await this.geocode(place, addr.province, addr.country);
    this.cache.set(key, { data: coords, timestamp: now });
    return coords;
  }

  /**
   * 调 Open-Meteo Geocoding 解析城市坐标；失败返回 null。
   * 多个候选时，优先匹配 country / province 的结果。
   */
  private async geocode(
    place: string,
    province?: string | null,
    country?: string | null
  ): Promise<Coordinates | null> {
    try {
      const response = await axios.get(GEOCODING_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        params: { name: place, count: 10, language: 'en', format: 'json' },
      });

      const results: any[] = response.data?.results || [];
      if (results.length === 0) {
        logger.warn('[GeoService] 地理编码无结果', { place, province, country });
        return null;
      }

      const best = this.pickBest(results, province, country);
      logger.info('[GeoService] 地理编码成功', {
        place,
        matched: best.name,
        admin1: best.admin1,
        country: best.country,
      });
      return { lat: best.latitude, lng: best.longitude };
    } catch (error: any) {
      logger.warn('[GeoService] 地理编码失败（降级为 null）', {
        place,
        error: error.message,
      });
      return null;
    }
  }

  // 在候选结果中选最匹配的：国家匹配优先，其次省份匹配，否则取第一个
  private pickBest(results: any[], province?: string | null, country?: string | null): any {
    const norm = (s?: string | null) => (s || '').trim().toLowerCase();
    const wantCountry = norm(country);
    const wantProvince = norm(province);

    const matches = (r: any) => {
      const countryOk =
        !wantCountry ||
        norm(r.country) === wantCountry ||
        norm(r.country_code) === wantCountry;
      const provinceOk = !wantProvince || norm(r.admin1) === wantProvince;
      return { countryOk, provinceOk };
    };

    // 国家 + 省份都匹配
    const exact = results.find((r) => {
      const m = matches(r);
      return m.countryOk && m.provinceOk;
    });
    if (exact) return exact;

    // 仅国家匹配
    const byCountry = results.find((r) => matches(r).countryOk);
    if (byCountry) return byCountry;

    return results[0];
  }
}

export default new GeoService();
