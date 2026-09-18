/**
 * 组织服务 - 从认证服务获取组织信息
 * 使用内部服务接口（X-Service-API-Key），无需用户 Bearer token
 */

import https from 'https';
import http from 'http';
import logger from '../utils/logger';

interface OrganizationInfo {
  id: string;
  orgName: string;
  orgType: string;
  parentOrgId?: string | null;
  status: string;
  location?: string;
  street?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  email?: string;
  timezone?: string | null;   // 门店 IANA 时区（如 America/Toronto）；auth-service 未配置时为 null
  subdomain?: string | null;
  customDomain?: string | null;
  themeSettings?: any;
}

class OrganizationService {
  private cache: Map<string, { data: OrganizationInfo; timestamp: number }> = new Map();
  // subdomain → orgId 反向索引缓存（轻量，避免每次解析都走 HTTP）
  private slugIndex: Map<string, { orgId: string; timestamp: number }> = new Map();
  private readonly cacheDuration = 300000; // 5分钟缓存

  /**
   * 获取组织信息
   * 使用内部服务接口调用 Auth Service，通过 X-Service-API-Key 认证
   */
  async getOrganization(orgId: string): Promise<OrganizationInfo | null> {
    // 检查缓存
    const cached = this.cache.get(orgId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.cacheDuration) {
      logger.debug('Using cached organization info', { orgId });
      return cached.data;
    }

    // 从 Auth Service 内部接口获取
    try {
      const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';
      // 使用内部服务接口，不需要用户认证
      const url = `${authServiceUrl}/api/auth-service/v1/internal/org/${orgId}`;
      const internalServiceKey = process.env.INTERNAL_SERVICE_KEY || '';

      logger.info('Fetching organization info via internal API', { orgId, url });

      const response = await this.fetchOrganization(url, internalServiceKey);

      if (response.success && response.data) {
        const orgInfo: OrganizationInfo = {
          id: response.data.orgId || orgId,
          orgName: response.data.orgName,
          orgType: response.data.orgType,
          parentOrgId: response.data.parentOrgId ?? null,
          status: response.data.status,
          location: response.data.location,
          street: response.data.street,
          city: response.data.city,
          province: response.data.province,
          postalCode: response.data.postalCode,
          country: response.data.country,
          latitude: response.data.latitude,
          longitude: response.data.longitude,
          phone: response.data.phone,
          email: response.data.email,
          timezone: response.data.timezone ?? null,
        };

        // 缓存结果
        this.cache.set(orgId, {
          data: orgInfo,
          timestamp: now,
        });

        logger.info('Organization info fetched successfully', { orgId, orgName: orgInfo.orgName });
        return orgInfo;
      }

      return null;
    } catch (error: any) {
      logger.error('Failed to fetch organization info', {
        orgId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * 通过 subdomain（或 UUID）解析主店组织信息
   * 用于 validateMerchantId 中间件：把 X-Merchant-Id 头里的 slug 翻译成真实 orgId
   * 缓存策略：subdomain → orgId 反向索引 + orgId → 完整对象，两层缓存共享 5 分钟 TTL
   */
  async resolveBySlug(slug: string): Promise<OrganizationInfo | null> {
    const now = Date.now();

    // 1. 命中 slug → orgId 反向索引，直接走 getOrganization 的缓存路径
    const indexed = this.slugIndex.get(slug);
    if (indexed && (now - indexed.timestamp) < this.cacheDuration) {
      const cached = this.cache.get(indexed.orgId);
      if (cached && (now - cached.timestamp) < this.cacheDuration) {
        logger.debug('Using cached org by slug', { slug, orgId: indexed.orgId });
        return cached.data;
      }
    }

    // 2. 调 auth-service internal 接口
    try {
      const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';
      const url = `${authServiceUrl}/api/auth-service/v1/internal/org/by-slug/${encodeURIComponent(slug)}`;
      const internalServiceKey = process.env.INTERNAL_SERVICE_KEY || '';

      logger.info('Resolving organization by slug', { slug, url });
      const response = await this.fetchOrganization(url, internalServiceKey);

      if (response.success && response.data) {
        const d = response.data;
        const orgInfo: OrganizationInfo = {
          id: d.orgId,
          orgName: d.orgName,
          orgType: d.orgType,
          parentOrgId: d.parentOrgId ?? null,
          status: d.status,
          timezone: d.timezone ?? null,
          subdomain: d.subdomain ?? null,
          customDomain: d.customDomain ?? null,
          themeSettings: d.themeSettings ?? null,
        };

        // 两层缓存都写入
        this.cache.set(orgInfo.id, { data: orgInfo, timestamp: now });
        this.slugIndex.set(slug, { orgId: orgInfo.id, timestamp: now });
        if (orgInfo.subdomain && orgInfo.subdomain !== slug) {
          this.slugIndex.set(orgInfo.subdomain, { orgId: orgInfo.id, timestamp: now });
        }

        logger.info('Resolved organization by slug', { slug, orgId: orgInfo.id, orgName: orgInfo.orgName });
        return orgInfo;
      }

      return null;
    } catch (error: any) {
      logger.error('Failed to resolve org by slug', { slug, error: error.message });
      return null;
    }
  }

  /**
   * 解析门店 IANA 时区（读时解析，不落库）
   * 返回 null 表示 auth-service 尚未配置时区，调用方据此回退到客户端本地时区。
   * 复用 getOrganization 的 5 分钟缓存，列表请求每租户仅一次 HTTP。
   */
  async getStoreTimezone(orgId: string): Promise<string | null> {
    try {
      const org = await this.getOrganization(orgId);
      return org?.timezone ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 使用内部服务 Key 调用 Auth Service 内部接口
   */
  private fetchOrganization(url: string, internalServiceKey: string): Promise<{ success: boolean; data?: any }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Service-API-Key': internalServiceKey,
      };

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'GET',
        headers,
        timeout: 5000,
      };

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const result = JSON.parse(data);
              resolve(result);
            } else if (res.statusCode === 404) {
              logger.warn('Organization not found', { url });
              resolve({ success: false });
            } else if (res.statusCode === 403) {
              logger.warn('Access denied to organization (check INTERNAL_SERVICE_KEY)', { url });
              resolve({ success: false });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * 这个 org 的**主店**（品牌）。分店返回 parentOrgId，主店返回自己。
   *
   * ⚠️ 这个答的是「品牌级**配置**挂在谁身上」。
   * 「会员算在谁名下」那份解析原来也在这个文件里（resolveMemberOrgId），
   * 已经删掉 —— 会员池的解析收到 member-service 内部去做了，
   * 散在调用方就会出现两套口径（见 events/handlers/member.handler 的说明）。
   *
   * 解析失败时退回自己：宁可当成独立店（各配各的），也不要把配置写串。
   */
  async resolveMainOrgId(orgId: string): Promise<string> {
    try {
      const info = await this.getOrganization(orgId);
      return info?.parentOrgId || orgId;
    } catch {
      return orgId;
    }
  }

  /**
   * 清除缓存
   */
  clearCache(orgId?: string): void {
    if (orgId) {
      this.cache.delete(orgId);
      // 同步清除指向该 orgId 的 slug 反向索引
      for (const [slug, idx] of this.slugIndex.entries()) {
        if (idx.orgId === orgId) this.slugIndex.delete(slug);
      }
      logger.info('Organization cache cleared', { orgId });
    } else {
      this.cache.clear();
      this.slugIndex.clear();
      logger.info('All organization cache cleared');
    }
  }
}

export default new OrganizationService();
