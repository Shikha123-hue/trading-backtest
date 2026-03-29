"use strict";
/**
 * checkBalance.js — Fixed Version
 * Direct HTTPS call — ccxt bypass
 */
const https  = require('https');
const crypto = require('crypto');

// ══════════════════════════════════════════
//  🔑 APNI KEYS YAHAN DALO
// ══════════════════════════════════════════
const API_KEY    ='4fNPObXJmUm7skU0QZ3Mqr5qFqYIiuKvdqMtNGiqyVaywUxQDItIIYpuFzxeUzNQ';
const API_SECRET = 'IKbbgT0mHGxiqfVMER0uhgwOQQHUVhS60MXfQOY6s9AudKLht76cD0YQYf4aaCC9';
// ══════════════════════════════════════════

function sign(queryString) {
    return crypto
        .createHmac('sha256', API_SECRET)
        .update(queryString)
        .digest('hex');
}

function request(path, params = {}) {
    return new Promise((resolve, reject) => {
        const timestamp   = Date.now();
        const queryString = `timestamp=${timestamp}` +
            (Object.keys(params).length
                ? '&' + new URLSearchParams(params).toString()
                : '');
        const signature   = sign(queryString);
        const fullPath    = `/api/v3/${path}?${queryString}&signature=${signature}`;

        const options = {
            hostname: 'testnet.binance.vision',
            port:     443,
            path:     fullPath,
            method:   'GET',
            headers: {
                'X-MBX-APIKEY': API_KEY,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Parse error: ' + data)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log('════════════════════════════════════════');
    console.log('   Binance TESTNET Balance Check');
    console.log('   Direct API (no ccxt)');
    console.log('════════════════════════════════════════');

    if (API_KEY === 'APNI_TESTNET_API_KEY' || API_SECRET === 'APNA_TESTNET_SECRET') {
        console.log('\n❌ Keys nahi daali! checkBalance.js me apni keys dalo.\n');
        return;
    }

    console.log(`\n🔑 API Key (first 8 chars): ${API_KEY.substring(0, 8)}...`);
    console.log(`🔑 Secret  (first 8 chars): ${API_SECRET.substring(0, 8)}...\n`);

    try {
        const account = await request('account');

        if (account.code) {
            console.log(`❌ Binance Error ${account.code}: ${account.msg}`);

            if (account.code === -2008) {
                console.log('\n📋 Possible Reasons:');
                console.log('   1. API Key me extra space hai — carefully copy karo');
                console.log('   2. Live Binance ki key daal di — Testnet ki chahiye');
                console.log('   3. Key revoke ho gayi — naya banao');
                console.log('\n👉 Fix: Testnet pe jao → Revoke → Generate New Key');
            }
            if (account.code === -1021) {
                console.log('\n📋 Timestamp issue — PC ka time sync karo');
                console.log('   Windows: Settings → Time → Sync Now');
            }
            return;
        }

        const balances = account.balances.filter(b =>
            parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
        );

        if (balances.length === 0) {
            console.log('⚠️  Koi balance nahi mila!\n');
            return;
        }

        console.log('💰 Testnet Balances:\n');
        console.log('  Asset    Free              Locked');
        console.log('  ' + '─'.repeat(45));

        let usdtFree = 0, btcFree = 0;
        for (const b of balances) {
            const free   = parseFloat(b.free).toFixed(6);
            const locked = parseFloat(b.locked).toFixed(6);
            console.log(`  ${b.asset.padEnd(8)} ${free.padStart(16)}  ${locked.padStart(16)}`);
            if (b.asset === 'USDT') usdtFree = parseFloat(b.free);
            if (b.asset === 'BTC')  btcFree  = parseFloat(b.free);
        }

        console.log('\n  ' + '═'.repeat(45));
        console.log(`  💵 USDT : $${usdtFree.toFixed(2)}`);
        console.log(`  ₿  BTC  : ${btcFree.toFixed(6)}`);
        console.log('  ' + '═'.repeat(45));
        console.log('\n✅ Testnet connected! Ab PaperTrade.js run kar sakte ho.\n');

    } catch (err) {
        console.error('\n❌ Network Error:', err.message);
        console.log('👉 Internet connection check karo');
    }
}

main();