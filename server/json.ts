/** mysql2 returns parsed JSON by default; also accept strings from alternate configurations. */
export function parseJsonColumn<T>(value: T | string | null | undefined, fallback: T): T {
  const parsed = typeof value === "string" ? JSON.parse(value) as T | null : value;
  return parsed ?? fallback;
}
