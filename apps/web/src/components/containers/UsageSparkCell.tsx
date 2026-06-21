import type { MetricTone } from "../../lib/dashboardTypes.js";

export function UsageSparkCell({
  label,
  values,
  tone,
  compact = false
}: {
  label: string;
  values: number[];
  tone: MetricTone;
  compact?: boolean;
}) {
  const width = compact ? 64 : 96;
  const height = compact ? 16 : 24;

  return (
    <div className={`usageSparkCell ${tone}${compact ? " compact" : ""}`}>
      <strong>{label}</strong>
      <MiniSparkline values={values.length ? values : [0]} width={width} height={height} />
    </div>
  );
}

export function MiniSparkline({ values, width = 96, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - ((value - min) / spread) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <svg className="miniSparkline" viewBox={`0 0 ${width} ${height}`} aria-label="Last 60 seconds" role="img">
      <polyline points={points} />
    </svg>
  );
}
