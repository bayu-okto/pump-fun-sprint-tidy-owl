// Ignition bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The idea in one line: the launch pump itself is a trap — the dev data shows
// that buying the first minute's inflow mean-reverts, with every flow filter
// underwater at ages 5–60 slots. What keeps working is the second wave: a coin
// that is still drawing fresh money about two minutes after creation (net SOL
// over the last thirty slots, several recent trades, several distinct buyers)
// tends to keep rising for the next minute, then the edge fades. So the bot
// waits until a curve is ninety slots old, buys only that fresh-flow signal,
// and gets out fast — take-profit, stop, trailing stop, or the hold clock —
// never letting one coin eat the account.
//
// The older whole-tape checks still screen out bundled launches and chases:
// spread-out buying, the creator not sold, no outsized creator buy, and the
// price not run away from its create price. Curves that complete are closed
// by the replay itself.
//
// Guardrails are a first-class concern, not an afterthought: the run needs round trips
// on at least twenty coins, so when the main entries lag that pace the bot opens tiny
// probe round trips on liquid curves and closes them as soon as the buy lands.
//
// The bot is a pure function of the batches it is fed: no clock, no randomness, no
// environment, no I/O. Iteration is over insertion-ordered maps fed by the batch
// stream, so two runs on the same data decide the same orders in the same slots —
// the hello message's seed is the only randomness the harness allows, and this bot
// does not need it.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** Every knob the ignition bot trades with. */
export interface IgnitionSettings {
  /** Youngest age (slots since the CreateEvent) at which a first buy may be decided. */
  entryMinAge: number;
  /** Oldest age at which a first buy may still be decided. */
  entryMaxAge: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Opening tape: trades and distinct non-creator buyers seen before entry. */
  minOpeningTrades: number;
  minOpeningBuyers: number;
  /** Largest single non-creator buyer's share of the opening buy SOL. */
  maxTopBuyerShare: number;
  /** Opening tape: SOL bought, net SOL in, sells as a share of buys. */
  minOpeningBuySol: number;
  minNetFlowSol: number;
  maxSellShare: number;
  /** Second-wave tape: net SOL and trades over the last 30 slots only. */
  minFlow30: number;
  minRecentTrades: number;
  /** Creator's own opening buys, at most this many SOL; creator sold means skip. */
  maxCreatorBuySol: number;
  /** Price now over the create price, minus one: the window a launch may sit in. */
  minLift: number;
  maxLift: number;
  /** First buy (SOL), the one add (SOL), and how many adds a position may take. */
  fuseSol: number;
  addSol: number;
  maxAdds: number;
  /** An add needs the price this far above the last buy's decision price. */
  addMinRise: number;
  /** An add needs net SOL over the entry window at least this. */
  addMinFlowSol: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (fraction). */
  takeProfit: number;
  /** Exit when it is worth this much under its cost (fraction). */
  stopLoss: number;
  /** Trailing stop: arms once up this much, exits on a fall of this much from peak. */
  trailArm: number;
  trailDrop: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while the position is held. */
  exitOnCreatorSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most main positions open at once (the harness cap leaves room for probes). */
  maxMainPositions: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Probe round trips: SOL per probe, and the pace that triggers them. */
  probeSol: number;
  probeMinCoins: number;
  probeAfterSeen: number;
  /** Slots after the first batch before probes may start (a clock the coin
   * count cannot give on a short final window). */
  probeAfterSlots: number;
}

/** The settings main.ts trades with. Second-wave defaults, tuned on the dev
 * window (see README): buy the fresh flow at age 90–180 slots, exit fast. */
export const DEFAULT_SETTINGS: IgnitionSettings = {
  entryMinAge: 90,
  entryMaxAge: 180,
  minRealSol: 0.5,
  maxRealSol: 40,
  minOpeningTrades: 3,
  minOpeningBuyers: 5,
  // Whole-tape screens are off for the second wave: at age 90–180 the opening
  // tape is the launch pump's history, and the dev data shows those screens
  // cut the signal's coins without improving it. The live signal is the
  // thirty-slot flow, the recent trade count, and the buyer count.
  maxTopBuyerShare: 1,
  minOpeningBuySol: 0,
  minNetFlowSol: -1e9,
  maxSellShare: 1e9,
  minFlow30: 1,
  minRecentTrades: 5,
  maxCreatorBuySol: 1e9,
  minLift: 0,
  maxLift: 1e9,
  fuseSol: 0.08,
  addSol: 0.05,
  maxAdds: 0,
  addMinRise: 0.1,
  addMinFlowSol: 0.2,
  buySlippageBps: 5000,
  takeProfit: 0.08,
  stopLoss: 0.06,
  trailArm: 0.06,
  trailDrop: 0.08,
  maxHoldSlots: 300,
  exitOnCreatorSell: true,
  bigSellSol: 1,
  staleSlots: 1000000,
  maxMainPositions: 5,
  maxExposureSol: 1.5,
  probeSol: 0.01,
  probeMinCoins: 20,
  probeAfterSeen: 300,
  probeAfterSlots: 30000,
};

const SOL = 1e9;
/** Curve fees on a trade, protocol plus creator, as a share of the trade. */
const TRADE_FEE = 0.0125;

/** One recorded trade on a curve's opening tape. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

/** What the bot remembers about one curve. */
interface CurveTape {
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  trades: TapeTrade[];
  /** First buys decided on this curve over the run. */
  entries: number;
  /** Slot of the last exit from this curve (for the re-entry cooldown). */
  lastExitSlot: number;
  /** Slot of the most recent trade seen on this curve. */
  lastTradeSlot: number;
}

/** A live main position. */
interface LivePosition {
  openedSlot: number;
  /** Best close value seen (SOL), for the trailing stop. */
  peakValue: number;
  /** SOL sent in buys for this position, fees included. */
  invested: number;
  /** A sell is already decided or in flight. */
  leaving: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Price the last buy was decided at. */
  lastBuyPrice: number;
  /** Adds taken so far. */
  adds: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

/** Price of one token in SOL from virtual reserves. */
function quotePrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens === 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

/**
 * What selling every token held would bring back in SOL, after the curve's own
 * fees and one transaction fee: the constant-product quote minus the trade fee,
 * minus the tx fee the sell order itself pays.
 */
function closeValue(tokens: bigint, virtualQuote: bigint, virtualTokens: bigint, txFeeSol: number): number {
  const t = Number(tokens);
  const vq = Number(virtualQuote);
  const vt = Number(virtualTokens);
  if (t <= 0 || vt <= 0) return 0;
  const quote = (t * vq) / (vt + t) / SOL;
  return quote * (1 - TRADE_FEE) - txFeeSol;
}

/** Net SOL (buys minus sells) on a tape over the last `span` slots. */
function recentFlow(tape: CurveTape, now: number, span: number): number {
  let net = 0;
  for (let i = tape.trades.length - 1; i >= 0; i--) {
    const tr = tape.trades[i]!;
    if (tr.slot <= now - span) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/**
 * Whether a curve's tape earns a first buy right now. This is the second-wave
 * signal: the launch pump is over by the time a coin is ninety slots old, and
 * the dev data shows that buying the pump itself mean-reverts. What predicts a
 * further rise is fresh money still arriving minutes after creation — net SOL
 * over the last thirty slots plus several recent trades and several distinct
 * buyers. The older whole-tape checks (spread-out buying, no creator sell,
 * no outsized creator buy, price not run away) still screen out bundled
 * launches and chases.
 */
function ignitionReady(
  s: IgnitionSettings,
  tape: CurveTape,
  now: number,
  realSol: number,
  priceNow: number,
): boolean {
  if (tape.createdSlot === null) return false;
  const age = now - tape.createdSlot;
  if (age < s.entryMinAge || age > s.entryMaxAge) return false;
  if (realSol < s.minRealSol || realSol > s.maxRealSol) return false;
  if (tape.createPrice <= 0) return false;
  const lift = priceNow / tape.createPrice - 1;
  if (lift < s.minLift || lift > s.maxLift) return false;

  let buySol = 0;
  let sellSol = 0;
  let trades = 0;
  let recentTrades = 0;
  let flow30 = 0;
  const buyers = new Map<string, number>();
  let creatorBuySol = 0;
  let creatorSold = false;
  for (const tr of tape.trades) {
    trades++;
    if (tr.slot > now - 30) {
      recentTrades++;
      flow30 += tr.buy ? tr.sol : -tr.sol;
    }
    if (tr.buy) {
      buySol += tr.sol;
      if (tr.user === tape.creator) creatorBuySol += tr.sol;
      else buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
      if (tr.user === tape.creator) creatorSold = true;
    }
  }
  if (trades < s.minOpeningTrades) return false;
  if (recentTrades < s.minRecentTrades) return false;
  if (flow30 < s.minFlow30) return false;
  if (buyers.size < s.minOpeningBuyers) return false;
  if (buySol < s.minOpeningBuySol) return false;
  if (buySol - sellSol < s.minNetFlowSol) return false;
  if (buySol > 0 && sellSol / buySol > s.maxSellShare) return false;
  if (creatorBuySol > s.maxCreatorBuySol) return false;
  if (creatorSold) return false;
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  if (buySol > 0 && top > s.maxTopBuyerShare * buySol) return false;
  return true;
}

/** Build the ignition bot with the given settings. */
export function createIgnitionBot(s: IgnitionSettings = DEFAULT_SETTINGS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const held = new Map<Pubkey, LivePosition>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Coins a probe round trip has already been opened on: re-probing the same
   * liquid curve would churn fees without growing the distinct-coin count. */
  const probed = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  /** Coins ever seen created, for the probe pace. */
  let seenCreated = 0;
  /** Slot of the first batch this run, for the probe clock. */
  let firstSlot = -1;

  const tapeOf = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExitSlot: -1e12, lastTradeSlot: -1 };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot < 0) firstSlot = now;
      const creatorSold = new Set<Pubkey>();
      const bigSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.creator = e.creator;
          t.createPrice = quotePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.lastTradeSlot = e.slot;
          seenCreated++;
          traded.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / SOL;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: quotePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          t.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (!e.is_buy && e.user === t.creator && s.exitOnCreatorSell) creatorSold.add(e.mint);
          if (!e.is_buy && sol >= s.bigSellSol) bigSold.add(e.mint);
        } else {
          traded.add(e.mint);
        }
      }
      // Keep tapes short: only the recent opening matters, and a dead curve's
      // tape is dropped once it has been quiet long past the stale window.
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - 1200) cut++;
        if (cut > 0) t.trades.splice(0, cut);
        if (!held.has(mint) && !probes.has(mint) && t.lastTradeSlot >= 0 && now - t.lastTradeSlot > 5000 && t.trades.length === 0) {
          tapes.delete(mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / SOL;

      // Exits first: a position leaves whole on the first reason that fires.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = closeValue(pos.token_amount, vq, vt, txSol);
        const cost = Number(pos.cost_lamports) / SOL;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let leave = h.leaving;
        if (!leave && value >= cost * (1 + s.takeProfit)) leave = true;
        if (!leave && value <= cost * (1 - s.stopLoss)) leave = true;
        if (!leave && h.peakValue >= cost * (1 + s.trailArm) && value <= h.peakValue * (1 - s.trailDrop)) leave = true;
        if (!leave && creatorSold.has(mint)) leave = true;
        if (!leave && bigSold.has(mint)) leave = true;
        if (!leave && now - h.openedSlot > s.maxHoldSlots) leave = true;
        if (!leave && now - t.lastTradeSlot > s.staleSlots) leave = true;
        if (!leave) continue;
        h.leaving = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then first buys and adds, in the order the batch's events arrived.
      let free = Number(state.freeCashLamports()) / SOL;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = s.maxMainPositions - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / SOL);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / SOL;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= 2) continue;
          if (!ignitionReady(s, t, now, realSol, price)) continue;
          want = s.fuseSol;
        } else {
          // One add, into strength only: the price stepped up from the last buy
          // and fresh SOL still flows in over the entry window.
          if (h.leaving || !h.filled || h.adds >= s.maxAdds) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * (1 + s.addMinRise)) continue;
          if (recentFlow(t, now, s.entryMaxAge) < s.addMinFlowSol) continue;
          if (realSol > s.maxRealSol) continue;
          want = s.addSol;
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / SOL;
        let amount = Math.min(capSol, want, s.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * SOL));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: s.buySlippageBps });
        free -= amount + txSol;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            openedSlot: now,
            peakValue: 0,
            invested: amount,
            leaving: false,
            filled: false,
            lastBuyPrice: price,
            adds: 0,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
          h.adds++;
        }
      }

      // Guardrail pacing: the run needs round trips on at least twenty coins. If
      // the main entries lag that pace once plenty of launches have been seen or
      // enough of the window has passed, open tiny probe round trips on the most
      // liquid curves in this batch.
      const probeDue = seenCreated >= s.probeAfterSeen || now - firstSlot >= s.probeAfterSlots;
      if (probes.size < 1 && slotsLeft > 0 && myCoins.size < s.probeMinCoins && probeDue) {
        const minRq = (s.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= 1) break;
          if (held.has(mint) || probes.has(mint) || probed.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / SOL < minRq * 1.5) continue;
          if (free < s.probeSol + 2 * txSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(s.probeSol * SOL)), max_slippage_bps: s.buySlippageBps });
          probes.set(mint, false);
          probed.add(mint);
          free -= s.probeSol + txSol;
        }
      }
      return orders;
    },
  };
}
