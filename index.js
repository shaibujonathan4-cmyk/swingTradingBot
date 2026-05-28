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
    APP_URL: process.env.APP_URL,

    PAIRS: [["EUR/USD"], ["GBP/USD"], ["USD/JPY"], ["USD/CHF"]],

    ATR_PERIOD: 14,
    RISK_MULTIPLIER: 1.0,
    TP_RATIO: 2.0,
    STRENGTH_THRESHOLD: 60
};

const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

const state = {
    sentSignals: new Set(),
    running: false,
    lastRun: null
};

/* =========================
   SERVER
========================= */
app.get('/', (req, res) => res.send('System Online'));
app.get('/health', (req, res) => res.json({
    status: "healthy",
    uptime: process.uptime(),
    lastRun: state.lastRun
}));

app.listen(CONFIG.PORT, () =>
    console.log(`🚀 Running on port ${CONFIG.PORT}`)
);

/* =========================
   UTILITIES
========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
   KEEP ALIVE
========================= */
async function keepAlive() {
    if (!CONFIG.APP_URL) return;
    try {
        await axios.get(`${CONFIG.APP_URL}/health`, { timeout: 5000 });
    } catch (e) {
        console.log("📡 Keep-alive failed");
    }
}

/* =========================
   DATA FETCH (WITH RETRY)
========================= */
async function fetchMarketData(symbol, interval, size = 30, retry = 2) {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${size}&apikey=${CONFIG.API_KEY}`;

    for (let i = 0; i < retry; i++) {
        try {
            const res = await axios.get(url, { timeout: 12000 });

            if (!res.data.values) {
                throw new Error(res.data.message || "No data");
            }

            return res.data.values.map(c => ({
                o: +c.open,
                h: +c.high,
                l: +c.low,
                c: +c.close,
                t: c.datetime
            }));

        } catch (e) {
            if (i === retry - 1) {
                console.log(`❌ Final fail: ${symbol}`);
                return null;
            }
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
        const high = data[i].h;
        const low = data[i].l;
        const prevClose = data[i + 1].c;

        tr.push(Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        ));
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

    const biasScore = getTrendScore(h4);
    const bias =
        biasScore > 30 ? "BUY" :
        biasScore < -30 ? "SELL" : "NEUTRAL";

    if (bias === "NEUTRAL") return;

    const m15Score = Math.abs(getTrendScore(m15));
    if (m15Score < CONFIG.STRENGTH_THRESHOLD) return;

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

    const atr = calculateATR(m15, CONFIG.ATR_PERIOD);
    const entry = last.c;

    const sl = signal === "BUY"
        ? entry - atr * CONFIG.RISK_MULTIPLIER
        : entry + atr * CONFIG.RISK_MULTIPLIER;

    const tp = signal === "BUY"
        ? entry + atr * CONFIG.TP_RATIO
        : entry - atr * CONFIG.TP_RATIO;

    const id = `${pair}-${signal}-${last.t}`;
    if (state.sentSignals.has(id)) return;

    state.sentSignals.add(id);

    await bot.sendMessage(CONFIG.CHAT_ID,
`🔥 SIGNAL

Pair: ${pair}
Bias: ${bias}
Signal: ${signal}

Entry: ${entry.toFixed(5)}
SL: ${sl.toFixed(5)}
TP: ${tp.toFixed(5)}

Time: ${last.t}`
    );

    console.log(`✅ Signal sent: ${pair}`);
}

/* =========================
   HEARTBEAT (IMPORTANT)
========================= */
async function heartbeat() {
    try {
        await bot.sendMessage(CONFIG.CHAT_ID,
`💓 BOT HEARTBEAT

Status: ACTIVE
Time: ${new Date().toLocaleString()}
Last Run: ${state.lastRun || "Never"}`
        );
    } catch (e) {}
}

/* =========================
   RUNNER
========================= */
async function runCycle() {

    if (state.running) return;
    state.running = true;

    const day = new Date().getDay();
    if (day === 0 || day === 6) {
        state.running = false;
        return;
    }

    state.lastRun = new Date().toLocaleString();

    for (const [pair] of CONFIG.PAIRS) {
        await processPair(pair);
        await sleep(7000);
    }

    console.log("✅ Cycle complete");
    state.running = false;
}

/* =========================
   SAFETY
========================= */
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

/* =========================
   START SYSTEM
========================= */
setInterval(runCycle, 5 * 60 * 1000);
setInterval(keepAlive, 4 * 60 * 1000);
setInterval(heartbeat, 60 * 60 * 1000); // 💓 every hour

runCycle();