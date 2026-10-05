import { z } from 'zod';
import { calendarDate } from './validation';

export function expenseQuery(params: URLSearchParams, now = new Date()) {
  const period = z.enum(['all', 'today', '7days', '30days', 'custom']).parse(params.get('period') || 'all');
  if (period === 'all') return {};
  if (period === 'custom') {
    const start = calendarDate.parse(params.get('startDate') || '');
    const end = calendarDate.parse(params.get('endDate') || '');
    z.boolean().refine(Boolean, 'Start date must be before end date').parse(start <= end);
    return { expenseDate: { $gte: start, $lte: end } };
  }
  const end = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const days = period === '7days' ? 7 : period === '30days' ? 30 : 1;
  const start = new Date(new Date(`${end}T00:00:00Z`).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { expenseDate: { $gte: start, $lte: end } };
}
