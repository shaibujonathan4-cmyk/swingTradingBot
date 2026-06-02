// strategy.js
import { ASSET_RULES } from './config.js';

export class TopDownStrategy {
    constructor(symbol) {
        this.symbol = symbol;
        this.rules = ASSET_RULES[symbol];
    }

    // Step 1: Check D1 Trend Bias
    getDailyBias(d1Candles) {
        const last = d1Candles[d1Candles.length - 1];
        const prev = d1Candles[d1Candles.length - 2];
        
        if (last.close > prev.high) return "BULLISH";
        if (last.close < prev.low) return "BEARISH";
        return "NEUTRAL";
    }

    // Step 2: Validate H4 Breakout (Requires strong body close, not a wick)
    validateH4Breakout(h4Candles, keyResistanceLevel, keySupportLevel) {
        const triggerCandle = h4Candles[h4Candles.length - 1];
        const bodySize = Math.abs(triggerCandle.close - triggerCandle.open);
        const totalSize = triggerCandle.high - triggerCandle.low;
        const bodyRatio = bodySize / (totalSize || 1);

        // A strong breakout candle should have a body occupying > 50% of its total range
        const isStrongBody = bodyRatio > 0.50;

        if (isStrongBody && triggerCandle.close > keyResistanceLevel) {
            return { type: "BULL_BREAKOUT", level: keyResistanceLevel };
        }
        if (isStrongBody && triggerCandle.close < keySupportLevel) {
            return { type: "BEAR_BREAKOUT", level: keySupportLevel };
        }
        return { type: "NONE", level: null };
    }

    // Step 3: Rule for Retests (Fading Momentum Check)
    isMomentumFading(m15Candles, direction) {
        const depth = 3; // Look at the last 3 retest candles
        if (m15Candles.length < depth) return false;

        const recentCandles = m15Candles.slice(-depth);
        let sizes = recentCandles.map(c => Math.abs(c.close - c.open));

        // Check if candle bodies are strictly shrinking (deceleration)
        if (direction === "BULLISH") {
            // Price coming down to support; candles should get smaller
            return sizes[2] < sizes[1] && sizes[1] < sizes[0];
        } else {
            // Price bouncing up to resistance; candles should get smaller
            return sizes[2] < sizes[1] && sizes[1] < sizes[0];
        }
    }

    // Time Filter Check
    isWithinSession() {
        const currentUtcHour = new Date().getUTCHours();
        return this.rules.allowedSessions.some(
            session => currentUtcHour >= session.start && currentUtcHour < session.end
        );
    }

    // Master execution gateway
    analyze(marketData, structuralLevels) {
        if (!this.isWithinSession()) return { action: "WAIT", reason: "Outside allowed trading session hours." };

        const dailyBias = this.getDailyBias(marketData.D1);
        if (dailyBias === "NEUTRAL") return { action: "WAIT", reason: "No clear Daily market bias direction." };

        const breakout = this.validateH4Breakout(marketData.H4, structuralLevels.resistance, structuralLevels.support);
        
        // Alignment Check: D1 trend must match H4 breakout direction
        if (dailyBias === "BULLISH" && breakout.type === "BULL_BREAKOUT") {
            const lowMomentum = this.isMomentumFading(marketData.M15, "BULLISH");
            
            if (lowMomentum) {
                return {
                    action: "EXECUTE_BUY",
                    entry: breakout.level,
                    reason: "D1 Bullish, H4 Breakout validated, M15 Retest fading momentum into flipped support."
                };
            }
            return { action: "WAIT", reason: "H4 Breakout valid. Awaiting slow/fading M15 retest profile." };
        }

        if (dailyBias === "BEARISH" && breakout.type === "BEAR_BREAKOUT") {
            const lowMomentum = this.isMomentumFading(marketData.M15, "BEARISH");
            
            if (lowMomentum) {
                return {
                    action: "EXECUTE_SELL",
                    entry: breakout.level,
                    reason: "D1 Bearish, H4 Breakout validated, M15 Retest fading momentum into flipped resistance."
                };
            }
            return { action: "WAIT", reason: "H4 Breakout valid. Awaiting slow/fading M15 retest profile." };
        }

        return { action: "WAIT", reason: "No structural setups match trend criteria currently." };
    }
}
