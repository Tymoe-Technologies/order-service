/**
 * MQ Service 客户端
 * 用于与 MQ Service 通信
 */

interface MQMessage {
  type: string;
  payload: any;
  correlationId?: string;
}

interface MQResponse {
  success: boolean;
  data?: {
    messageId: string;
    timestamp: string;
  };
  error?: string;
}

class MQClient {
  private mqServiceUrl: string;

  constructor(mqServiceUrl: string = process.env.MQ_SERVICE_URL || 'http://localhost:5672') {
    this.mqServiceUrl = mqServiceUrl;
  }

  /**
   * 发送单个消息到 MQ Service
   */
  async publishMessage(message: MQMessage): Promise<MQResponse> {
    try {
      const response = await fetch(`${this.mqServiceUrl}/api/mq/v1/messages/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(`MQ Service error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('MQ 消息发送失败:', error);
      throw error;
    }
  }

  /**
   * 批量发送消息到 MQ Service
   */
  async publishBatch(messages: MQMessage[]): Promise<MQResponse> {
    try {
      const response = await fetch(`${this.mqServiceUrl}/api/mq/v1/messages/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages }),
      });

      if (!response.ok) {
        throw new Error(`MQ Service error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('MQ 批量消息发送失败:', error);
      throw error;
    }
  }

  /**
   * 获取队列状态
   */
  async getQueueStatus(queueName: string): Promise<any> {
    try {
      const response = await fetch(
        `${this.mqServiceUrl}/api/mq/v1/queues/${queueName}`
      );

      if (!response.ok) {
        throw new Error(`MQ Service error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('获取队列状态失败:', error);
      throw error;
    }
  }

  /**
   * 健康检查
   */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.mqServiceUrl}/health`);
      return response.ok;
    } catch (error) {
      console.error('MQ Service 健康检查失败:', error);
      return false;
    }
  }
}

export default new MQClient();
