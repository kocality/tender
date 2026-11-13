import { formatUnits, formatUsdc, tokenSymbol } from '../lib/format';
import { priceUnitLabel } from '../lib/amounts';
import type { Bid, Sale } from '../lib/views';

const W = 600;
const H = 320;
// Top margin holds the y-axis title (row 1) and the supply label (row 2); nothing is rotated, so nothing is clipped.
const M = { l: 64, r: 16, t: 52, b: 48 };

/** Drawing only: floats are fine here, every number that matters is read from bigint fields. */
const num = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/** A round tick step (1, 2, 2.5 or 5 times a power of ten) that cuts `span` into about `n` parts. */
function niceStep(span: number, n: number): number {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

/** Axis bounds snapped to round ticks, and the ticks. */
function axis(lo: number, hi: number, n: number): { lo: number; hi: number; ticks: number[]; digits: number } {
  const step = niceStep(hi - lo || 1, n);
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  const sd = String(Number(step.toFixed(10)));
  const digits = sd.includes('.') ? sd.split('.')[1]!.length : 0;
  return { lo: a, hi: b, ticks, digits };
}

const fmt = (v: number, digits: number) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const amount = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 4 });

/**
 * Demand against supply: x is cumulative tokens wanted (each revealed bid wants q / p lots at its limit price), y is
 * the price in USDC per lot, highest limit first. The vertical line is the supply, the dashed line the minimum price
 * (reserve) and the thick line the final price. Both axes are zoomed to the data with round ticks; the demand steps are
 * drawn last, so the final price line never hides one. Inline SVG, no library.
 */
export function SupplyDemandChart({ sale, bids, pStar }: { sale: Sale; bids: Bid[]; pStar: bigint | null }) {
  const name = tokenSymbol(sale.token);
  const unit = priceUnitLabel(name, sale.lotExp);
  const lot = 10 ** sale.lotExp;
  const revealed = bids
    .filter((b) => b.state === 'Revealed' && b.p !== null && b.q !== null && b.p > 0n)
    .sort((a, b) => (a.p! === b.p! ? a.idx - b.idx : a.p! > b.p! ? -1 : 1));

  // Cumulative demand in whole tokens at each step.
  let cum = 0;
  const steps = revealed.map((b) => {
    const price = num(b.p!, 6);
    cum += (num(b.q!, 6) / price) * lot;
    return { price, cum };
  });
  const supply = num(sale.supply, sale.decimals);
  const reserve = num(sale.reserve, 6);
  const star = pStar === null ? null : num(pStar, 6);

  const prices = [reserve, ...(star === null ? [] : [star]), ...steps.map((s) => s.price)];
  const pLo = Math.min(...prices);
  const pHi = Math.max(...prices);
  const pad = (pHi - pLo) * 0.15 || pHi * 0.1 || 1;
  const ya = axis(Math.max(0, pLo - pad), pHi + pad, 4);
  const xa = axis(0, Math.max(supply, cum) * 1.05 || 1, 5);
  const x = (v: number) => M.l + (v / xa.hi) * (W - M.l - M.r);
  const y = (v: number) => H - M.b - ((v - ya.lo) / (ya.hi - ya.lo)) * (H - M.t - M.b);

  let d = '';
  let prev = 0;
  for (const [i, s] of steps.entries()) {
    d += i === 0 ? `M ${x(prev)} ${y(s.price)}` : ` V ${y(s.price)}`;
    d += ` H ${x(s.cum)}`;
    prev = s.cum;
  }

  // Labels sit at the right edge; when the two price lines are close, the minimum-price label goes under its line.
  const reserveBelow = star !== null && Math.abs(y(star) - y(reserve)) < 22;
  const supplyRight = x(supply) <= W - M.r - 80;
  const demandAtStar = star === null ? 0 : revealed.filter((b) => num(b.p!, 6) >= star).reduce((a, b) => a + (num(b.q!, 6) / num(b.p!, 6)) * lot, 0);

  const per = lot === 1 ? name : `${lot} ${name}`;
  const label =
    pStar === null
      ? `Supply and demand for ${name}: no bid cleared, reserve ${formatUsdc(sale.reserve)} USDC per ${per}`
      : `Clearing price ${formatUsdc(pStar)} USDC per ${per}, reserve ${formatUsdc(sale.reserve)} USDC per ${per}, supply ${formatUnits(sale.supply, sale.decimals)} ${name}`;

  return (
    <figure className="chart" style={{ margin: '16px 0 0' }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} width="100%" preserveAspectRatio="xMidYMid meet">
        <title>{label}</title>
        {ya.ticks.map((t) => (
          <g key={`y${t}`}>
            <line className="grid" x1={M.l} y1={y(t)} x2={W - M.r} y2={y(t)} />
            <text className="tick" x={M.l - 6} y={y(t) + 4} textAnchor="end">
              {fmt(t, Math.max(2, ya.digits))}
            </text>
          </g>
        ))}
        {xa.ticks.map((t, i) => (
          <text key={`x${t}`} className="tick" x={x(t)} y={H - M.b + 18} textAnchor={i === xa.ticks.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}>
            {fmt(t, xa.digits)}
          </text>
        ))}
        <line className="axis" x1={M.l} y1={H - M.b} x2={W - M.r} y2={H - M.b} />
        <line className="axis" x1={M.l} y1={M.t} x2={M.l} y2={H - M.b} />
        <line className="reserve" x1={M.l} y1={y(reserve)} x2={W - M.r} y2={y(reserve)} />
        {star !== null ? <line className="pstar" data-testid="pstar" x1={M.l} y1={y(star)} x2={W - M.r} y2={y(star)} /> : null}
        <line className="supply" x1={x(supply)} y1={M.t} x2={x(supply)} y2={H - M.b} />
        {d ? <path className="demand" d={d} fill="none" /> : null}
        <text className="tick" x={supplyRight ? x(supply) + 4 : x(supply) - 4} y={M.t - 8} textAnchor={supplyRight ? 'start' : 'end'}>
          supply
        </text>
        <text className="tick" x={W - M.r} y={reserveBelow ? y(reserve) + 16 : y(reserve) - 6} textAnchor="end">
          minimum price
        </text>
        {star !== null ? (
          <text className="tick strong" x={W - M.r} y={y(star) - 8} textAnchor="end">
            {`final price ${fmt(star, 2)}`}
          </text>
        ) : null}
        <text className="tick" x={(W + M.l) / 2} y={H - 6} textAnchor="middle">
          {name} wanted, all bids added up
        </text>
        <text className="tick" x={4} y={16} textAnchor="start">
          {unit}
        </text>
      </svg>
      <ul className="chart-legend">
        <li>
          <i className="sw sw-demand" aria-hidden="true" />
          <span>
            <b>demand</b>: the bids, highest price first, added up
          </span>
        </li>
        <li>
          <i className="sw sw-supply" aria-hidden="true" />
          <span>
            <b>supply</b>: what is for sale
          </span>
        </li>
        <li>
          <i className="sw sw-reserve" aria-hidden="true" />
          <span>
            <b>minimum price</b> (reserve)
          </span>
        </li>
        {star !== null ? (
          <li>
            <i className="sw sw-pstar" aria-hidden="true" />
            <span>
              <b>final price</b> (P*): what every winner pays
            </span>
          </li>
        ) : null}
      </ul>
      {star !== null ? (
        <figcaption className="small muted">
          {`Bids at ${fmt(star, 2)} or higher want ${amount(demandAtStar)} ${name}; ${amount(supply)} ${name} ${supply === 1 ? 'was' : 'were'} for sale.`}
        </figcaption>
      ) : null}
    </figure>
  );
}
