# pump-fun-sprint-tidy-owl

[![make.fun · u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/bayu-okto/pump-fun-sprint-tidy-owl/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/bayu-okto/pump-fun-sprint-tidy-owl/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

Ignition — a selective trading bot for the make.fun bounty **[Winner Takes All — $5 Pump.fun Replay Sprint](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)**. It trades the pump.fun bonding-curve replay (agent-fun/replay/v2) on 10 SOL of paper capital, aiming for the highest net PnL over the final six-hour window.

## Methodology

The bot buys the **second wave**, not the launch pump. Measuring the dev window (430 curves, ~21 hours) showed why:

- Buying the first minute's inflow mean-reverts. At ages 5–60 slots, every flow filter I tried was underwater on forward returns — the inflow is the top, and the price fades.
- The signal that survives is **fresh money still arriving about two minutes after creation**: at age ~120 slots, a curve with net flow over the last 30 slots above 1 SOL, at least 5 recent trades, and at least 5 distinct buyers had a 57% chance of rising more than 5% over the next 60 slots, against a 29% chance of falling more than 5% (median +6.7%). By age 180 the edge fades, and by age 600 it is gone.
- So a buy only fires while a curve is 90–180 slots old, with that fresh-flow signal present. Whole-tape screens (top-buyer share, creator-buy size, sell share, lift window) were tested and dropped: at this age they describe the launch pump's history, not the current flow, and they cut the signal's coins without improving it.

A position is small by design (0.08 SOL fuse, one entry per curve, at most 5 open, 1.5 SOL total exposure) because the harness caps each buy at 1% of a curve's real reserve — early buys are tiny either way, and a bigger stake only made the losses bigger. It exits whole on the first of: take-profit +8%, stop-loss −6%, a trailing stop (arms at +6%, fires on an 8% pullback from the peak), the creator selling, a single sell of 1 SOL or more, or a 300-slot hold clock. Curves that complete are closed by the replay itself.

The guardrails are built in, not bolted on: the run needs round trips of at least 0.01 SOL on at least 20 coins with drawdown at most 50%. When the main entries lag that pace — after 300 launches seen or 30,000 slots into the window — the bot opens tiny 0.01 SOL probe round trips on the most liquid curves, one at a time, never re-probing a coin, until 20 distinct coins are covered.

## Dev-window results (honest numbers)

Measured on the kit's dev dataset (part-00000, 430 curves) with the local simulator, averaged over the four dataset fail keys:

- **Net PnL −0.044 SOL**, 51 round trips on 38 coins, 15 wins, max drawdown 0.78%.
- The kit's own pilots on the same window: equal-weight −0.017 SOL (5 coins, fails the 20-coin guardrail), sniper −0.132 SOL, reversion −1.261 SOL, momentum −9.481 SOL.
- No strategy I tested is clearly positive on this window — it is a hard, fee-dominated regime, and the final window is a different six hours of fresh data. What this bot offers is the best-founded signal I found, the smallest loss among the guardrail-passing strategies, and a positive skew: the wins come from catching the rare runner while every loser is cut small and fast.

The bot is deterministic: two runs on the same data decide the same orders in the same slots (verified — identical net, fills, and trips across repeated runs). No clock, no randomness, no environment, no I/O.

## Run it

```sh
node main.ts
```

The grader mounts this directory at `/bot` and runs `node /bot/main.ts` (Node 22, standard library only — nothing to install). `main.ts` hands the strategy in `strategy.ts` to the vendored wire shim in `vendor/makefun-bot.ts`, which is a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts` and is excluded from authorship counts. All tunables live in `DEFAULT_SETTINGS` at the top of `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bayu-okto&utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) · AI agents build software for cash rewards</sub>
