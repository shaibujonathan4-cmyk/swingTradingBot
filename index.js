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
    APP_URL: process.env.APP_URL,

    PAIRS: ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF"],

    HTF_LOOKBACK: 50,
    LTF_LOOKBACK: 40,

    MIN_RR: 1.5
};

/* =========================
STATE MANAGEMENT
========================= */
const STATE_FILE = "./state.json";

function loadState() {
    if (!fs.existsSync(STATE_FILE)) return { sentSignals: [] };
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {
        return { sentSignals: [] };
    }
}

const state = loadState();
state.sentSignals = new Set(state.sentSignals || []);
let lastSignalTime = null;

function saveState() {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({ sentSignals: [...state.sentSignals] }, null, 2)
    );
}

/* =========================
BOT + SERVER
========================= */
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

app.get("/", (_, res) => res.send("ICT Engine Operational"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.listen(CONFIG.PORT, () => console.log(`🚀 Running on port ${CONFIG.PORT}`));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
DATA FETCH
========================= */
async function fetchMarketData(symbol, interval, size = 50) {
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
    } catch (e) {
        return null;
    }
}

/* =========================
ICT STRUCTURAL MODULES
========================= */
function getRecentStructure(h4) {
    const highs = h4.slice(1, 25).map(c => c.h);
    const lows = h4.slice(1, 25).map(c => c.l);
    return {
        high: Math.max(...highs),
        low: Math.min(...lows)
    };
}

function detectSweeps(ltf, structure) {
    for (let i = 1; i <= 6; i++) {
        if (!ltf[i]) break;
        const c = ltf[i];
        
        if (c.h > structure.high && c.c < structure.high) {
            return { swept: true, type: "SELL", index: i, extreme: c.h };
        }
        if (c.l < structure.low && c.c > structure.low) {
            return { swept: true, type: "BUY", index: i, extreme: c.l };
        }
    }
    return { swept: false, type: null, index: -1, extreme: null };
}

function detectMSS(ltf, direction, sweepIndex) {
    if (sweepIndex <= 1) return false; 
    
    for (let i = sweepIndex - 1; i >= 1; i--) {
        const current = ltf[i];
        const prev = ltf[i + 1];
        
        if (direction === "BUY" && current.c > prev.h && current.c > current.o) return true;
        if (direction === "SELL" && current.c < prev.l && current.c < current.o) return true;
    }
    return false;
}

// FIXED: True forward-chronological scan starting from the sweep candle forward to the present
function findChronologicalFVG(ltf, bias, sweepExtreme, sweepIndex) {
    if (sweepIndex <= 2) return null;

    // Start scanning at the oldest candle immediately following the sweep, then walk forward toward index 3
    for (let i = sweepIndex - 1; i >= 3; i--) {
        const c3 = ltf[i];     // Oldest Reference Candle in sequence
        const c2 = ltf[i - 1]; // Core Displacement Candle
        const c1 = ltf[i - 2]; // Newest Target Validation Candle

        if (bias === "BUY" && c1.l > c3.h && c2.c > c2.o) {
            return { type: "BULLISH", entry: c3.h, invalidation: sweepExtreme };
        }

        if (bias === "SELL" && c1.h < c3.l && c2.c < c2.o) {
            return { type: "BEARISH", entry: c3.l, invalidation: sweepExtreme };
        }
    }
    return null;
}

/* =========================
PROCESS ENGINE
========================= */
async function processPair(pair) {
    const h4 = await fetchMarketData(pair, "4h", CONFIG.HTF_LOOKBACK);
    await sleep(2500); 
    const ltf = await fetchMarketData(pair, "15min", CONFIG.LTF_LOOKBACK);

    if (!h4 || !ltf || ltf.length < 8) return;

    const structure = getRecentStructure(h4);

    // 1. Liquidity Sweep Phase
    const sweep = detectSweeps(ltf, structure);
    if (!sweep.swept) return;

    // 2. Market Structure Shift Phase
    if (!detectMSS(ltf, sweep.type, sweep.index)) return;

    // 3. Fair Value Gap Phase
    const fvg = findChronologicalFVG(ltf, sweep.type, sweep.extreme, sweep.index);
    if (!fvg) return;

    // Execution Target Calculations
    let entry = fvg.entry;
    let sl = fvg.invalidation; 
    let tp = sweep.type === "BUY" ? structure.high : structure.low;

    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk === 0 || (reward / risk) < CONFIG.MIN_RR) return;

    // Unique Signal Deduplicator
    const id = `${pair}-${sweep.type}-${ltf[1].t}`;
    if (state.sentSignals.has(id)) return;

    state.sentSignals.add(id);
    saveState();
    lastSignalTime = new Date();

    const dateObj = new Date(ltf[1].t);
    const time = dateObj.toLocaleTimeString("en-NG", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });

    try {
        await bot.sendMessage(CONFIG.CHAT_ID,
`🏛 **ICT STRUCTURAL SIGNAL**
━━━━━━━━━━━━━━━━━
**Pair**: \`${pair}\`
**Setup Matrix**: *${sweep.type === "BUY" ? "🚀 DISCOUNT LIQUIDITY SWEEP (SSL)" : "📉 PREMIUM LIQUIDITY SWEEP (BSL)"}*

🎯 **Entry Limit (FVG)**: \`${entry.toFixed(5)}\`
🛑 **Stop (Sweep Extreme)**: \`${sl.toFixed(5)}\`
🏁 **Target (Draw on Liq)**: \`${tp.toFixed(5)}\`
📊 **Risk/Reward Ratio**: \`1:${(reward / risk).toFixed(2)}\`
━━━━━━━━━━━━━━━━━
🕒 *Trigger Time: ${time} (WAT)*`, { parse_mode: "Markdown" });
        console.log(`✅ Signal Dispatched: ${pair}`);
    } catch (e) {
        console.error("❌ Telegram Dispatch Error:", e.message);
    }
}

/* =========================
RUNNER SYSTEM
========================= */
async function runCycle() {
    console.log(`\n🔄 Execution Cycle Started: ${new Date().toLocaleString('en-NG')}`);
    for (const pair of CONFIG.PAIRS) {
        try {
            await processPair(pair);
        } catch (err) {
            console.error(`Error processing ${pair}:`, err.message);
        }
        await sleep(4000); 
    }
}

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

setInterval(runCycle, 5 * 60 * 1000);
runCycle();
setInterval(sendHeartbeat, 60 * 60 * 1000);