import * as echarts from 'echarts';
import { cssColor, isDark, mix, palette } from './client.ts';

/** Builds (and registers) an ECharts theme from the current page theme. Returns its name. */
export function registerEchartsTheme(): string {
  const name = isDark() ? 'explainer-dark' : 'explainer-light';
  const text = cssColor('var(--color-base-content)');
  const muted = mix('--color-base-content', 60);
  const faint = cssColor('var(--color-base-300)');
  const axis = { axisLine: { lineStyle: { color: mix('--color-base-content', 35) } }, axisTick: { lineStyle: { color: mix('--color-base-content', 35) } }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: faint } }, nameTextStyle: { color: muted } };
  echarts.registerTheme(name, {
    color: palette(),
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif', color: text },
    title: { textStyle: { color: text, fontWeight: 600 }, subtextStyle: { color: muted } },
    legend: { textStyle: { color: muted } },
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,
    tooltip: { backgroundColor: cssColor('var(--color-base-100)'), borderColor: faint, textStyle: { color: text } },
    line: { symbolSize: 6, smooth: false, lineStyle: { width: 2.5 } },
    pie: { label: { color: text, textBorderWidth: 0 }, itemStyle: { borderColor: cssColor('var(--color-base-100)'), borderWidth: 2 } },
    funnel: { label: { textBorderWidth: 0 } },
    treemap: { label: { textBorderWidth: 0 } },
  });
  return name;
}

/** Sensible defaults so authors can write minimal options. */
export function withDefaults(option: any): any {
  const o = { ...option };
  const series = Array.isArray(o.series) ? o.series : o.series ? [o.series] : [];
  const cartesian = o.xAxis !== undefined || o.yAxis !== undefined;
  if (o.tooltip === undefined) o.tooltip = { trigger: cartesian ? 'axis' : 'item', confine: true };
  const named = series.filter((s: any) => s?.name).length;
  if (o.legend === undefined && named > 1) o.legend = { top: 0 };
  // Axis titles: x title centred under the axis, y title above the axis (never clipped).
  const xs = Array.isArray(o.xAxis) ? o.xAxis : o.xAxis ? [o.xAxis] : [];
  const xNamed = xs.some((a: any) => a?.name);
  if (o.xAxis !== undefined) o.xAxis = Array.isArray(o.xAxis) ? xs.map(xDefaults) : xDefaults(o.xAxis);
  if (cartesian && o.grid === undefined) o.grid = { left: 16, right: 28, top: o.legend ? 56 : 36, bottom: xNamed ? 34 : 12, containLabel: true };
  return o;
}

function xDefaults(a: any) {
  return a?.name && a.nameLocation === undefined ? { nameLocation: 'middle', nameGap: 30, ...a } : a;
}

