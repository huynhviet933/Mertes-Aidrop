require("child_process").execSync("chcp 65001 > nul");
const fs = require("fs");
const axios = require("axios");
const { Wallet } = require("ethers");
const dns = require("node:dns");
const ora = require("ora").default;

// DNS FIX
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// COLORS
const GREEN = "\x1b[32m";
const BLUE = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const LINE = "-----------------------------------------";

// LOAD FILES
function loadFile(path) {
    if (!fs.existsSync(path)) return [];
    return fs.readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);
}

const privateKeys = loadFile("privatekey.txt");
const proxies = loadFile("proxy.txt");
const UAs = loadFile("user_agents.txt");

if (!privateKeys.length) {
    console.log(RED, "❌ privatekey.txt trống!", RESET);
    process.exit();
}

// PROXY AGENT
function createAgent(proxyURL) {
    try {
        const PA = require("proxy-agent");
        if (PA.createProxyAgent) return PA.createProxyAgent(proxyURL);
        if (PA.ProxyAgent) return new PA.ProxyAgent(proxyURL);
        if (typeof PA === "function") return new PA(proxyURL);
        return null;
    } catch {
        return null;
    }
}

// SIGN MESSAGE BLOCKSCOUT FORMAT
function buildSignMessage({ address, nonce, merits_nonce }) {
    const domain = "eth.blockscout.com";
    const now = new Date();
    const exp = new Date(now);
    exp.setFullYear(now.getFullYear() + 1);

    return `${domain} wants you to sign in with your Ethereum account:
${address}

Sign in/up to Blockscout Account V2 & Blockscout Merits program. Merits nonce: ${merits_nonce}.

URI: https://${domain}
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${now.toISOString()}
Expiration Time: ${exp.toISOString()}`;
}

async function runWallet(index, pk) {
    const wallet = new Wallet(pk);
    const address = wallet.address;

    const UA = UAs.length ? UAs[index % UAs.length] : "Mozilla/5.0 Chrome/142";
    const proxy = proxies.length ? proxies[index % proxies.length] : null;
    const agent = proxy ? createAgent(proxy) : null;

    const spinner = ora({
        text: `(${index + 1}) Đang xử lý ví ${address}...`,
        spinner: "dots"
    }).start();

    const cfg = {
        headers: {
            "user-agent": UA,
            "origin": "https://eth.blockscout.com",
            "referer": "https://eth.blockscout.com/",
            "content-type": "application/json",
        },
        timeout: 20000
    };

    if (agent) {
        cfg.httpAgent = agent;
        cfg.httpsAgent = agent;
    }

    try {
        // 1) GET NONCE
        const nonceURL =
            `https://merits.blockscout.com/api/v1/auth/nonce?blockscout_login_address=${address}&blockscout_login_chain_id=1`;

        const nonceRes = await axios.get(nonceURL, cfg);
        const { nonce, merits_login_nonce } = nonceRes.data;

        // 2) SIGN
        const message = buildSignMessage({ address, nonce, merits_nonce: merits_login_nonce });
        const signature = await wallet.signMessage(message);

        // 3) LOGIN
        const loginRes = await axios.post(
            "https://merits.blockscout.com/api/v1/auth/login",
            { message, nonce, signature },
            cfg
        );

        const token = loginRes.data.token;
        if (!token) {
            spinner.stop();
            console.log(`\n${RED}✘ Login thất bại${RESET}
Ví số – ${index + 1}
Ví: ${address}
Proxy dùng: ${proxy || "Không proxy"}
${LINE}`);
            return;
        }

        // 4) CHECK DAILY
        const status = await axios.get(
            "https://merits.blockscout.com/api/v1/user/daily/check",
            { ...cfg, headers: { ...cfg.headers, Authorization: `Bearer ${token}` } }
        );

        const available = status.data.available;

        // 5) API LẤY POINT ĐÚNG — /auth/user/<address>
        const userInfo = await axios.get(
            `https://merits.blockscout.com/api/v1/auth/user/${address}`,
            { ...cfg, headers: { ...cfg.headers, Authorization: `Bearer ${token}` } }
        );

        const points = userInfo.data.user.total_balance;

        spinner.stop();

        // === FORMAT HIỂN THỊ ===
        console.log(`${YELLOW}Ví số – ${index + 1}${RESET}`);
        console.log(`${GREEN}Đã login thành công :${RESET} ${address}`);
        console.log(`${BLUE}Đang dùng proxy :${RESET} ${proxy ? proxy.split("@")[1].split(":")[0] : "Không proxy"}`);

        if (!available) {
            console.log(`${YELLOW}Hôm nay đã check-in rồi${RESET}`);
            console.log(`${GREEN}Số point hiện tại :${RESET} ${points}`);
            console.log(LINE);
            return;
        }

        // 6) CLAIM
        await axios.post(
            "https://merits.blockscout.com/api/v1/user/daily/claim",
            {},
            { ...cfg, headers: { ...cfg.headers, Authorization: `Bearer ${token}` } }
        );

        // LẤY LẠI POINT SAU CLAIM
        const userInfo2 = await axios.get(
            `https://merits.blockscout.com/api/v1/auth/user/${address}`,
            { ...cfg, headers: { ...cfg.headers, Authorization: `Bearer ${token}` } }
        );

        const pointsAfter = userInfo2.data.user.total_balance;

        console.log(`${GREEN}Đã check-in thành công${RESET}`);
        console.log(`${GREEN}Số point hiện tại :${RESET} ${pointsAfter}`);
        console.log(LINE);

    } catch (err) {
        spinner.stop();
        console.log(`\n${RED}❌ Lỗi ví:${RESET} ${err.message}
Ví số – ${index + 1}
Ví: ${wallet.address}
Proxy dùng: ${proxy || "Không proxy"}
${LINE}`);
    }
}

// =======================================
//  BATCH 10 VÍ + NGHỈ RANDOM 30–60 GIÂY
// =======================================
async function runMultiThread() {
    const THREAD = 1;
    let index = 0;

    while (index < privateKeys.length) {
        const jobs = [];

        for (let i = 0; i < THREAD && index < privateKeys.length; i++, index++) {
            jobs.push(runWallet(index, privateKeys[index]));
        }

        await Promise.all(jobs);

        if (index < privateKeys.length) {
            const delay = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
            console.log(YELLOW + `⏳ Nghỉ ${delay} giây rồi chạy tiếp...` + RESET);
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }

    console.log(YELLOW + "\n🎉 Hoàn thành tất cả ví!" + RESET);
}

runMultiThread();
