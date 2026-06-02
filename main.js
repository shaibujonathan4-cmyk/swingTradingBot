// main.js
import { TopDownStrategy } from './strategy.js';

// Simulated engine data state fed continuously from market WebSockets
const mockMarketData = {
    D1: [
        { open: 1.0800, high: 1.0920, low: 1.0790, close: 1.0910 }, // Previous Day
        { open: 1.0910, high: 1.1050, low: 1.0900, close: 1.1040 }  // Current Day (Strong Bullish Bias)
    ],
    H4: [
        { open: 1.0900, high: 1.0950, low: 1.0890, close: 1.0940 },
        { open: 1.0940, high: 1.1020, low: 1.0930, close: 1.1010 }  // Confirmed clean breakout past 1.0950
    ],
    M15: [
        { open: 1.1010, high: 1.1015, low: 1.0980, close: 1.0985 }, // Large drop candle back down
        { open: 1.0985, high: 1.0990, low: 1.0965, close: 1.0970 }, // Smaller drop candle
        { open: 1.0970, high: 1.0975, low: 1.0952, close: 1.0955 }  // Tiny drop candle (Fading Momentum detected)
    ]
};

// Target key structural institutional levels identified on chart
const macroLevels = {
    resistance: 1.0950,
    support: 1.0750
};

const eurusdBot = new TopDownStrategy("EUR/USD");
const decision = eurusdBot.analyze(mockMarketData, macroLevels);

console.log(`=== STRADING LIVE ENGINE LOGS ===`);
console.log(`Asset: EUR/USD`);
console.log(`Decision Action: ${decision.action}`);
console.log(`System Rationale: ${decision.reason}`);
