// config.js
export const ASSET_RULES = {
    "EUR/USD": {
        allowedSessions: [{ start: 7, end: 16 }], // UTC Hours
        minRr: 3,
        slPipsBuffer: 3,
        tpTarget: "H4_LIQUIDITY",
        requiresChoch: false
    },
    "EUR/GBP": {
        allowedSessions: [{ start: 7, end: 12 }], // London Preferred
        minRr: 2,
        slPipsBuffer: 1.5,
        tpTarget: "H1_LOCAL",
        requiresChoch: true // Extra filter for mean-reverting cross
    }
};
