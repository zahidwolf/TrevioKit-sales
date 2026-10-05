import { z } from 'zod';
import { invoiceQuery } from './invoice-filters';

export function dashboardQuery(params: URLSearchParams, now = new Date()) {
  const period = z.enum(['all', 'today', '7days', '30days', 'custom']).parse(params.get('period') || 'today');
  if (period === 'all') return {};
  if (period === 'custom') {
    z.string().min(1, 'Select a start date').parse(params.get('startDate') || '');
    z.string().min(1, 'Select an end date').parse(params.get('endDate') || '');
    const dates = new URLSearchParams({ startDate: params.get('startDate')!, endDate: params.get('endDate')! });
    return { createdAt: invoiceQuery(dates).createdAt };
  }
  const today = new Date(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) + 'T00:00:00+06:00');
  const days = period === '7days' ? 7 : period === '30days' ? 30 : 1;
  return { createdAt: { $gte: new Date(today.getTime() - (days - 1) * 86400000), $lt: new Date(today.getTime() + 86400000) } };
}
