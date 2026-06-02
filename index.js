// ==========================================
// LIQUIDITY BREAK & RETEST BOT v5 (PRODUCTION)
// ==========================================

const axios = require("axios");
const express = require("express");
require("dotenv").config();

// ==========================================
// CONFIG
// ==========================================
const CONFIG = {
    BASE_URL: "https://api.twelvedata.com/time_series",
    API_KEY: process.env.TWELVE_DATA_API_KEY || "YOUR_KEY",
    SYMBOL: "EUR/USD",

    TELEGRAM: {
        TOKEN: process.env.TELEGRAM_TOKEN,
        CHAT_ID: process.env.CHAT_ID
    },

    RULES: {
        "EUR/USD": {
            sessions: [{ start: 6, end: 9 }, { start: 12, end: 16 }],
            minRR: 3,
            atrMultSL: 1.5,
            zoneBufferATR: 0.2
        }
    },

    LTF_INTERVAL: 15000 // IMPORTANT: reduced to avoid API limit
};

// ==========================================
// STATE
// ==========================================
let STATE = {
    d1Bias: "NONE",
    atr: 0,
    h4Resistance: 0,
    h4Support: 0,
    lastRun: 0
};

// ==========================================
// EXPRESS KEEP ALIVE (RENDER)
// ==========================================
const app = express();

app.get("/", (req, res) => {
    res.send("🚀 Liquidity Bot Running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Keep-alive server running"));

// ==========================================
// TELEGRAM SENDER
// ==========================================
async function sendTelegram(message) {
    if (!CONFIG.TELEGRAM.TOKEN || !CONFIG.TELEGRAM.CHAT_ID) return;

    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.TOKEN}/sendMessage`;

    try {
        await axios.post(url, {
            chat_id: CONFIG.TELEGRAM.CHAT_ID,
            text: message,
            parse_mode: "HTML"
        });
    } catch (err) {
        console.error("[TELEGRAM ERROR]", err.message);
    }
}

// ==========================================
// DATA FETCH
// ==========================================
async function fetchCandles(tf, size = 50) {
    const url = `${CONFIG.BASE_URL}?symbol=${CONFIG.SYMBOL}&interval=${tf}&outputsize=${size}&apikey=${CONFIG.API_KEY}`;

    try {
        const res = await axios.get(url);
        if (!res.data?.values) return null;

        return res.data.values.reverse().map(c => ({
            o: +c.open,
            h: +c.high,
            l: +c.low,
            c: +c.close
        }));
    } catch {
        return null;
    }
}

// ==========================================
// ATR
// ==========================================
function ATR(candles, period = 14) {
    const trs = [];

    for (let i = 1; i < candles.length; i++) {
        trs.push(Math.max(
            candles[i].h - candles[i].l,
            Math.abs(candles[i].h - candles[i - 1].c),
            Math.abs(candles[i].l - candles[i - 1].c)
        ));
    }

    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ==========================================
// LIQUIDITY ENGINE
// ==========================================
class LiquidityZoneEngine {

    getSwings(candles, lb = 3) {
        const highs = [];
        const lows = [];

        for (let i = lb; i < candles.length - lb; i++) {
            const c = candles[i];

            const isHigh = candles.slice(i - lb, i + lb + 1)
                .every(x => c.h >= x.h);

            const isLow = candles.slice(i - lb, i + lb + 1)
                .every(x => c.l <= x.l);

            if (isHigh) highs.push(c.h);
            if (isLow) lows.push(c.l);
        }

        return { highs, lows };
    }

    getStrongZones(candles, atr) {
        const { highs, lows } = this.getSwings(candles);

        const tolerance = atr * 0.25;

        const match = (levels) => {
            const zones = [];

            for (let i = 0; i < levels.length; i++) {
                let count = 1;

                for (let j = i + 1; j < levels.length; j++) {
                    if (Math.abs(levels[i] - levels[j]) <= tolerance) {
                        count++;
                    }
                }

                if (count >= 2) zones.push(levels[i]);
            }

            return zones;
        };

        return {
            highs: match(highs),
            lows: match(lows)
        };
    }
}

// ==========================================
// STRATEGY ENGINE (CANDLE CLOSE ONLY LOGIC)
// ==========================================
class BreakRetestEngine {

    constructor() {
        this.state = {
            sweep: null,
            breakoutLevel: 0,
            direction: "NONE",
            armed: false
        };
    }

    bull(c) {
        return c.c > c.o;
    }

    bear(c) {
        return c.c < c.o;
    }

    detectSweep(c, level) {
        if (c.h > level && c.c < level) return "HIGH";
        if (c.l < level && c.c > level) return "LOW";
        return "NONE";
    }

    onClose(candle, context) {

        const buffer = context.atr * 0.2;

        // 1. SWEEP
        if (!this.state.sweep) {
            const highSweep = this.detectSweep(candle, context.liquidityHigh);
            const lowSweep = this.detectSweep(candle, context.liquidityLow);

            if (highSweep !== "NONE") {
                this.state.sweep = "HIGH";
                this.state.breakoutLevel = context.liquidityHigh;
            }

            if (lowSweep !== "NONE") {
                this.state.sweep = "LOW";
                this.state.breakoutLevel = context.liquidityLow;
            }

            return null;
        }

        // 2. ARMING
        if (!this.state.armed) {
            if (this.state.sweep === "HIGH" && candle.c < this.state.breakoutLevel) {
                this.state.armed = true;
                this.state.direction = "BEARISH";
            }

            if (this.state.sweep === "LOW" && candle.c > this.state.breakoutLevel) {
                this.state.armed = true;
                this.state.direction = "BULLISH";
            }

            return null;
        }

        // 3. RETEST ZONE (ONLY CLOSED CANDLES)
        const inZone =
            candle.l <= this.state.breakoutLevel + buffer &&
            candle.h >= this.state.breakoutLevel - buffer;

        if (!inZone) return null;

        // 4. CONFIRMATION (CLOSE ONLY)
        const valid =
            (this.state.direction === "BULLISH" && this.bull(candle)) ||
            (this.state.direction === "BEARISH" && this.bear(candle));

        if (!valid) return null;

        const signal = {
            direction: this.state.direction,
            entry: candle.c,
            level: this.state.breakoutLevel,
            time: new Date().toISOString()
        };

        this.reset();
        return signal;
    }

    reset() {
        this.state = {
            sweep: null,
            breakoutLevel: 0,
            direction: "NONE",
            armed: false
        };
    }
}

// ==========================================
// INIT
// ==========================================
const liquidityEngine = new LiquidityZoneEngine();
const strategy = new BreakRetestEngine();

// ==========================================
// MAIN LOOP (SAFE FOR API LIMITS)
// ==========================================
async function run() {

    const now = Date.now();
    if (now - STATE.lastRun < CONFIG.LTF_INTERVAL) return;
    STATE.lastRun = now;

    const h4 = await fetchCandles("4h", 50);
    const d1 = await fetchCandles("1day", 30);
    if (!h4 || !d1) return;

    STATE.atr = ATR(h4);

    const zones = liquidityEngine.getStrongZones(h4, STATE.atr);

    STATE.h4Resistance = zones.highs[zones.highs.length - 1] || Math.max(...h4.map(c => c.h));
    STATE.h4Support = zones.lows[zones.lows.length - 1] || Math.min(...h4.map(c => c.l));

    STATE.d1Bias = d1[d1.length - 1].c > d1[d1.length - 2].c ? "BULLISH" : "BEARISH";

    const m15 = await fetchCandles("15min", 20);
    if (!m15) return;

    const last = m15[m15.length - 1];

    const signal = strategy.onClose(last, {
        atr: STATE.atr,
        liquidityHigh: STATE.h4Resistance,
        liquidityLow: STATE.h4Support
    });

    if (signal) {

        const message = `
🔥 <b>LIQUIDITY BREAK & RETEST SIGNAL</b>

📊 Pair: ${CONFIG.SYMBOL}
📈 Direction: ${signal.direction}
💰 Entry: ${signal.entry}
📍 Level: ${signal.level}
⏰ Time: ${signal.time}
        `;

        console.log(message);
        await sendTelegram(message);
    }
}

// ==========================================
// START BOT
// ==========================================
setInterval(run, CONFIG.LTF_INTERVAL);

console.log("🚀 Liquidity Break & Retest Bot Running (PRODUCTION READY)");