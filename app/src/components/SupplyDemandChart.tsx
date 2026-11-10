import { formatUnits, formatUsdc, tokenLabel } from '../lib/format';
import { priceUnitLabel } from '../lib/amounts';
import type { Bid, Sale } from '../lib/views';

const W = 600;
const H = 320;
const M = { l: 56, r: 16, t: 16, b: 40 };

/** Drawing only: floats are fine here, every number that matters is read from bigint fields. */
const num = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

/**
 * Demand against supply: x is cumulative tokens wanted (each revealed bid wants q / p lots at its limit price), y is
 * the price in USDC per lot, highest limit first. The vertical line is the supply, the dashed line the reserve and the
 * thick line the clearing price. Inline SVG, no library.
 */
export function SupplyDemandChart({ sale, bids, pStar }: { sale: Sale; bids: Bid[]; pStar: bigint | null }) {
  const name = tokenLabel(sale.token);
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

  const xMax = Math.max(supply * 1.15, cum * 1.05, 1);
  const yMax = Math.max(reserve, star ?? 0, ...steps.map((s) => s.price), 1) * 1.15;
  const x = (v: number) => M.l + (v / xMax) * (W - M.l - M.r);
  const y = (v: number) => H - M.b - (v / yMax) * (H - M.t - M.b);

  let d = '';
  let prev = 0;
  for (const [i, s] of steps.entries()) {
    d += i === 0 ? `M ${x(prev)} ${y(s.price)}` : ` V ${y(s.price)}`;
    d += ` H ${x(s.cum)}`;
    prev = s.cum;
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const label =
    pStar === null
      ? `Supply and demand for ${name}: no bid cleared`
      : `Clearing price ${formatUsdc(pStar)} USDC per ${lot === 1 ? name : `${lot} ${name}`}, supply ${formatUnits(sale.supply, sale.decimals)} ${name}`;

  return (
    <figure className="chart" style={{ margin: '16px 0 0' }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} width="100%" preserveAspectRatio="xMidYMid meet">
        <title>{label}</title>
        <line className="axis" x1={M.l} y1={H - M.b} x2={W - M.r} y2={H - M.b} />
        <line className="axis" x1={M.l} y1={M.t} x2={M.l} y2={H - M.b} />
        {ticks.map((t) => (
          <g key={t}>
            <text className="tick" x={x(t * xMax)} y={H - M.b + 16} textAnchor="middle">
              {(t * xMax).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </text>
            <text className="tick" x={M.l - 6} y={y(t * yMax) + 4} textAnchor="end">
              {(t * yMax).toFixed(2)}
            </text>
          </g>
        ))}
        {d ? <path className="demand" d={d} fill="none" /> : null}
        <line className="supply" x1={x(supply)} y1={M.t} x2={x(supply)} y2={H - M.b} />
        <line className="reserve" x1={M.l} y1={y(reserve)} x2={W - M.r} y2={y(reserve)} />
        {star !== null ? <line className="pstar" data-testid="pstar" x1={M.l} y1={y(star)} x2={W - M.r} y2={y(star)} /> : null}
        <text className="tick" x={x(supply) - 4} y={M.t + 12} textAnchor="end">
          supply
        </text>
        <text className="tick" x={W - M.r} y={y(reserve) - 4} textAnchor="end">
          reserve
        </text>
        {star !== null ? (
          <text className="tick strong" x={W - M.r} y={y(star) - 6} textAnchor="end">
            P*
          </text>
        ) : null}
        <text className="tick" x={(W + M.l) / 2} y={H - 4} textAnchor="middle">
          cumulative {name} wanted
        </text>
        <text className="tick" x={12} y={(H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(H - M.b) / 2})`}>
          {unit}
        </text>
      </svg>
    </figure>
  );
}
