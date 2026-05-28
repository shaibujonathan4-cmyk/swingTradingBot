const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const express = require('express');

const app = express();

/* =========================
   CONFIGURATION
========================= */
const CONFIG = {
    PORT: process.env.PORT || 3000,
    API_KEY: process.env.TWELVE_API_KEY,
    CHAT_ID: process.env.CHAT_ID,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    APP_URL: process.env.APP_URL, // Your Render/Heroku URL

    PAIRS: [
        ["EUR/USD"],
        ["GBP/USD"],
        ["USD/JPY"],
        ["USD/CHF"]
    ],

    ATR_PERIOD: 14,
    RISK_MULTIPLIER: 1.5, // Recommended: 1.5 - 2.0 for better breathing room
    TP_RATIO: 2.0,        // 1:2 Risk/Reward
    STRENGTH_THRESHOLD: 60
};

/* =========================
   TELEGRAM BOT
========================= */
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

/* =========================
   GLOBAL STATE
========================= */
const state = {
    sentSignals: new Set(),
    running: false,
    lastRun: null
};

/* =========================
   SERVER (HEALTH CHECK)
========================= */
app.get('/', (req, res) => res.send('Forex Bot Engine Online'));
app.get('/health', (req, res) => {
    res.json({
        status: "healthy",
        uptime: Math.floor(process.uptime()) + "s",
        lastRun: state.lastRun
    });
});

app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Running on port ${CONFIG.PORT}`);
});

/* =========================
   UTILITIES
========================= */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* =========================
   KEEP ALIVE (ANTI-SLEEP)
========================= */
async function keepAlive() {
    if (!CONFIG.APP_URL) return;
    try {
        await axios.get(`${CONFIG.APP_URL}/health`, { timeout: 5000 });
        console.log("💓 Keep-alive ping success");
    } catch (e) {
        console.log("📡 Keep-alive failed: Platform may be sleeping");
    }
}

/* =========================
   FETCH MARKET DATA (HARDENED)
========================= */
async function fetchMarketData(symbol, interval, size = 30, retry = 2) {
    // CRITICAL: Added &order=DESC to get NEWEST data first
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${size}&apikey=${CONFIG.API_KEY}&order=DESC`;

    for (let i = 0; i < retry; i++) {
        try {
            const res = await axios.get(url, { timeout: 12000 });
            if (!res.data.values) throw new Error(res.data.message || "No data");

            return res.data.values.map(c => ({
                o: +c.open,
                h: +c.high,
                l: +c.low,
                c: +c.close,
                t: c.datetime
            }));
        } catch (e) {
            if (i === retry - 1) return null;
            await sleep(2000);
        }
    }
}

/* =========================
   INDICATORS
========================= */
function getTrendScore(data, lookback = 6) {
    let score = 0;
    for (let i = 0; i < lookback; i++) {
        if (!data[i + 1]) break;
        if (data[i].c > data[i + 1].c) score += 15;
        if (data[i].c < data[i + 1].c) score -= 15;
    }
    return score;
}

function calculateATR(data, period = 14) {
    let tr = [];
    for (let i = 0; i < period && i + 1 < data.length; i++) {
        const h = data[i].h, l = data[i].l, prevC = data[i + 1].c;
        tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    }
    return tr.reduce((a, b) => a + b, 0) / period;
}

/* =========================
   ANALYSIS ENGINE
========================= */
async function processPair(pair) {
    const h4 = await fetchMarketData(pair, '4h', 20);
    const m15 = await fetchMarketData(pair, '15min', 40);

    if (!h4 || !m15) return;

    // 1. Check for stale data (Max 30 mins old)
    const candleTime = new Date(m15[0].t).getTime();
    if (Date.now() - candleTime > 30 * 60 * 1000) {
        console.log(`📜 Skipping stale data for ${pair}`);
        return;
    }

    // 2. Bias & Strength
    const biasScore = getTrendScore(h4);
    const bias = biasScore > 30 ? "BUY" : biasScore < -30 ? "SELL" : "NEUTRAL";
    const m15Score = Math.abs(getTrendScore(m15));

    if (bias === "NEUTRAL" || m15Score < CONFIG.STRENGTH_THRESHOLD) return;

    // 3. Signal Logic (using m15[1] as the last CLOSED candle)
    const last = m15[1];
    const prev = m15[2];
    const range = last.h - last.l;
    const body = Math.abs(last.c - last.o);
    const lowerWick = Math.min(last.c, last.o) - last.l;
    const upperWick = last.h - Math.max(last.c, last.o);

    const bullPin = lowerWick > range * 0.6 && body < range * 0.25;
    const bearPin = upperWick > range * 0.6 && body < range * 0.25;

    let signal = "NEUTRAL";
    if (bias === "BUY" && (last.c > prev.c || bullPin)) signal = "BUY";
    if (bias === "SELL" && (last.c < prev.c || bearPin)) signal = "SELL";

    if (signal === "NEUTRAL") return;

    // 4. Levels (Risk-Adjusted)
    const atr = calculateATR(m15, CONFIG.ATR_PERIOD);
    const entry = last.c;
    const risk = atr * CONFIG.RISK_MULTIPLIER;
    const sl = signal === "BUY" ? entry - risk : entry + risk;
    const tp = signal === "BUY" ? entry + (risk * CONFIG.TP_RATIO) : entry - (risk * CONFIG.TP_RATIO);

    // 5. Duplicate Filter
    const id = `${pair}-${signal}-${last.t}`;
    if (state.sentSignals.has(id)) return;
    state.sentSignals.add(id);

    // 6. Time Conversion (Nigeria WAT)
    const dateObj = new Date(last.t);
    const nigeriaTime = dateObj.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });

    try {
        await bot.sendMessage(CONFIG.CHAT_ID,
`🔥 *PRO SIGNAL*
━━━━━━━━━━━━━━
Pair: \`${pair}\`
Bias: *${bias}*
Action: *${signal === 'BUY' ? '🚀 BUY' : '📉 SELL'}*

Entry: \`${entry.toFixed(5)}\`
SL: \`${sl.toFixed(5)}\`
TP: \`${tp.toFixed(5)}\`
RRR: 1:${CONFIG.TP_RATIO}
━━━━━━━━━━━━━━
Chart Time: ${last.t}
Nigeria Time: ${nigeriaTime}`, { parse_mode: "Markdown" });
        console.log(`✅ Signal sent: ${pair}`);
    } catch (e) {
        console.log("❌ Telegram failed");
    }
}

/* =========================
   SYSTEM RUNNERS
========================= */
async function runCycle() {
    if (state.running || [0, 6].includes(new Date().getDay())) return;
    state.running = true;
    state.lastRun = new Date().toLocaleString('en-NG');

    console.log(`\n🚀 ANALYSIS CYCLE: ${state.lastRun}`);

    for (const [pair] of CONFIG.PAIRS) {
        await processPair(pair);
        await sleep(7000); // Rate limit safety
    }
    state.running = false;
}

async function heartbeat() {
    try {
        await bot.sendMessage(CONFIG.CHAT_ID, `💓 *BOT HEARTBEAT*\nStatus: ACTIVE\nLast Run: ${state.lastRun || "Initializing..."}`, { parse_mode: "Markdown" });
    } catch (e) {}
}

/* =========================
   START
========================= */
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

setInterval(runCycle, 5 * 60 * 1000);
setInterval(keepAlive, 4 * 60 * 1000);
setInterval(heartbeat, 60 * 60 * 1000);

runCycle();
heartbeat();
