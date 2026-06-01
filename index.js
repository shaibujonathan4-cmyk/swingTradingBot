require("dotenv").config();
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const fs = require("fs");

const app = express();

/* =========================
CONFIG
========================= */
const CONFIG = {
    PORT: process.env.PORT || 3000,
    API_KEY: process.env.TWELVE_API_KEY,
    CHAT_ID: process.env.CHAT_ID,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,

    PAIRS: ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF"],

    HTF_LOOKBACK: 50,
    LTF_LOOKBACK: 40,
    MIN_RR: 1.5
};

/* =========================
STATE
========================= */
const STATE_FILE = "./state.json";

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return { sent: [] };
        return JSON.parse(fs.readFileSync(STATE_FILE));
    } catch {
        return { sent: [] };
    }
}

const state = loadState();
state.sent = new Set(state.sent);

/* =========================
BOT
========================= */
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

/* =========================
SERVER (KEEP ALIVE FOR RENDER)
========================= */
app.get("/", (_, res) => res.send("ICT Bot Running"));
app.get("/health", (_, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime()
    });
});

app.listen(CONFIG.PORT, () => {
    console.log(`Server running on port ${CONFIG.PORT}`);
    startup();
});

/* =========================
TRACKING
========================= */
let lastSignalTime = null;

/* =========================
UTILS
========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
DATA FETCH
========================= */
async function getData(symbol, interval, size = 50) {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${size}&apikey=${CONFIG.API_KEY}&order=DESC`;

    try {
        const res = await axios.get(url, { timeout: 12000 });

        if (!res.data.values) return null;

        return res.data.values.map(c => ({
            o: +c.open,
            h: +c.high,
            l: +c.low,
            c: +c.close,
            t: c.datetime
        }));
    } catch {
        return null;
    }
}

/* =========================
STRUCTURE
========================= */
function structure(h4) {
    const highs = h4.slice(1, 25).map(c => c.h);
    const lows = h4.slice(1, 25).map(c => c.l);

    return {
        high: Math.max(...highs),
        low: Math.min(...lows)
    };
}

function sweep(ltf, st) {
    for (let i = 1; i <= 6; i++) {
        const c = ltf[i];
        if (!c) break;

        if (c.h > st.high && c.c < st.high) {
            return { ok: true, type: "SELL", idx: i, extreme: c.h };
        }

        if (c.l < st.low && c.c > st.low) {
            return { ok: true, type: "BUY", idx: i, extreme: c.l };
        }
    }

    return { ok: false };
}

function mss(ltf, dir, idx) {
    if (idx <= 1) return false;

    for (let i = idx - 1; i >= 1; i--) {
        const c = ltf[i];
        const p = ltf[i + 1];

        if (dir === "BUY" && c.c > p.h) return true;
        if (dir === "SELL" && c.c < p.l) return true;
    }

    return false;
}

function fvg(ltf, dir, extreme, idx) {
    if (idx <= 2) return null;

    for (let i = idx - 1; i >= 3; i--) {
        const c3 = ltf[i];
        const c2 = ltf[i - 1];
        const c1 = ltf[i - 2];

        if (dir === "BUY" && c1.l > c3.h) {
            return { entry: c3.h, sl: extreme, type: "BUY" };
        }

        if (dir === "SELL" && c1.h < c3.l) {
            return { entry: c3.l, sl: extreme, type: "SELL" };
        }
    }

    return null;
}

/* =========================
PROCESS
========================= */
async function process(pair) {
    const h4 = await getData(pair, "4h", CONFIG.HTF_LOOKBACK);
    await sleep(2000);
    const ltf = await getData(pair, "15min", CONFIG.LTF_LOOKBACK);

    if (!h4 || !ltf) return;

    const st = structure(h4);
    const sw = sweep(ltf, st);

    if (!sw.ok) return;
    if (!mss(ltf, sw.type, sw.idx)) return;

    const trade = fvg(ltf, sw.type, sw.extreme, sw.idx);
    if (!trade) return;

    const tp = sw.type === "BUY" ? st.high : st.low;

    const risk = Math.abs(trade.entry - trade.sl);
    const reward = Math.abs(tp - trade.entry);

    if (risk === 0 || reward / risk < CONFIG.MIN_RR) return;

    const id = `${pair}-${sw.type}-${ltf[1].t}`;
    if (state.sent.has(id)) return;

    state.sent.add(id);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sent: [...state.sent] }, null, 2));

    lastSignalTime = new Date();

    await bot.sendMessage(
        CONFIG.CHAT_ID,
`🏛 ICT SIGNAL
Pair: ${pair}
Type: ${sw.type}

Entry: ${trade.entry.toFixed(5)}
SL: ${trade.sl.toFixed(5)}
TP: ${tp.toFixed(5)}
RR: 1:${(reward / risk).toFixed(2)}`
    );

    console.log("Signal:", pair);
}

/* =========================
RUNNER LOOP
========================= */
async function cycle() {
    console.log("Cycle:", new Date().toLocaleString());

    for (const p of CONFIG.PAIRS) {
        try {
            await process(p);
        } catch (e) {
            console.error("Error:", e.message);
        }
        await sleep(3000);
    }
}

/* =========================
HEARTBEAT (RELIABLE)
========================= */
async function heartbeat() {
    try {
        const uptime = (process.uptime() / 3600).toFixed(2);

        await bot.sendMessage(
            CONFIG.CHAT_ID,
`💚 BOT STATUS
Status: ONLINE
Pairs: ${CONFIG.PAIRS.length}
Uptime: ${uptime}h

Last Signal:
${lastSignalTime ? lastSignalTime.toLocaleString() : "None"}`
        );

        console.log("Heartbeat sent");
    } catch (e) {
        console.error("Heartbeat error:", e.message);
    }
}

/* =========================
STARTUP
========================= */
async function startup() {
    try {
        await bot.sendMessage(
            CONFIG.CHAT_ID,
`🚀 BOT STARTED
Pairs: ${CONFIG.PAIRS.length}
Time: ${new Date().toLocaleString()}`
        );
    } catch (e) {
        console.error("Startup error:", e.message);
    }
}

/* =========================
SAFE LOOPS (NO INTERVAL RELIANCE ONLY)
========================= */
async function loopRunner() {
    while (true) {
        await cycle();
        await sleep(5 * 60 * 1000);
    }
}

async function heartbeatRunner() {
    while (true) {
        await heartbeat();
        await sleep(60 * 60 * 1000);
    }
}

/* =========================
START SYSTEM
========================= */
process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

loopRunner();
heartbeatRunner();