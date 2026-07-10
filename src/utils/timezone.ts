/**
 * 时区感知的日期边界计算
 * 将 YYYY-MM-DD 本地日期字符串按指定 IANA 时区转换为 UTC Date 对象
 */

const DEFAULT_TZ = 'America/Vancouver';

/**
 * 获取指定时区中某一时刻的 UTC 偏移量（毫秒）
 */
function getUtcOffsetMs(date: Date, tz: string): number {
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
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map(p => [p.type, p.value])
  );
  const localMs = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +(parts.hour === '24' ? '0' : parts.hour),
    +parts.minute,
    +parts.second,
  );
  return localMs - date.getTime();
}

/**
 * 将 YYYY-MM-DD + IANA 时区 → 当日 00:00:00 和 23:59:59.999 的 UTC Date
 */
export function dayBoundaries(dateStr: string, timezone?: string | null): {
  periodStart: Date;
  periodEnd: Date;
} {
  const tz = timezone || DEFAULT_TZ;

  const roughStart = new Date(`${dateStr}T00:00:00Z`);
  const offsetMs = getUtcOffsetMs(roughStart, tz);
  const periodStart = new Date(roughStart.getTime() - offsetMs);

  const offsetMs2 = getUtcOffsetMs(periodStart, tz);
  const correctedStart = new Date(roughStart.getTime() - offsetMs2);

  const roughEnd = new Date(`${dateStr}T23:59:59.999Z`);
  const offsetMsEnd = getUtcOffsetMs(new Date(roughEnd.getTime() - offsetMs2), tz);
  const correctedEnd = new Date(roughEnd.getTime() - offsetMsEnd);

  return { periodStart: correctedStart, periodEnd: correctedEnd };
}

export function pgTimezone(timezone?: string | null): string {
  return timezone || DEFAULT_TZ;
}
