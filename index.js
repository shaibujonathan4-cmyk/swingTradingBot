const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

require('dotenv').config();
const express = require('express');

const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Forex Bot Running...');
});

app.listen(PORT, () => {
    console.log(`🌍 Server running on port ${PORT}`);
});

const CONFIG = {
    API_KEY: process.env.TWELVE_API_KEY,
    CHAT_ID: process.env.CHAT_ID,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,

    PAIRS: [
        ["EUR", "USD"],
        ["GBP", "USD"],
        ["USD", "JPY"],
        ["USD", "CHF"]
    ],

    SL_PIPS: 20,
    TP_PIPS: 60
};

/* =========================
   SAFETY CONTROLS
========================= */
const sentSignals = {};
let isRunning = false;

// Initialize Telegram Bot
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN);

// Sleep function to avoid API limits
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   WEEKEND CHECK
========================= */
function isWeekend() {
    const day = new Date().getDay();
    return (day === 0 || day === 6);
}

// Fetch Forex Data (Twelve Data)
async function getDailyFX(from, to) {

    const url =
        `https://api.twelvedata.com/time_series?symbol=${from}/${to}&interval=15min&outputsize=5&apikey=${CONFIG.API_KEY}`;

    try {

        const response = await axios.get(url, {
            timeout: 15000
        });

        const data = response.data.values;

        if (!data || response.data.status === "error") {
            console.log(`❌ API issue for ${from}/${to}`);
            console.log(response.data);
            return null;
        }

        return data.slice(0, 5).map(candle => ({
            date: candle.datetime,
            o: parseFloat(candle.open),
            h: parseFloat(candle.high),
            l: parseFloat(candle.low),
            c: parseFloat(candle.close)
        }));

    } catch (e) {

        console.log(`❌ Connection failed for ${from}/${to}`);
        return null;
    }
}

// Analyze Market (UNCHANGED LOGIC)
async function analyze(candles, pair) {

    const today = candles[0];
    const yesterday = candles[1];
    const dayBefore = candles[2];

    let confidence = 0;
    let signal = "NEUTRAL";

    const isUpTrend =
        today.c > yesterday.c &&
        yesterday.c > dayBefore.c;

    const isDownTrend =
        today.c < yesterday.c &&
        yesterday.c < dayBefore.c;

    const isBullishPinBar =
        (today.c > today.o) &&
        (today.h - today.c < (today.c - today.l) * 0.5);

    const isBearishPinBar =
        (today.c < today.o) &&
        (today.c - today.l < (today.h - today.c) * 0.5);

    if (isUpTrend) {

        signal = "BUY";
        confidence = 60;

        if (isBullishPinBar)
            confidence += 20;

    } else if (isDownTrend) {

        signal = "SELL";
        confidence = 60;

        if (isBearishPinBar)
            confidence += 20;
    }

    if (signal !== "NEUTRAL") {

        const pip =
            pair.includes("JPY")
                ? 0.01
                : 0.0001;

        const entry = today.c;

        const sl =
            signal === "BUY"
                ? entry - (CONFIG.SL_PIPS * pip)
                : entry + (CONFIG.SL_PIPS * pip);

        const tp =
            signal === "BUY"
                ? entry + (CONFIG.TP_PIPS * pip)
                : entry - (CONFIG.TP_PIPS * pip);

        console.log(`\n🔥 ${pair} => ${signal}`);

        console.table({
            Confidence: `${confidence}%`,
            Entry: entry.toFixed(5),
            SL: sl.toFixed(5),
            TP: tp.toFixed(5)
        });

        const signalKey = `${pair}-${signal}-${today.date}`;

        if (sentSignals[signalKey]) {
            console.log(`🔁 Duplicate signal skipped for ${pair}`);
            return;
        }

        sentSignals[signalKey] = true;

        try {
            await bot.sendMessage(
                CONFIG.CHAT_ID,
`🔥 FOREX SIGNAL

Pair: ${pair}
Direction: ${signal}
Confidence: ${confidence}%

Entry: ${entry.toFixed(5)}
SL: ${sl.toFixed(5)}
TP: ${tp.toFixed(5)}

Strategy: Intraday Trend
Time: ${new Date().toLocaleString()}`
            );
        } catch (err) {
            console.log("⚠️ Telegram send failed");
        }

    } else {

        console.log(`😴 ${pair} => No clear setup`);
    }
}

// Main Bot Runner
async function runBot() {

    if (isWeekend()) {
        console.log("⏸ Weekend detected — market closed. Bot paused.");
        return;
    }

    if (isRunning) {
        console.log("⚠️ Bot already running. Skipping cycle...");
        return;
    }

    isRunning = true;

    console.log(`\n==============================`);
    console.log(`🚀 Forex Signal Bot Started`);
    console.log(`==============================`);

    try {

        for (const [from, to] of CONFIG.PAIRS) {

            const pair = `${from}/${to}`;

            console.log(`\n🔎 Analyzing ${pair}`);

            const candles = await getDailyFX(from, to);

            if (candles)
                await analyze(candles, pair);

            await sleep(5000);
        }

        console.log(`\n✅ Analysis Complete\n`);

    } catch (err) {
        console.error("❌ RunBot error:", err);
    }

    isRunning = false;
}

/* =========================
   ERROR PROTECTION
========================= */
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Promise Rejection:', reason);
});

// Start system
async function start() {
    await runBot();
}

start();

setInterval(start, 15 * 60 * 1000);