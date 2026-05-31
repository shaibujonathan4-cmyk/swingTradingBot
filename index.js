require("dotenv").config(); 
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");

const app = express();

/* =========================
CONFIG
========================= */
const ENV = (typeof process !== "undefined" && process && process.env) ? process.env : {};

const CONFIG = {
    PORT: ENV.PORT || 3000,
    API_KEY: ENV.TWELVE_API_KEY,
    TELEGRAM_TOKEN: ENV.TELEGRAM_TOKEN,
    CHAT_ID: ENV.CHAT_ID,
    APP_URL: ENV.APP_URL,
    PAIRS: ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF"],
    TIMEFRAME: "1h",
    LOOKBACK: 150,
    MAX_WAIT_CANDLES: 5,
    ATR_PERIOD: 14,
    MIN_RR: 1.5
};

/* =========================
STATE + METRICS (FIXED SAFETY)
========================= */
const STATE_FILE = "./state.json";

const metrics = {
    cycles: 0,
    setupsDetected: 0,
    setupsInvalidated: 0,
    signalsSent: 0,
    errors: 0
};

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return { activeSetup: {}, sentSignals: [] };
    }

    try {
        const raw = fs.readFileSync(STATE_FILE, "utf-8");
        if (!raw) return { activeSetup: {}, sentSignals: [] };

        const data = JSON.parse(raw);

        return {
            activeSetup: data.activeSetup || {},
            sentSignals: Array.isArray(data.sentSignals) ? data.sentSignals : []
        };

    } catch (e) {
        return { activeSetup: {}, sentSignals: [] };
    }
}

const state = loadState();
state.sentSignals = new Set(state.sentSignals);

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        activeSetup: state.activeSetup,
        sentSignals: [...state.sentSignals]
    }, null, 2));
}

/* =========================
BOT + SERVER
========================= */
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

app.get("/", (_, res) => res.send("Pro Trading Bot Running"));

app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        uptime: process.uptime(),
        activeSetups: Object.keys(state.activeSetup).length,
        sentSignals: state.sentSignals.size,
        lastCycle: metrics.cycles
    });
});

app.get("/metrics", (req, res) => {
    res.json(metrics);
});

app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Server running on port ${CONFIG.PORT}`);
});

/* =========================
UTILS
========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function keepAlive() {
    if (!CONFIG.APP_URL) return;

    try {
        await axios.get(`${CONFIG.APP_URL}/health`, { timeout: 5000 });
        console.log(`[KEEPALIVE] OK`);
    } catch (err) {
        console.log(`[KEEPALIVE] FAILED`);
    }
}

async function fetchWithRetry(url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            return await axios.get(url, { timeout: 15000 });
        } catch (err) {
            console.log(`[RETRY ${i}] Failed`);
            if (i === retries) throw err;
            await sleep(2000);
        }
    }
}

/* =========================
CANDLE HELPERS (MOVED UP = SAFE)
========================= */
const isBearish = c => c.c < c.o;
const isBullish = c => c.c > c.o;

/* =========================
FIXED EARLY DECLARATION (CRASH FIX)
========================= */
function setupStillValid(data, setup) {
    for (let i = setup.index + 3; i < data.length; i++) {
        if (setup.direction === "SELL" && data[i].h > setup.level) return false;
        if (setup.direction === "BUY" && data[i].l < setup.level) return false;
    }
    return true;
}

/* =========================
FETCH DATA
========================= */
async function fetchMarketData(symbol) {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${CONFIG.TIMEFRAME}&outputsize=${CONFIG.LOOKBACK}&apikey=${CONFIG.API_KEY}`;

    const res = await fetchWithRetry(url);

    if (!res?.data?.values) return null;

    return res.data.values.map(c => ({
        o: +c.open,
        h: +c.high,
        l: +c.low,
        c: +c.close,
        t: c.datetime
    })).reverse();
}

function harami(prev, curr) {
    const prevHigh = Math.max(prev.o, prev.c);
    const prevLow = Math.min(prev.o, prev.c);

    const currHigh = Math.max(curr.o, curr.c);
    const currLow = Math.min(curr.o, curr.c);

    return currHigh < prevHigh &&
           currLow > prevLow;
}

/* =========================
PATTERNS
========================= */
function pinBar(c, dir) {
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l;
    if (range === 0) return false;

    if (dir === "SELL") {
        const upperWick = c.h - Math.max(c.c, c.o);
        return upperWick > range * 0.6 && body < range * 0.35;
    }

    if (dir === "BUY") {
        const lowerWick = Math.min(c.c, c.o) - c.l;
        return lowerWick > range * 0.6 && body < range * 0.35;
    }

    return false;
}

function engulfing(prev, curr, dir) {
    if (dir === "SELL") {
        return isBullish(prev) &&
               isBearish(curr) &&
               curr.o >= prev.c &&
               curr.c < prev.o;
    }

    if (dir === "BUY") {
        return isBearish(prev) &&
               isBullish(curr) &&
               curr.o <= prev.c &&
               curr.c > prev.o;
    }

    return false;
}

/* =========================
MARKET LOGIC
========================= */
function detectSetup(data) {
    for (let i = data.length - 20; i < data.length - 3; i++) {
        const c1 = data[i], c2 = data[i + 1], c3 = data[i + 2];

        if (isBearish(c1) && isBearish(c2) && isBearish(c3)) {
            return { direction: "SELL", level: c1.o, index: i, candles: 0 };
        }

        if (isBullish(c1) && isBullish(c2) && isBullish(c3)) {
            return { direction: "BUY", level: c1.o, index: i, candles: 0 };
        }
    }
    return null;
}

function atr(data, period = CONFIG.ATR_PERIOD) {
    let tr = [];

    for (let i = 1; i < data.length; i++) {
        tr.push(Math.max(
            data[i].h - data[i].l,
            Math.abs(data[i].h - data[i - 1].c),
            Math.abs(data[i].l - data[i - 1].c)
        ));
    }

    const slice = tr.slice(-period);
    const sum = slice.reduce((a, b) => a + b, 0);

    return sum / (slice.length || 1);
}

/* =========================
PROCESS ENGINE
========================= */
async function process(pair) {

    const data = await fetchMarketData(pair);
    if (!data) return;

    let setup = state.activeSetup[pair];

    if (!setup) {
        const newSetup = detectSetup(data);
        if (newSetup) {
            state.activeSetup[pair] = newSetup;
            metrics.setupsDetected++;
            console.log(`[SETUP] ${pair} ${newSetup.direction}`);
        }
        return;
    }

    setup.candles++;

    const last = data[data.length - 1];
    const prev = data[data.length - 2];

    if (!setupStillValid(data, setup)) {
        delete state.activeSetup[pair];
        metrics.setupsInvalidated++;
        console.log(`[INVALID] ${pair}`);
        return;
    }

    if (setup.candles > CONFIG.MAX_WAIT_CANDLES) {
        delete state.activeSetup[pair];
        return;
    }

    const confirm =
        pinBar(last, setup.direction) ||
        engulfing(prev, last, setup.direction) ||
        harami(prev, last);

    if (!confirm) return;

    const currentATR = atr(data);
    if (!currentATR) return;

    const distance =
        setup.direction === "SELL"
            ? setup.level - last.c
            : last.c - setup.level;

    if (distance > currentATR * 1.5) {
        delete state.activeSetup[pair];
        return;
    }

    const tp = setup.direction === "SELL"
        ? Math.min(...data.map(d => d.l))
        : Math.max(...data.map(d => d.h));

    if (!tp) return;

    const entry = last.c;
    const sl = setup.level;

    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const rr = reward / (risk || 1);

    if (rr < CONFIG.MIN_RR) return;

    const id = `${pair}-${setup.direction}-${last.t}`;
    if (state.sentSignals.has(id)) return;

    state.sentSignals.add(id);
    saveState();
    metrics.signalsSent++;

    try {
        await bot.sendMessage(CONFIG.CHAT_ID,
`📊 PRO 1H SIGNAL

Pair: ${pair}
Direction: ${setup.direction}

Entry: ${entry.toFixed(5)}
SL: ${sl.toFixed(5)}
TP: ${tp.toFixed(5)}
RR: 1:${rr.toFixed(2)}`);

        console.log(`[SIGNAL] ${pair} ${setup.direction}`);
        delete state.activeSetup[pair];
        saveState();

    } catch (err) {
        metrics.errors++;
    }
}

/* =========================
RUNNER
========================= */
async function runCycle() {
    metrics.cycles++;
    console.log(`\n[RUN] Cycle ${metrics.cycles}`);

    for (const pair of CONFIG.PAIRS) {
        await process(pair);
        await sleep(2000);
    }
}

async function heartbeat() {
    try {
        await bot.sendMessage(CONFIG.CHAT_ID,
            `💓 HEARTBEAT\nCycles: ${metrics.cycles}\nSignals: ${metrics.signalsSent}`);
    } catch (e) {}
}

/* =========================
START
========================= */
process.on("uncaughtException", err => console.log(err));
process.on("unhandledRejection", err => console.log(err));

setInterval(runCycle, 5 * 60 * 1000);
setInterval(keepAlive, 4 * 60 * 1000);
setInterval(heartbeat, 60 * 60 * 1000);

runCycle();
heartbeat();