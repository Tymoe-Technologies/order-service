import { Router, Request, Response } from 'express';

// 供 Twilio 呼叫时回调获取 TwiML 内容的公开端点（Twilio 服务器需要能从公网访问到这里）。
// 不接 authenticate/internalAuth——Twilio 本身不会带任何我们的鉴权 header，
// 用一个共享 token 校验代替，防止被随意探测调用（泄露的最多是告警文案本身，不涉及资金操作）
const router = Router();

const TWILIO_VOICE_WEBHOOK_TOKEN = process.env.TWILIO_VOICE_WEBHOOK_TOKEN || '';

// Twilio 请求 Url 时默认用 POST（除非显式传 Method=GET），query 参数仍会带在 URL 上，
// 两种方法都要能命中同一个 handler，否则会 404 → Twilio 播放错误音/挂断
const handleVoiceAlert = (req: Request, res: Response) => {
  const { text, token } = req.query as { text?: string; token?: string };

  if (!TWILIO_VOICE_WEBHOOK_TOKEN || token !== TWILIO_VOICE_WEBHOOK_TOKEN) {
    res.status(403).send('Forbidden');
    return;
  }

  const message = (text || 'Alert from Tymoe P O S.').slice(0, 500);
  // XML 转义，防止文案里出现 & < > 破坏 TwiML 结构
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">${escaped}</Say></Response>`);
};

router.get('/voice-alert', handleVoiceAlert);
router.post('/voice-alert', handleVoiceAlert);

export default router;
