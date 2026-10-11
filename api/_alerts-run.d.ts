export const ALERT_FIELDS: string;
export const PAGE: number;
export function runAlerts(o: {
  db: any; tariffs: any[]; today: string; appUrl?: string;
  send: (m: { to: string; subject: string; text: string }) => Promise<boolean>;
  budgetMs?: number; now?: () => number; page?: number;
}): Promise<{ ok: boolean; error?: string; households: number; sent: number; skipped: number; more: boolean }>;
