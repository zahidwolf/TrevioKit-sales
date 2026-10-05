import { z } from 'zod';
import type { Filter } from 'mongodb';
import type { Invoice } from './business';
import { calendarDate } from './validation';

const filters = z.object({
  retailerId: z.string().uuid().optional(),
  startDate: calendarDate.optional(),
  endDate: calendarDate.optional(),
  search: z.string().trim().max(100).optional(),
}).refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, 'Start date must be before end date');

export function invoiceQuery(params: URLSearchParams): Filter<Invoice> {
  const values = filters.parse(Object.fromEntries(['retailerId', 'startDate', 'endDate', 'search'].flatMap(key => {
    const value = params.get(key);
    return value ? [[key, value]] : [];
  })));
  const query: Filter<Invoice> = {};
  if (values.retailerId) query.retailerId = values.retailerId;
  if (values.search) {
    const text = values.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = ['number', 'retailer.name', 'retailer.shopName'].map(field => ({ [field]: { $regex: text, $options: 'i' } }));
  }
  if (values.startDate || values.endDate) query.createdAt = {
    ...(values.startDate ? { $gte: new Date(`${values.startDate}T00:00:00+06:00`) } : {}),
    ...(values.endDate ? { $lt: new Date(new Date(`${values.endDate}T00:00:00+06:00`).getTime() + 86400000) } : {}),
  };
  return query;
}
