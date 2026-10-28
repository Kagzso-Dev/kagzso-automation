import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { prefersReducedMotion } from "../lib/motion";
import { fullNumber as full } from "../lib/numberFormat";

/* ------------------------------------------------------------------ palette --
 * Categorical series hues, validated against the app's white card surface
 * (dataviz six-checks: lightness band, chroma floor, CVD ΔE, contrast).
 * Identity is always carried by a legend + direct labels, never colour alone.
 */
export const SERIES = {
  sent: "#0091d5",
  opened: "#eb6834",
  clicked: "#009a80",
} as const;

const STATUS = {
  good: "#009a80",
  warning: "#d4870a",
  critical: "#ef4444",
} as const;

const INK = "#111827";
const MUTED = "#8a94a6";
const GRID = "#e9eef7";

/* --------------------------------------------------------------- primitives -- */

/** Count from 0 → `value` once, easing out. Honours reduced-motion. */
export function useCountUp(value: number, durationMs = 700) {
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0));
  const fromRef = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return display;
}

/** True once the element has scrolled into view — gate entrance animations on it. */
export function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function AnimatedNumber({
  value,
  format = "int",
  className,
}: {
  value: number;
  format?: "int" | "compact" | "pct";
  className?: string;
}) {
  const n = useCountUp(value);
  const text =
    format === "pct"
      ? `${(Math.round(n * 10) / 10).toFixed(1)}%`
      : format === "compact"
        ? compact.format(Math.round(n))
        : full.format(Math.round(n));
  return <span className={className}>{text}</span>;
}

/* ---------------------------------------------------------------- TrendPill -- */

export function TrendPill({
  delta,
  goodDirection = "up",
  suffix = "%",
}: {
  delta: number | null;
  goodDirection?: "up" | "down";
  suffix?: string;
}) {
  if (delta === null) {
    return <span className="text-xs text-slate-400">— no prior data</span>;
  }
  const flat = Math.abs(delta) < 0.05;
  const up = delta > 0;
  const good = flat ? null : (up ? goodDirection === "up" : goodDirection === "down");
  const tone = good === null ? "text-slate-400" : good ? "text-ok" : "text-crit";
  const arrow = flat ? "→" : up ? "↑" : "↓";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
      <span aria-hidden>{arrow}</span>
      {flat ? "flat" : `${up ? "+" : ""}${delta}${suffix}`}
    </span>
  );
}

/* ---------------------------------------------------------------- Sparkline -- */

export function Sparkline({
  data,
  color = SERIES.sent,
  width = 120,
  height = 34,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const path = useMemo(() => {
    if (data.length < 2) return { line: "", area: "", last: [0, 0] as [number, number] };
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const span = max - min || 1;
    const step = width / (data.length - 1);
    const pts = data.map(
      (v, i) => [i * step, height - 3 - ((v - min) / span) * (height - 6)] as [number, number],
    );
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = `${line} L${width},${height} L0,${height} Z`;
    return { line, area, last: (pts[pts.length - 1] ?? [0, 0]) as [number, number] };
  }, [data, width, height]);

  const gid = useMemo(() => `spark-${Math.random().toString(36).slice(2)}`, []);
  if (!path.line) return <div style={{ width, height }} />;

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill={`url(#${gid})`} />
      <path
        d={path.line}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength={1}
        className="spark-draw"
      />
      <circle cx={path.last[0]} cy={path.last[1]} r={2.5} fill={color} />
    </svg>
  );
}

/* --------------------------------------------------------------- AreaChart -- */

export interface SeriesPoint {
  date: string;
  [k: string]: string | number;
}

/**
 * Multi-series time chart on a single y-axis: 2px lines, ~12%-opacity washes,
 * a hover crosshair with a shared tooltip, and a draw-in animation keyed to the
 * data so range/toggle changes re-animate.
 */
export function AreaChart({
  data,
  series,
  height = 240,
  valueFormat = (n) => full.format(n),
}: {
  data: SeriesPoint[];
  series: { key: string; label: string; color: string }[];
  height?: number;
  valueFormat?: (n: number) => string;
}) {
  const W = 720;
  const H = height;
  const padL = 44;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const model = useMemo(() => {
    const n = data.length;
    const maxV = Math.max(
      1,
      ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)),
    );
    const niceMax = niceCeil(maxV);
    const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v: number) => padT + plotH - (v / niceMax) * plotH;
    const lines = series.map((s) => {
      const pts = data.map((d, i) => [x(i), y(Number(d[s.key]) || 0)] as [number, number]);
      const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
      const area = `${line} L${x(n - 1)},${padT + plotH} L${x(0)},${padT + plotH} Z`;
      return { ...s, line, area, end: (pts[pts.length - 1] ?? [x(0), y(0)]) as [number, number] };
    });
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      v: niceMax * f,
      y: y(niceMax * f),
    }));
    return { n, x, y, lines, ticks, niceMax };
  }, [data, series, plotW, plotH]);

  const animKey = `${data.length}:${series.map((s) => s.key).join(",")}:${data[0]?.date ?? ""}`;

  function onMove(e: React.MouseEvent) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || model.n === 0) return;
    const rel = (e.clientX - rect.left) / rect.width;
    const px = rel * W;
    const i = Math.round(((px - padL) / plotW) * (model.n - 1));
    setHover(Math.max(0, Math.min(model.n - 1, i)));
  }

  const labelEvery = Math.max(1, Math.ceil(model.n / 7));
  const hp = hover !== null ? data[hover] : undefined;

  return (
    <div className="relative" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Time series: ${series.map((s) => s.label).join(", ")}`}
      >
        <defs>
          {model.lines.map((l) => (
            <linearGradient key={l.key} id={`area-${l.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={l.color} stopOpacity="0.16" />
              <stop offset="90%" stopColor={l.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* gridlines + y ticks */}
        {model.ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke={GRID} strokeWidth={1} />
            <text x={padL - 8} y={t.y + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>
              {valueFormat(Math.round(t.v))}
            </text>
          </g>
        ))}

        {/* x labels */}
        {data.map((d, i) =>
          i % labelEvery === 0 || i === model.n - 1 ? (
            <text
              key={d.date}
              x={model.x(i)}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill={MUTED}
            >
              {shortDate(d.date)}
            </text>
          ) : null,
        )}

        <g key={animKey}>
          {model.lines.map((l) => (
            <path key={`a-${l.key}`} d={l.area} fill={`url(#area-${l.key})`} className="area-fade" />
          ))}
          {model.lines.map((l) => (
            <path
              key={`l-${l.key}`}
              d={l.line}
              fill="none"
              stroke={l.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={1}
              className="line-draw"
            />
          ))}
          {model.lines.map((l) => (
            <circle key={`e-${l.key}`} cx={l.end[0]} cy={l.end[1]} r={3.5} fill={l.color} stroke="#fff" strokeWidth={2} className="area-fade" />
          ))}
        </g>

        {/* hover crosshair */}
        {hover !== null && hp && (
          <g>
            <line
              x1={model.x(hover)}
              x2={model.x(hover)}
              y1={padT}
              y2={padT + plotH}
              stroke={INK}
              strokeOpacity={0.18}
              strokeWidth={1}
            />
            {model.lines.map((l) => (
              <circle
                key={`h-${l.key}`}
                cx={model.x(hover)}
                cy={model.y(Number(hp[l.key]) || 0)}
                r={4}
                fill={l.color}
                stroke="#fff"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>

      {hover !== null && hp && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop"
          style={{ left: `${(model.x(hover) / W) * 100}%`, top: 0 }}
        >
          <div className="mb-1 font-medium text-ink">{longDate(String(hp.date))}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2 tabular-nums text-slate-550">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="w-14">{s.label}</span>
              <span className="font-medium text-ink">{valueFormat(Number(hp[s.key]) || 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({
  items,
  active,
  onToggle,
}: {
  items: { key: string; label: string; color: string }[];
  active?: Record<string, boolean>;
  onToggle?: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((it) => {
        const on = active ? active[it.key] : true;
        const Tag = onToggle ? "button" : "span";
        return (
          <Tag
            key={it.key}
            type={onToggle ? "button" : undefined}
            onClick={onToggle ? () => onToggle(it.key) : undefined}
            className={`inline-flex items-center gap-1.5 text-xs font-medium transition-opacity ${
              on ? "text-slate-550" : "text-slate-400 opacity-50"
            } ${onToggle ? "hover:opacity-100" : ""}`}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: it.color, boxShadow: on ? "none" : "inset 0 0 0 1px currentColor" }}
            />
            {it.label}
          </Tag>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- Donut -- */

export function Donut({
  segments,
  size = 168,
  thickness = 22,
  centerLabel,
  centerValue,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string | number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const [hover, setHover] = useState<number | null>(null);

  let offset = 0;
  const arcs = segments.map((seg) => {
    const frac = total === 0 ? 0 : seg.value / total;
    const arc = { ...seg, frac, dash: frac * c, rot: (offset / (total || 1)) * 360 };
    offset += seg.value;
    return arc;
  });

  const shown = hover === null ? null : arcs[hover];

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} className="shrink-0 -rotate-90" role="img" aria-label="Distribution">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={GRID} strokeWidth={thickness} />
        {arcs.map((a, i) => (
          <circle
            key={a.label}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={a.color}
            strokeWidth={hover === i ? thickness + 4 : thickness}
            strokeDasharray={`${a.dash} ${c - a.dash}`}
            strokeLinecap="butt"
            transform={`rotate(${a.rot} ${size / 2} ${size / 2})`}
            className="donut-arc"
            style={{ transition: "stroke-width 150ms" }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      <div className="min-w-0">
        {(centerLabel || centerValue !== undefined) && (
          <div className="mb-2">
            <div className="metric-value leading-none">
              {shown ? full.format(shown.value) : centerValue}
            </div>
            <div className="label mt-1">{shown ? shown.label : centerLabel}</div>
          </div>
        )}
        <ul className="space-y-1">
          {arcs.map((a, i) => (
            <li
              key={a.label}
              className="flex items-center gap-2 text-xs tabular-nums"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
              <span className="w-24 truncate text-slate-550">{a.label}</span>
              <span className="font-medium text-ink">{full.format(a.value)}</span>
              <span className="text-slate-400">{Math.round(a.frac * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Funnel -- */

export function Funnel({
  stages,
}: {
  stages: { label: string; value: number; color: string }[];
}) {
  const top = stages[0]?.value || 1;
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className="space-y-2.5">
      {stages.map((s, i) => {
        const pctOfTop = Math.round((s.value / top) * 100);
        const prev = i > 0 ? stages[i - 1] : undefined;
        const stepDrop =
          prev && prev.value > 0 ? Math.round((s.value / prev.value) * 100) : null;
        return (
          <div key={s.label}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-550">{s.label}</span>
              <span className="tabular-nums text-slate-400">
                <span className="font-medium text-ink">{full.format(s.value)}</span>
                {stepDrop !== null && <span className="ml-2">{stepDrop}% of prev</span>}
              </span>
            </div>
            <div className="h-7 overflow-hidden rounded-md bg-surface-muted">
              <div
                className="h-full rounded-md transition-[width] duration-700 ease-in-out-soft"
                style={{
                  width: seen ? `${Math.max(pctOfTop, 2)}%` : "0%",
                  background: s.color,
                  transitionDelay: `${i * 90}ms`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- GaugeRing -- */

export function GaugeRing({
  value,
  label,
  sub,
  size = 132,
}: {
  value: number; // 0-100
  label: string;
  sub?: string;
  size?: number;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = useCountUp(pct);
  const color = pct >= 90 ? STATUS.good : pct >= 75 ? STATUS.warning : STATUS.critical;

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={GRID} strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c - (shown / 100) * c}
            style={{ transition: "stroke-dashoffset 60ms linear" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="metric-value leading-none">{Math.round(shown)}</div>
          <div className="label mt-1">{label}</div>
        </div>
      </div>
      {sub && <div className="mt-1 text-xs text-slate-550">{sub}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- ProgressBar */

export function CapMeter({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const [ref, seen] = useInView<HTMLDivElement>();
  const tone = pct >= 90 ? STATUS.critical : pct >= 70 ? STATUS.warning : "var(--gradient-accent)";
  return (
    <div ref={ref}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="metric-value">
          <AnimatedNumber value={used} /> <span className="text-base text-slate-400">/ {full.format(limit)}</span>
        </span>
        <span className="text-xs font-medium tabular-nums text-slate-550">{pct}%</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-in-out-soft"
          style={{ width: seen ? `${pct}%` : "0%", background: tone }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ layout -- */

export function ChartCard({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold tracking-[-0.01em] text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-550">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function RangeTabs<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
            value === o.value ? "bg-gradient-accent font-semibold text-ink shadow-sm" : "text-slate-550 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ helpers -- */

function niceCeil(n: number): number {
  if (n <= 5) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}
function longDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

