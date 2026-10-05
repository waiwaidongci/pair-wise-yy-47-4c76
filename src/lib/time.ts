/** 统一的展示时间格式：MM-DD HH:mm */
export function formatAt(input: Date | number = Date.now()): string {
  const d = input instanceof Date ? input : new Date(input)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 报告页等需要完整日期的场景 */
export function formatDate(input: Date | number = Date.now()): string {
  const d = input instanceof Date ? input : new Date(input)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
