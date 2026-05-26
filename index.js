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
    API_KEY: process.env.AV_API_KEY,
    CHAT_ID: process.env.CHAT_ID,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,

    PAIRS: [
        ["EUR", "USD"],
        ["GBP", "USD"],
        ["USD", "JPY"],
        ["USD", "CHF"]
    ],

    SL_PIPS: 50,
    TP_PIPS: 100
};

/* =========================
   DUPLICATE SIGNAL FILTER
========================= */
const sentSignals = {};

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

// Fetch Forex Daily Data
async function getDailyFX(from, to) {

    const url =
        `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&apikey=${CONFIG.API_KEY}`;

    try {

        const response = await axios.get(url);

        const data = response.data["Time Series FX (Daily)"];

        if (!data) {
            console.log(`❌ API issue for ${from}/${to}`);
            return null;
        }

        return Object.keys(data)
            .slice(0, 5)
            .map(date => ({
                date,
                o: parseFloat(data[date]["1. open"]),
                h: parseFloat(data[date]["2. high"]),
                l: parseFloat(data[date]["3. low"]),
                c: parseFloat(data[date]["4. close"])
            }));

    } catch (e) {

        console.log(`❌ Connection failed for ${from}/${to}`);
        return null;
    }
}

// Analyze Market
async function analyze(candles, pair) {

    const today = candles[0];
    const yesterday = candles[1];
    const dayBefore = candles[2];

    let confidence = 0;
    let signal = "NEUTRAL";

    // Trend Detection
    const isUpTrend =
        today.c > yesterday.c &&
        yesterday.c > dayBefore.c;

    const isDownTrend =
        today.c < yesterday.c &&
        yesterday.c < dayBefore.c;

    // Pin Bar Detection
    const isBullishPinBar =
        (today.c > today.o) &&
        (today.h - today.c < (today.c - today.l) * 0.5);

    const isBearishPinBar =
        (today.c < today.o) &&
        (today.c - today.l < (today.h - today.c) * 0.5);

    // Signal Logic
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

    // Trade Setup
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

        /* =========================
           DUPLICATE CHECK
        ========================= */
        const signalKey = `${pair}-${signal}-${today.date}`;

        if (sentSignals[signalKey]) {
            console.log(`🔁 Duplicate signal skipped for ${pair}`);
            return;
        }

        sentSignals[signalKey] = true;

        // Send Telegram Alert
        await bot.sendMessage(
            CONFIG.CHAT_ID,

`🔥 FOREX SIGNAL

Pair: ${pair}
Direction: ${signal}
Confidence: ${confidence}%

Entry: ${entry.toFixed(5)}
SL: ${sl.toFixed(5)}
TP: ${tp.toFixed(5)}

Strategy: Swing Trade
Time: ${new Date().toLocaleString()}`
        );

    } else {

        console.log(`😴 ${pair} => No clear setup`);
    }
}

// Main Bot Runner
async function runBot() {

    /* =========================
       WEEKEND STOP
    ========================= */
    if (isWeekend()) {
        console.log("⏸ Weekend detected — market closed. Bot paused.");
        return;
    }

    console.log(`\n==============================`);
    console.log(`🚀 Forex Signal Bot Started`);
    console.log(`==============================`);

    for (const [from, to] of CONFIG.PAIRS) {

        const pair = `${from}/${to}`;

        console.log(`\n🔎 Analyzing ${pair}`);

        const candles = await getDailyFX(from, to);

        if (candles)
            await analyze(candles, pair);

        // Prevent Alpha Vantage rate limit
        await sleep(15000);
    }

    console.log(`\n✅ Analysis Complete\n`);
}

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);

    console.log('🔁 Restarting bot in 5 seconds...');
    setTimeout(() => {
        runBot();
    }, 5000);
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Promise Rejection:', reason);

    console.log('🔁 Continuing safely...');
});

async function start() {
    try {
        await runBot();
    } catch (err) {
        console.error('❌ Bot crashed safely:', err);
    }
}

// Run immediately
start();

// Run every 1 hour safely
setInterval(() => {
    start();
}, 60 * 60 * 1000);