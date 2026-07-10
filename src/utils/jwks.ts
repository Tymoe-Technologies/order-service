/**
 * JWKS (JSON Web Key Set) 工具
 * 用于从认证服务获取和缓存公钥
 */

import https from 'https';
import http from 'http';
import crypto from 'crypto';
import logger from './logger';

interface JWK {
  kty: string;
  use: string;
  kid: string;
  alg: string;
  n: string;
  e: string;
}

interface JWKS {
  keys: JWK[];
}

class JWKSClient {
  private publicKey: string | null = null;
  private lastFetch: number = 0;
  private readonly cacheDuration = 3600000; // 1小时缓存
  private readonly jwksUrl: string;

  constructor() {
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
    // JWKS 端点在根路径 /jwks.json
    this.jwksUrl = `${authServiceUrl}/jwks.json`;
    
    logger.info('JWKS client initialized', { jwksUrl: this.jwksUrl });
  }

  /**
   * 获取公钥 (带缓存)
   */
  async getPublicKey(): Promise<string> {
    const now = Date.now();

    // 如果缓存有效,直接返回
    if (this.publicKey && (now - this.lastFetch) < this.cacheDuration) {
      return this.publicKey;
    }

    // 否则重新获取
    try {
      logger.info('Fetching public key from JWKS endpoint', { url: this.jwksUrl });
      
      const jwks = await this.fetchJWKS(this.jwksUrl);

      if (!jwks.keys || jwks.keys.length === 0) {
        throw new Error('No keys found in JWKS');
      }

      // 获取第一个密钥
      const jwk = jwks.keys[0];

      // 转换 JWK 为 PEM 格式
      this.publicKey = this.jwkToPem(jwk);
      this.lastFetch = now;

      logger.info('Public key fetched successfully', {
        kid: jwk.kid,
        alg: jwk.alg,
      });

      return this.publicKey;
    } catch (error: any) {
      logger.error('Failed to fetch public key from JWKS', {
        url: this.jwksUrl,
        error: error.message,
      });

      // 如果有缓存的公钥,继续使用(即使过期)
      if (this.publicKey) {
        logger.warn('Using cached public key due to fetch failure');
        return this.publicKey;
      }

      throw new Error('Failed to fetch public key and no cached key available');
    }
  }

  /**
   * 使用 Node.js 内置模块获取 JWKS
   */
  private fetchJWKS(url: string): Promise<JWKS> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      
      const req = client.get(url, { timeout: 5000 }, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
              return;
            }
            const jwks = JSON.parse(data);
            resolve(jwks);
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
    });
  }

  /**
   * 将 JWK 转换为 PEM 格式
   */
  private jwkToPem(jwk: JWK): string {
    // Base64 URL 解码
    const nBuffer = Buffer.from(jwk.n, 'base64');
    const eBuffer = Buffer.from(jwk.e, 'base64');

    // 创建 RSA 公钥
    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: nBuffer.toString('base64'),
        e: eBuffer.toString('base64'),
      },
      format: 'jwk',
    });

    // 导出为 PEM 格式
    return publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.publicKey = null;
    this.lastFetch = 0;
    logger.info('JWKS cache cleared');
  }
}

// 单例
export const jwksClient = new JWKSClient();
