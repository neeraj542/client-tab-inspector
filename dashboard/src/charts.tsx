type LineProps = {
  labels: string[];
  p50: number[];
  p95: number[];
  unit: string;
};

type BarProps = {
  labels: string[];
  values: number[];
  unit: string;
};

type HorizontalProps = {
  rows: { label: string; value: number }[];
  unit: string;
};

export function LatencyChart({ labels, p50, p95, unit }: LineProps) {
  const width = 360;
  const height = 150;
  const pad = { l: 42, r: 8, t: 12, b: 22 };
  const max = Math.max(500, ...p50, ...p95, 1);
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const x = (index: number) => pad.l + (labels.length <= 1 ? innerW / 2 : (index / (labels.length - 1)) * innerW);
  const y = (value: number) => pad.t + innerH - (value / max) * innerH;
  const path = (series: number[]) => series.map((value, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)}`).join(" ");
  const budgetY = y(500);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Latency in milliseconds by ${unit}`}>
      <line x1={pad.l} y1={budgetY} x2={width - pad.r} y2={budgetY} className="budget" />
      <text x={width - pad.r} y={budgetY - 4} textAnchor="end" className="axis">500 ms</text>
      <path d={path(p95)} className="line p95" />
      <path d={path(p50)} className="line p50" />
      {labels.map((label, index) => (
        <text key={label + index} x={x(index)} y={height - 6} textAnchor="middle" className="axis">{label}</text>
      ))}
      <text x={4} y={14} className="axis">{Math.round(max)} ms</text>
      <text x={4} y={height - 6} className="axis">0</text>
    </svg>
  );
}

export function ErrorChart({ labels, values, unit }: BarProps) {
  const width = 360;
  const height = 150;
  const pad = { l: 28, r: 8, t: 12, b: 22 };
  const max = Math.max(1, ...values);
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const gap = 4;
  const barW = Math.max(4, innerW / Math.max(values.length, 1) - gap);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Failed responses by ${unit}`}>
      {values.map((value, index) => {
        const h = (value / max) * innerH;
        const x = pad.l + index * (barW + gap);
        return (
          <g key={labels[index] + index}>
            <rect x={x} y={pad.t + innerH - h} width={barW} height={Math.max(value ? 2 : 0, h)} className="bar bad" />
            <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="axis">{labels[index]}</text>
          </g>
        );
      })}
      <text x={4} y={14} className="axis">{max}</text>
    </svg>
  );
}

export function BytesChart({ rows, unit }: HorizontalProps) {
  const width = 360;
  const height = Math.max(150, rows.length * 22 + 16);
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Response bytes by endpoint, ${unit}`}>
      {rows.map((row, index) => {
        const y = 8 + index * 22;
        const barW = (row.value / max) * 180;
        return (
          <g key={row.label}>
            <text x={0} y={y + 12} className="axis endpoint">{trim(row.label)}</text>
            <rect x={170} y={y + 2} width={barW} height={12} className="bar warn" />
          </g>
        );
      })}
    </svg>
  );
}

function trim(value: string) {
  return value.length > 22 ? `…${value.slice(-21)}` : value;
}
