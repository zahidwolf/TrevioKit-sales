import { useState } from 'react';
import type { ChartPoint } from '@/lib/dashboard-stats';
import { taka } from '@/lib/validation';

export default function DashboardCharts({ points, monthly }: { points: ChartPoint[]; monthly: boolean }) {
  const [mode, setMode] = useState<'money' | 'units'>('money');
  const [selected, setSelected] = useState<string>();
  const money = mode === 'money';
  const first = money ? 'revenue' : 'sold';
  const second = money ? 'paid' : 'returned';
  const labels = money ? ['Net revenue', 'Payments received'] : ['Units sold', 'Units returned'];
  const values = points.flatMap(p => [p[first], p[second]]);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const y = (value: number) => 220 - (value - min) / (max - min) * 180;
  const zero = y(0);
  const format = (value: number) => money ? taka(value) : value.toLocaleString();
  const active = points.find(p => p._id === selected) ?? points.at(-1);
  const width = 760;
  const step = 660 / Math.max(1, points.length);
  const barWidth = Math.min(28, step * .32);
  return <section className="dashboard-chart">
    <div className="section-title"><div><h2>Business trends</h2><small>{monthly ? 'Monthly activity · latest 24 active months' : 'Daily activity · latest 60 active days'} · Asia/Dhaka</small></div><div className="chart-toggle" role="group" aria-label="Chart view"><button className={money ? '' : 'secondary'} aria-pressed={money} onClick={() => setMode('money')}>Revenue & paid</button><button className={!money ? '' : 'secondary'} aria-pressed={!money} onClick={() => setMode('units')}>Units sold & returned</button></div></div>
    {!points.length ? <p className="empty">No transactions in this date range.</p> : <>
      <div className="chart-legend"><span><i className="legend-revenue"/>{labels[0]}</span><span><i className="legend-paid"/>{labels[1]}</span></div>
      <svg className="trend-chart" viewBox={`0 0 ${width} 270`} role="group" aria-label={`${labels.join(' and ')} by ${monthly ? 'month' : 'day'}. Select a bar for exact amounts.`}>
        {[0, 1, 2, 3, 4].map(tick => {
          const value = min + (max - min) * tick / 4;
          return <g key={tick}><line x1="80" x2="740" y1={y(value)} y2={y(value)} className="chart-grid"/><text x="72" y={y(value) + 4} textAnchor="end" className="chart-label">{money ? `৳${(value / 100).toLocaleString('en', { notation: 'compact', maximumFractionDigits: 1 })}` : value.toLocaleString('en', { maximumFractionDigits: 0 })}</text></g>;
        })}
        <line x1="80" x2="740" y1={zero} y2={zero} className="chart-baseline"/>
        {points.map((point, index) => {
          const x = 80 + step * (index + .5);
          return <g key={point._id}>
            {([first, second] as const).map((key, series) => <rect key={key} x={x + (series ? 2 : -barWidth - 2)} y={Math.min(zero, y(point[key]))} width={barWidth} height={Math.max(2, Math.abs(zero - y(point[key])))} rx="2" className={series ? 'chart-paid' : 'chart-revenue'} tabIndex={0} role="button" aria-label={`${point._id}: ${labels[series]} ${format(point[key])}`} onMouseEnter={() => setSelected(point._id)} onFocus={() => setSelected(point._id)} onClick={() => setSelected(point._id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(point._id); } }}><title>{point._id}: {labels[series]} {format(point[key])}</title></rect>)}
            {(points.length < 10 || index % Math.ceil(points.length / 8) === 0 || index === points.length - 1) && <text x={x} y="245" textAnchor="middle" className="chart-label">{monthly ? point._id : point._id.slice(5)}</text>}
          </g>;
        })}
      </svg>
      {active && <div className="chart-detail" aria-live="polite"><strong>{active._id}</strong><span>{labels[0]}: <b>{format(active[first])}</b></span><span>{labels[1]}: <b>{format(active[second])}</b></span></div>}
    </>}
  </section>;
}
