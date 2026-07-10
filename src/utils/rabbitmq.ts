/**
 * RabbitMQ 连接管理（使用 amqp-connection-manager）
 * 提供生产级别的自动重连机制
 *
 * amqp-connection-manager 特性：
 * - 自动重连（使用指数退避）
 * - 消息缓冲（断开连接时缓冲消息）
 * - 连接池支持
 * - 防止重复声明资源（Exchange, Queue）
 */

import amqplib from 'amqplib';
import amqpConnectionManager, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import logger from './logger';

interface RabbitMQConfig {
  url: string;
  exchange: string;
  queue: string;
  routingKey: string;
  prefetch?: number;
}

class RabbitMQConnection {
  private connectionManager: AmqpConnectionManager | null = null;
  private channelWrapper: ChannelWrapper | null = null;
  private config: RabbitMQConfig;

  constructor(config: RabbitMQConfig) {
    this.config = {
      prefetch: 1,
      ...config,
    };
  }

  /**
   * 连接到 RabbitMQ（使用 amqp-connection-manager）
   */
  async connect(): Promise<void> {
    try {
      logger.info('正在连接 RabbitMQ...', {
        url: this.config.url,
        queue: this.config.queue,
      });

      // 创建连接管理器
      // amqp-connection-manager 会自动处理重连
      this.connectionManager = amqpConnectionManager.connect(
        [this.config.url],
        {
          findServers: () => [this.config.url],
          // 连接选项（重连会由连接管理器自动处理）
        }
      );

      // 设置连接事件监听
      this.setupConnectionListeners();

      // 创建通道包装器（自动处理通道重创）
      this.channelWrapper = this.connectionManager.createChannel({
        setup: async (channel: amqplib.Channel) => {
          logger.info('通道已创建，声明资源...', {
            queue: this.config.queue,
          });

          // 设置预取数量
          await channel.prefetch(this.config.prefetch || 1);

          // 声明交换机
          await channel.assertExchange(
            this.config.exchange,
            'topic',
            { durable: true }
          );

          // 声明队列
          await channel.assertQueue(this.config.queue, {
            durable: true,
          });

          // 绑定队列到交换机
          await channel.bindQueue(
            this.config.queue,
            this.config.exchange,
            this.config.routingKey
          );

          logger.info('✅ RabbitMQ 资源已声明', {
            queue: this.config.queue,
            exchange: this.config.exchange,
            routingKey: this.config.routingKey,
          });
        },
      });

      // 等待通道就绪（设置超时时间）
      const connectTimeout = 10000; // 10 秒超时
      await Promise.race([
        this.channelWrapper.waitForConnect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RabbitMQ 连接超时')), connectTimeout)
        )
      ]);

      logger.info('✅ RabbitMQ 连接成功并已就绪', {
        queue: this.config.queue,
        exchange: this.config.exchange,
      });
    } catch (error: any) {
      // 详细的错误日志
      const errorInfo: any = {
        errorType: error?.constructor?.name || typeof error,
        errorMessage: error?.message || String(error),
      };

      // 添加更多调试信息
      if (error instanceof Error) {
        errorInfo.stack = error.stack;
      } else if (error && typeof error === 'object') {
        errorInfo.fullError = JSON.stringify(error, null, 2);
      }

      logger.error('❌ RabbitMQ 连接失败', errorInfo);
      
      // 连接失败时关闭连接管理器，防止后台持续重试
      if (this.connectionManager) {
        try {
          await this.connectionManager.close();
          this.connectionManager = null;
          this.channelWrapper = null;
        } catch (closeError) {
          // 忽略关闭错误
        }
      }
      
      throw error;
    }
  }

  /**
   * 设置连接事件监听
   */
  private setupConnectionListeners(): void {
    if (!this.connectionManager) return;

    // 连接建立时
    this.connectionManager.on('connect', () => {
      logger.info('🔗 RabbitMQ 连接已建立');
    });

    // 连接断开时
    this.connectionManager.on('disconnect', (params: any) => {
      logger.warn('🔌 RabbitMQ 连接已断开', {
        error: params.err?.message || 'Unknown error',
      });
      // amqp-connection-manager 会自动重连
    });

    // 连接错误时
    this.connectionManager.on('connectFailed', (params: any) => {
      logger.error('❌ RabbitMQ 连接失败', {
        error: params.err?.message || 'Unknown error',
        attempt: params.attempt || 0,
      });
    });

    // 通道错误时
    this.connectionManager.on('channelError', (params: any) => {
      logger.error('❌ RabbitMQ 通道错误', {
        error: params.err?.message || 'Unknown error',
      });
    });
  }

  /**
   * 获取通道包装器
   */
  getChannelWrapper(): ChannelWrapper {
    if (!this.channelWrapper) {
      throw new Error('RabbitMQ 通道未初始化');
    }
    return this.channelWrapper;
  }

  /**
   * 消费消息
   * amqp-connection-manager 会自动处理重连后重新声明消费者
   */
  async consume(
    onMessage: (message: any) => Promise<void>,
    onError?: (error: Error) => Promise<void>
  ): Promise<void> {
    try {
      const channelWrapper = this.getChannelWrapper();

      // 使用 addSetup 添加消费者
      // amqp-connection-manager 会在重连后自动重新设置
      await channelWrapper.addSetup(async (channel: amqplib.Channel) => {
        logger.info('设置消息消费者...');

        await channel.consume(
          this.config.queue,
          async (msg) => {
            if (!msg) return;

            let message: any = null;
            try {
              const content = msg.content.toString();
              message = JSON.parse(content);

              logger.info('📨 收到 RabbitMQ 消息', {
                queue: this.config.queue,
                messageType: message.type,
                correlationId: message.correlationId,
              });

              // 调用消息处理器
              await onMessage(message);

              // 确认消息（消费成功）
              channel.ack(msg);

              logger.debug('✅ 消息已确认', {
                correlationId: message.correlationId,
              });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';

              logger.error('❌ 处理消息失败', {
                error: errorMessage,
                correlationId: message?.correlationId,
                stack: error instanceof Error ? error.stack : undefined,
              });

              // 调用错误处理器
              if (onError) {
                await onError(error as Error);
              }

              // 获取重试次数（从消息头中）
              const retryCount = (msg.properties?.headers?.['x-retry-count'] as number) || 0;
              const maxRetries = 3; // 最多重试 3 次

              // 判断是否应该重试
              const shouldRetry =
                retryCount < maxRetries &&
                // 对于 UUID 验证错误或格式错误，不重试
                !errorMessage.includes('invalid character') &&
                !errorMessage.includes('Error creating UUID') &&
                !errorMessage.includes('Inconsistent column data');

              if (shouldRetry) {
                channel.nack(msg, false, true);
                logger.info('消息已重新放入队列，等待重试', {
                  retryCount: retryCount + 1,
                  maxRetries,
                  correlationId: message?.correlationId,
                });
              } else {
                // 达到重试上限或不需要重试，直接 ACK 消息，防止无限循环
                channel.ack(msg);
                logger.warn('消息处理失败，已放弃重试（将从队列中移除）', {
                  reason: shouldRetry ? '达到重试上限' : '错误类型不支持重试',
                  retryCount,
                  error: errorMessage,
                  correlationId: message?.correlationId,
                });
              }
            }
          },
          { noAck: false } // 手动确认
        );

        logger.info('✅ 已设置消息消费者', {
          queue: this.config.queue,
        });
      });
    } catch (error) {
      logger.error('消费消息失败', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    try {
      if (this.channelWrapper) {
        await this.channelWrapper.close();
      }
      if (this.connectionManager) {
        await this.connectionManager.close();
      }
      logger.info('RabbitMQ 连接已关闭');
    } catch (error) {
      logger.error('关闭 RabbitMQ 连接失败', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * 检查连接状态
   */
  isConnected(): boolean {
    if (!this.connectionManager) return false;
    return this.connectionManager.isConnected();
  }
}

// 导出单例
let rabbitmqConnection: RabbitMQConnection | null = null;

export function initializeRabbitMQ(config: RabbitMQConfig): RabbitMQConnection {
  rabbitmqConnection = new RabbitMQConnection(config);
  return rabbitmqConnection;
}

export function getRabbitMQConnection(): RabbitMQConnection {
  if (!rabbitmqConnection) {
    throw new Error('RabbitMQ 连接未初始化');
  }
  return rabbitmqConnection;
}

export default RabbitMQConnection;
