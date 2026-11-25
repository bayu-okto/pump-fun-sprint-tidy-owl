// Ignition bot: a selective launch sniper for the pump.fun replay sprint.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot. The
// hello message carries the run's caps and fees; the bot answers one batch at a
// time with its orders for that slot. The strategy lives in strategy.ts; the wire
// protocol lives in the vendored SDK shim beside it (vendor/makefun-bot.ts is a
// byte-identical copy of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createIgnitionBot, DEFAULT_SETTINGS } from './strategy.ts';

await runBot(createIgnitionBot(DEFAULT_SETTINGS));
