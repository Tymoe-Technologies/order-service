/**
 * 时间维度工具
 * 把 UTC 下单时间按"门店本地时区"拆解成分析维度（年/月/日/星期/小时/周序号/时段等）。
 * 使用 Node 内置 Intl，无需额外依赖。
 */

export type DayPart =
  | 'LATE_NIGHT'
  | 'EARLY_MORNING'
  | 'MORNING'
  | 'LUNCH'
  | 'AFTERNOON'
  | 'DINNER'
  | 'NIGHT';

export interface TimeDimensions {
  localTime: Date; // 门店本地墙钟时间（以 UTC 字段承载墙钟值，便于直接读取）
  timezone: string;
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  dayOfWeek: number; // 0=周日 ... 6=周六
  hour: number; // 0-23
  weekOfYear: number; // ISO 周序号 1-53
  isWeekend: boolean;
  dayPart: DayPart;
}

// 按小时划分时段
function resolveDayPart(hour: number): DayPart {
  if (hour < 5) return 'LATE_NIGHT';
  if (hour < 8) return 'EARLY_MORNING';
  if (hour < 11) return 'MORNING';
  if (hour < 14) return 'LUNCH';
  if (hour < 17) return 'AFTERNOON';
  if (hour < 21) return 'DINNER';
  return 'NIGHT';
}

// ISO 8601 周序号（周一为一周起点，含当年第一个周四的那一周为第 1 周）
function isoWeekOfYear(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0 ... 周日=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 移到本周周四
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const diff = date.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

/**
 * 把 UTC 时间按指定 IANA 时区拆解为分析维度。
 * @param utc      下单的 UTC 时间
 * @param timezone IANA 时区名（如 America/Toronto）；非法/缺省时回退到 UTC
 */
export function computeTimeDimensions(utc: Date, timezone?: string | null): TimeDimensions {
  let tz = timezone || 'UTC';

  let parts: Record<string, string>;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    parts = Object.fromEntries(
      dtf.formatToParts(utc).map((p) => [p.type, p.value])
    );
  } catch {
    // 非法时区名 → 回退 UTC，保证仍能产出维度
    tz = 'UTC';
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    parts = Object.fromEntries(
      dtf.formatToParts(utc).map((p) => [p.type, p.value])
    );
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // Intl 在午夜会给出 "24" 时，归一到 0
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);

  // dayOfWeek 由本地日历日期推导（与小时无关）
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  // localTime：以 UTC 字段承载本地墙钟值，便于在 BI 中直接读取本地时间
  const localTime = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  return {
    localTime,
    timezone: tz,
    year,
    month,
    day,
    dayOfWeek,
    hour,
    weekOfYear: isoWeekOfYear(year, month, day),
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    dayPart: resolveDayPart(hour),
  };
}
