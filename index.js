require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// --- Configuration Setup ---
const TWELVE_DATA_API_KEY = process.env.TWELVE_API_KEY; 
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;     
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;           

const SYMBOL = "EUR/USD"; 
const BASE_URL = "https://api.twelvedata.com";

if (!TWELVE_DATA_API_KEY || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("\n❌ [ENV BOOT ERROR] Missing required configuration values inside your environment!");
    process.exit(1); 
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Global State tracker for Multi-Timeframe Institutional Flow Analysis
let trackingState = {
    htfOrderBlock: null,     // Found 1H Order Block zone { type: 'BULLISH'/'BEARISH', high, low }
    last15mCandleTime: null  // Deduplication guard
};

/**
 * Core Request wrapper for Twelve Data Time Series array collection
 */
async function fetchCandles(interval, outputsize = 40) {
    try {
        const response = await axios.get(`${BASE_URL}/time_series`, {
            params: {
                symbol: SYMBOL,
                interval: interval,
                outputsize: outputsize,
                apikey: TWELVE_DATA_API_KEY
            }
        });
        if (response.data.status === "error") throw new Error(response.data.message);
        return response.data.values || [];
    } catch (error) {
        console.error(`❌ Failed fetching raw history for [${interval}]:`, error.message);
        return [];
    }
}

/**
 * SMC HELPER 1: Scans a raw array to locate the fresh validated Order Block (OB)
 */
function findHTFOrderBlock(candles) {
    if (candles.length < 5) return null;

    for (let i = 1; i < candles.length - 3; i++) {
        const c0_open = parseFloat(candles[i].open);
        const c0_close = parseFloat(candles[i].close);
        const c1_open = parseFloat(candles[i+1].open);
        const c1_close = parseFloat(candles[i+1].close);
        
        const c0_isBullish = c0_close > c0_open;
        const c0_isBearish = c0_close < c0_open;
        const c1_isBullish = c1_close > c1_open;
        const c1_isBearish = c1_close < c1_open;

        // BULLISH ORDER BLOCK: The last bearish candle before an aggressive expansion upward
        if (c1_isBearish && c0_isBullish) {
            const bodyExpansion = Math.abs(c0_close - c0_open);
            const prevBody = Math.abs(c1_close - c1_open);
            
            if (bodyExpansion > (prevBody * 1.5)) { 
                return {
                    type: "BULLISH OB", // Formatting fix: Space instead of underscore
                    high: parseFloat(candles[i+1].high),
                    low: parseFloat(candles[i+1].low),
                    timestamp: candles[i+1].datetime
                };
            }
        }
        
        // BEARISH ORDER BLOCK: The last bullish candle before an aggressive expansion downward
        if (c1_isBullish && c0_isBearish) {
            const bodyExpansion = Math.abs(c0_close - c0_open);
            const prevBody = Math.abs(c1_close - c1_open);
            
            if (bodyExpansion > (prevBody * 1.5)) {
                return {
                    type: "BEARISH OB", // Formatting fix: Space instead of underscore
                    high: parseFloat(candles[i+1].high),
                    low: parseFloat(candles[i+1].low),
                    timestamp: candles[i+1].datetime
                };
            }
        }
    }
    return null;
}

/**
 * SMC HELPER 2: Analyzes execution timeframe array to identify structural breaks (MSS/CHoCH/BOS)
 */
function evaluateMarketStructure(candles) {
    if (candles.length < 10) return { structureShift: "NONE", referencePrice: 0 };

    let closestSwingHigh = null;
    let closestSwingLow = null;

    for (let i = 2; i < candles.length - 2; i++) {
        const currHigh = parseFloat(candles[i].high);
        const currLow = parseFloat(candles[i].low);

        if (!closestSwingHigh && currHigh > parseFloat(candles[i-1].high) && currHigh > parseFloat(candles[i+1].high)) {
            closestSwingHigh = currHigh;
        }
        if (!closestSwingLow && currLow < parseFloat(candles[i-1].low) && currLow < parseFloat(candles[i+1].low)) {
            closestSwingLow = currLow;
        }
        if (closestSwingHigh && closestSwingLow) break;
    }

    const currentClose = parseFloat(candles[0].close);
    const currentOpen = parseFloat(candles[0].open);

    const isBullishEngulfing = (currentClose > currentOpen) && 
                               (parseFloat(candles[1].close) < parseFloat(candles[1].open)) && 
                               ((currentClose - currentOpen) > Math.abs(parseFloat(candles[1].close) - parseFloat(candles[1].open)));

    const isBearishEngulfing = (currentClose < currentOpen) && 
                               (parseFloat(candles[1].close) > parseFloat(candles[1].open)) && 
                               ((currentOpen - currentClose) > Math.abs(parseFloat(candles[1].close) - parseFloat(candles[1].open)));

    if (closestSwingHigh && currentClose > closestSwingHigh) {
        return { 
            structureShift: "BULLISH MSS CHoCH", // Formatting fix: spaces instead of underscores
            referencePrice: closestSwingHigh,
            patternConfirmed: isBullishEngulfing ? "Bullish Engulfing Signature" : "Standard Structural Break"
        };
    }
    if (closestSwingLow && currentClose < closestSwingLow) {
        return { 
            structureShift: "BEARISH MSS CHoCH", // Formatting fix: spaces instead of underscores
            referencePrice: closestSwingLow,
            patternConfirmed: isBearishEngulfing ? "Bearish Engulfing Signature" : "Standard Structural Break"
        };
    }

    return { structureShift: "NONE", trackedHigh: closestSwingHigh, trackedLow: closestSwingLow };
}

/**
 * Main Algorithmic Execution Block
 */
async function runSignalEngine() {
    const timestamp = new Date().toLocaleTimeString();
    let logLines = [];

    logLines.push(`🖥️ **SMC ALGORITHMIC TERMINAL [${timestamp}]**`);
    logLines.push(`🔍 SCANNING ${SYMBOL} INSTITUTIONAL FLOW`);
    logLines.push(`────────────────────────`);

    console.log(`\n==================================================================`);
    console.log(`🔍 SCANNING ${SYMBOL} RAW MARKET STRUCTURE arrays [${timestamp}]`);
    console.log(`==================================================================`);

    const htfCandles = await fetchCandles('1h', 30);
    const ltfCandles = await fetchCandles('15min', 30);

    if (htfCandles.length === 0 || ltfCandles.length === 0) {
        console.log("⚠️ Data array pipeline currently unpopulated. Skipping loop.");
        return;
    }

    const livePrice = parseFloat(ltfCandles[0].close);
    const executionCandleTime = ltfCandles[0].datetime;

    const activeOB = findHTFOrderBlock(htfCandles);
    let htfContextLog = "";

    if (activeOB) {
        trackingState.htfOrderBlock = activeOB;
        htfContextLog = `Ancl. 1H ${activeOB.type}: High: \`${activeOB.high.toFixed(5)}\` | Low: \`${activeOB.low.toFixed(5)}\``;
    } else if (trackingState.htfOrderBlock) {
        htfContextLog = `Ancl. Retained 1H ${trackingState.htfOrderBlock.type}: High: \`${trackingState.htfOrderBlock.high.toFixed(5)}\``;
    } else {
        htfContextLog = `Ancl. HTF Context: No clearly formed Order Blocks found.`;
    }
    console.log(`  ${htfContextLog}`);
    logLines.push(htfContextLog);

    let mitigationBias = "NEUTRAL";
    if (trackingState.htfOrderBlock) {
        const ob = trackingState.htfOrderBlock;
        if (ob.type === "BULLISH OB" && livePrice <= ob.high && livePrice >= ob.low) {
            mitigationBias = "DISCOUNT MITIGATION";
            console.log("  🟢 HTF MITIGATION: Live price interacting inside institutional demand block.");
        } else if (ob.type === "BEARISH OB" && livePrice >= ob.low && livePrice <= ob.high) {
            mitigationBias = "PREMIUM MITIGATION";
            console.log("  🔴 HTF MITIGATION: Live price interacting inside institutional supply block.");
        }
    }
    logLines.push(`Mitigation state: \`${mitigationBias}\``);

    const structureResult = evaluateMarketStructure(ltfCandles);
    logLines.push(`LTF Structural Scan: \`${structureResult.structureShift}\``);

    let signalAction = null;
    let strategyContext = "";

    if (mitigationBias === "DISCOUNT MITIGATION" && structureResult.structureShift === "BULLISH MSS CHoCH") {
        signalAction = "🟢 INTRA-SESSION BUY / LONG ORDER FLUSH PROMPTED";
        strategyContext = `Market structure shifted bullishly on the 15M execution chart (Closed above Swing High \`${structureResult.referencePrice}\`) directly inside a high-timeframe 1H Demand Order Block. Confirming signature: ${structureResult.patternConfirmed}.`;
    } 
    else if (mitigationBias === "PREMIUM MITIGATION" && structureResult.structureShift === "BEARISH MSS CHoCH") {
        signalAction = "🔴 INTRA-SESSION SELL / SHORT ORDER FLUSH PROMPTED";
        strategyContext = `Market structure shifted bearishly on the 15M execution chart (Closed below Swing Low \`${structureResult.referencePrice}\`) directly inside a high-timeframe 1H Supply Order Block. Confirming signature: ${structureResult.patternConfirmed}.`;
    }

    if (signalAction) {
        if (trackingState.last15mCandleTime === executionCandleTime) {
            const blockSpam = `⏳ Structural alignment verified but signal already pushed for this interval candle session. Suppressing repetition loop.`;
            console.log(`  └─ ${blockSpam}`);
            logLines.push(`\n${blockSpam}`);
        } else {
            logLines.push(`\n🚨 **🎯 ADVANCED SMC CRITERIA ENGAGED!** 🎯`);
            logLines.push(`**Action Matrix:** ${signalAction}`);
            logLines.push(`_Strategic Summary: ${strategyContext}_`);
            trackingState.last15mCandleTime = executionCandleTime;
        }
    } else {
        const structuralPatience = `⏳ Market hovering mid-structure. (Ceiling: \`${structureResult.trackedHigh || 'N/A'}\` | Floor: \`${structureResult.trackedLow || 'N/A'}\`). Maintaining structural patience.`;
        console.log(`  ${structuralPatience}`);
        logLines.push(`\n${structuralPatience}`);
    }

    try {
        const finalPayload = logLines.join('\n');
        await bot.sendMessage(TELEGRAM_CHAT_ID, finalPayload, { parse_mode: 'Markdown' });
    } catch (tgError) {
        console.error("❌ Telegram structural logger failed transmission:", tgError.message);
    }
}

// Execution loop optimized to stay well within free tier parameters
runSignalEngine();
setInterval(runSignalEngine, 900000);
