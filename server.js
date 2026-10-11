const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");
const PROFILE_DIR = path.join(__dirname, "profiles");

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use("/screenshots", express.static(SCREENSHOT_DIR));

const jobs = new Map();


// ============================================================
// HELPER
// ============================================================

function randomId() {
    return crypto.randomBytes(12).toString("hex");
}

function sendEvent(job, eventName, data) {
    const message =
        `event: ${eventName}\n` +
        `data: ${JSON.stringify(data)}\n\n`;

    for (const client of job.clients) {
        try {
            client.write(message);
        } catch (e) {}
    }
}


// ============================================================
// PARSE PROXY
//
// Supported format:
// host:port:username:password
// ============================================================

function parseProxy(proxyText) {
    const parts = proxyText.trim().split(":");

    if (parts.length < 4) {
        throw new Error(
            "Invalid proxy format. Use host:port:username:password"
        );
    }

    return {
        host: parts[0],
        port: parts[1],
        username: parts[2],
        password: parts.slice(3).join(":")
    };
}


// ============================================================
// TEST ONE PROXY
// ============================================================

async function testProxy(proxyText, jobId, number) {
    const proxy = parseProxy(proxyText);

    const profilePath = path.join(
        PROFILE_DIR,
        `${jobId}-${number}-${randomId()}`
    );

    let context = null;

    try {
        // Each proxy gets its OWN Chromium profile.
        context = await chromium.launchPersistentContext(
            profilePath,
            {
                headless: true,

                viewport: {
                    width: 1500,
                    height: 1100
                },

                proxy: {
                    server: `http://${proxy.host}:${proxy.port}`,
                    username: proxy.username,
                    password: proxy.password
                }
            }
        );

        let pages = context.pages();

        let page =
            pages.length > 0
                ? pages[0]
                : await context.newPage();

        page.setDefaultTimeout(180000);

        await page.goto(
            "https://browserleaks.com/dns",
            {
                waitUntil: "domcontentloaded",
                timeout: 180000
            }
        );

        // Wait until BrowserLeaks shows a result like:
        // Found 2 Servers, 1 ISP, 1 Location
        //
        // This also accepts plural versions:
        // Found 4 Servers, 2 ISPs, 3 Locations

        await page.waitForFunction(
            () => {
                const text = document.body.innerText || "";

                return /Found\s+\d+\s+Servers?,\s*\d+\s+ISPs?,\s*\d+\s+Locations?/i.test(text);
            },
            {
                timeout: 180000
            }
        );

        // Give the DNS table a little extra time to render.
        await page.waitForTimeout(2500);

        const fileName =
            `proxy-${number}-${randomId()}.png`;

        const screenshotPath = path.join(
            SCREENSHOT_DIR,
            fileName
        );

        // Capture the REAL BrowserLeaks result page.
        await page.screenshot({
            path: screenshotPath,
            fullPage: true
        });

        // Extract the result summary only for display.
        const summary = await page.evaluate(() => {
            const text = document.body.innerText || "";

            const match = text.match(
                /Found\s+\d+\s+Servers?,\s*\d+\s+ISPs?,\s*\d+\s+Locations?/i
            );

            return match ? match[0] : "DNS test completed";
        });

        await context.close();
        context = null;

        // Remove temporary browser profile.
        try {
            fs.rmSync(profilePath, {
                recursive: true,
                force: true
            });
        } catch (e) {}

        return {
            success: true,
            image: `/screenshots/${fileName}`,
            summary
        };

    } catch (error) {

        if (context) {
            try {
                await context.close();
            } catch (e) {}
        }

        try {
            fs.rmSync(profilePath, {
                recursive: true,
                force: true
            });
        } catch (e) {}

        return {
            success: false,
            error: error.message || "Unknown error"
        };
    }
}


// ============================================================
// RUN ALL PROXIES
// ============================================================

async function runJob(jobId, job) {
    let nextIndex = 0;

    async function worker() {
        while (true) {

            const currentIndex = nextIndex++;

            if (currentIndex >= job.proxies.length) {
                return;
            }

            const proxy =
                job.proxies[currentIndex];

            const id =
                `${jobId}-${currentIndex}`;

            const number =
                currentIndex + 1;

            // Tell frontend this proxy started.
            sendEvent(job, "started", {
                id,
                number,
                proxy
            });

            console.log(
                `[${number}] Starting: ${proxy}`
            );

            const result =
                await testProxy(
                    proxy,
                    jobId,
                    number
                );

            if (result.success) {

                console.log(
                    `[${number}] Completed: ${result.summary}`
                );

                sendEvent(job, "completed", {
                    id,
                    number,
                    proxy,
                    image: result.image,
                    summary: result.summary
                });

            } else {

                console.log(
                    `[${number}] Failed: ${result.error}`
                );

                sendEvent(job, "failed", {
                    id,
                    number,
                    proxy,
                    error: result.error
                });
            }
        }
    }

    const workers = [];

    for (let i = 0; i < job.parallel; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    sendEvent(job, "done", {});

    setTimeout(() => {
        jobs.delete(jobId);
    }, 10 * 60 * 1000);
}


// ============================================================
// CREATE JOB
// ============================================================

app.post("/start", (req, res) => {

    const proxies = Array.isArray(req.body.proxies)
        ? req.body.proxies
        : [];

    if (proxies.length === 0) {
        return res.status(400).json({
            error: "No proxies provided."
        });
    }

    let parallel =
        Number(req.body.parallel) || 1;

    // Limit parallel Chromium instances.
    parallel = Math.max(
        1,
        Math.min(parallel, 5)
    );

    const jobId = randomId();

    jobs.set(jobId, {
        proxies,
        parallel,
        clients: [],
        started: false
    });

    res.json({ jobId });
});


// ============================================================
// SSE EVENTS
// ============================================================

app.get("/events/:jobId", (req, res) => {

    const job = jobs.get(req.params.jobId);

    if (!job) {
        return res.status(404).end();
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });

    res.write("\n");

    job.clients.push(res);

    req.on("close", () => {
        job.clients =
            job.clients.filter(
                client => client !== res
            );
    });

    if (!job.started) {
        job.started = true;

        runJob(
            req.params.jobId,
            job
        );
    }
});


// ============================================================
// MAIN PAGE
// ============================================================

app.get("/", (req, res) => {

res.send(`<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0">

<title>Proxy DNS Test</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: #eef2f7;
    color: #172033;
    font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Arial,
        sans-serif;
}

.container {
    width: min(1450px, 94%);
    margin: 30px auto 80px;
}

.top {
    margin-bottom: 20px;
}

h1 {
    margin: 0 0 6px;
    font-size: 28px;
}

.subtitle {
    color: #667085;
    font-size: 14px;
}

.panel {
    background: white;
    border-radius: 14px;
    padding: 20px;
    box-shadow:
        0 4px 20px rgba(0,0,0,.08);
}

textarea {
    width: 100%;
    min-height: 220px;
    resize: vertical;
    border: 1px solid #cfd8e3;
    border-radius: 10px;
    padding: 15px;
    font-family: monospace;
    font-size: 13px;
    line-height: 1.55;
}

textarea:focus {
    outline: none;
    border-color: #2563eb;
}

.controls {
    margin-top: 15px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

label {
    font-size: 14px;
    font-weight: 600;
}

select {
    margin-left: 7px;
    padding: 9px 12px;
    border-radius: 8px;
    border: 1px solid #cfd8e3;
}

button {
    border: none;
    border-radius: 8px;
    padding: 11px 18px;
    cursor: pointer;
    font-weight: 600;
}

.primary {
    background: #2563eb;
    color: white;
}

.primary:hover {
    background: #1d4ed8;
}

.secondary {
    background: #64748b;
    color: white;
}

.secondary:hover {
    background: #475569;
}

button:disabled {
    opacity: .55;
    cursor: not-allowed;
}

.progress-box {
    margin-top: 20px;
    background: white;
    border-radius: 12px;
    padding: 16px;
    box-shadow:
        0 4px 18px rgba(0,0,0,.06);
}

.progress-top {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    font-weight: 600;
}

.progress-bg {
    width: 100%;
    height: 10px;
    background: #e5e7eb;
    border-radius: 10px;
    overflow: hidden;
    margin-top: 12px;
}

.progress-bar {
    width: 0%;
    height: 100%;
    background: #2563eb;
    transition: width .3s ease;
}

.results {
    margin-top: 25px;
    display: flex;
    flex-direction: column;
    gap: 22px;
}


/* RESULT CARD */

.card {
    background: white;
    border-radius: 14px;
    overflow: hidden;
    box-shadow:
        0 4px 22px rgba(0,0,0,.09);
    border-left: 6px solid #f59e0b;
}

.card.completed {
    border-left-color: #16a34a;
}

.card.failed {
    border-left-color: #dc2626;
}

.card-header {
    background: #172033;
    color: white;
    padding: 17px 20px;
}

.header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 15px;
    flex-wrap: wrap;
}

.proxy-number {
    font-size: 19px;
    font-weight: 700;
}

.status {
    padding: 6px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 700;
}

.status.testing {
    background: #d97706;
}

.status.completed {
    background: #15803d;
}

.status.failed {
    background: #b91c1c;
}

.proxy-box {
    margin-top: 13px;
    background: #0d1525;
    padding: 12px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 12px;
    word-break: break-all;
    color: #d9e3f0;
}

.card-body {
    padding: 20px;
}

.result-summary {
    display: inline-block;
    background: #dcfce7;
    color: #166534;
    padding: 10px 14px;
    border-radius: 8px;
    font-weight: 700;
    margin-bottom: 16px;
}

.testing-text {
    color: #64748b;
    font-size: 15px;
}

.copy-btn {
    background: #2563eb;
    color: white;
    padding: 8px 12px;
}

.copy-btn:hover {
    background: #1d4ed8;
}

.image-box {
    border: 1px solid #d0d7e2;
    border-radius: 10px;
    overflow: hidden;
    background: #f1f5f9;
}

.result-image {
    width: 100%;
    display: block;
    cursor: zoom-in;
}

.error-box {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
    padding: 15px;
    border-radius: 9px;
    word-break: break-word;
}

.info {
    color: #64748b;
    font-size: 13px;
    margin-bottom: 12px;
}


/* IMAGE MODAL */

.modal {
    display: none;
    position: fixed;
    z-index: 9999;
    inset: 0;
    background: rgba(0,0,0,.92);
    padding: 30px;
    overflow: auto;
}

.modal img {
    display: block;
    max-width: 100%;
    margin: auto;
}

.close {
    position: fixed;
    top: 12px;
    right: 25px;
    color: white;
    font-size: 38px;
    cursor: pointer;
}

@media (max-width: 700px) {

    .container {
        width: 96%;
        margin-top: 15px;
    }

    h1 {
        font-size: 22px;
    }

}

</style>

</head>

<body>

<div class="container">

    <div class="top">

        <h1>Proxy DNS Tester</h1>

        <div class="subtitle">
            Each proxy is tested separately and its BrowserLeaks DNS result is captured.
        </div>

    </div>


    <div class="panel">

        <textarea
            id="proxyInput"
            placeholder="Paste proxies here...

proxy.example.com:3120:username:password
proxy.example.com:3120:username:password

You can separate proxies with new lines or spaces."
        ></textarea>


        <div class="controls">

            <label>

                Parallel Tests:

                <select id="parallel">
                    <option value="1">1</option>
                    <option value="2" selected>2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5</option>
                </select>

            </label>


            <button
                class="primary"
                id="startButton"
                onclick="startTest()"
            >
                Start Testing
            </button>


            <button
                class="secondary"
                onclick="clearResults()"
            >
                Clear
            </button>

        </div>

    </div>


    <div class="progress-box">

        <div class="progress-top">

            <span id="progressText">
                Waiting for proxies...
            </span>

            <span id="progressNumber">
                0 / 0
            </span>

        </div>

        <div class="progress-bg">

            <div
                class="progress-bar"
                id="progressBar"
            ></div>

        </div>

    </div>


    <div
        class="results"
        id="results"
    ></div>

</div>


<div
    class="modal"
    id="modal"
    onclick="closeModal()"
>

    <span class="close">×</span>

    <img id="modalImage">

</div>


<script>

let eventSource = null;

let total = 0;
let completed = 0;


// ========================================================
// HTML ESCAPE
// ========================================================

function escapeHtml(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// ========================================================
// GET PROXIES
// ========================================================

function getProxies() {

    return document
        .getElementById("proxyInput")
        .value
        .split(/\\s+/)
        .map(proxy => proxy.trim())
        .filter(Boolean);
}


// ========================================================
// CREATE TESTING CARD
// ========================================================

function createTestingCard(data) {

    const card =
        document.createElement("div");

    card.className = "card";

    card.id = "card-" + data.id;

    card.innerHTML = \`

        <div class="card-header">

            <div class="header-row">

                <div class="proxy-number">
                    Proxy #\${data.number}
                </div>

                <span class="status testing">
                    TESTING
                </span>

            </div>

            <div class="proxy-box">
                \${escapeHtml(data.proxy)}
            </div>

        </div>


        <div class="card-body">

            <div class="testing-text">
                Opening BrowserLeaks DNS test and waiting for results...
            </div>

        </div>

    \`;

    document
        .getElementById("results")
        .appendChild(card);
}


// ========================================================
// COMPLETED CARD
// ========================================================

function showCompleted(data) {

    const card =
        document.getElementById(
            "card-" + data.id
        );

    if (!card) return;

    card.className = "card completed";

    card.innerHTML = \`

        <div class="card-header">

            <div class="header-row">

                <div class="proxy-number">
                    Proxy #\${data.number}
                </div>

                <div>

                    <span class="status completed">
                        COMPLETED
                    </span>

                    <button
                        class="copy-btn"
                        onclick='copyProxy(\${JSON.stringify(data.proxy)}, this)'
                    >
                        Copy Proxy
                    </button>

                </div>

            </div>

            <div class="proxy-box">
                \${escapeHtml(data.proxy)}
            </div>

        </div>


        <div class="card-body">

            <div class="result-summary">
                \${escapeHtml(data.summary)}
            </div>


            <div class="info">
                Actual BrowserLeaks DNS result captured through this proxy.
                Click the image to enlarge.
            </div>


            <div class="image-box">

                <img
                    class="result-image"
                    src="\${data.image}"
                    onclick="openModal(this.src)"
                >

            </div>

        </div>

    \`;
}


// ========================================================
// FAILED CARD
// ========================================================

function showFailed(data) {

    const card =
        document.getElementById(
            "card-" + data.id
        );

    if (!card) return;

    card.className = "card failed";

    card.innerHTML = \`

        <div class="card-header">

            <div class="header-row">

                <div class="proxy-number">
                    Proxy #\${data.number}
                </div>

                <div>

                    <span class="status failed">
                        FAILED
                    </span>

                    <button
                        class="copy-btn"
                        onclick='copyProxy(\${JSON.stringify(data.proxy)}, this)'
                    >
                        Copy Proxy
                    </button>

                </div>

            </div>

            <div class="proxy-box">
                \${escapeHtml(data.proxy)}
            </div>

        </div>


        <div class="card-body">

            <div class="error-box">

                <b>Test could not be completed.</b>

                <br><br>

                \${escapeHtml(data.error)}

            </div>

        </div>

    \`;
}


// ========================================================
// COPY
// ========================================================

async function copyProxy(proxy, button) {

    try {

        await navigator.clipboard.writeText(proxy);

        const oldText =
            button.textContent;

        button.textContent =
            "Copied ✓";

        setTimeout(() => {
            button.textContent =
                oldText;
        }, 1500);

    } catch (error) {

        alert("Could not copy proxy.");

    }
}


// ========================================================
// MODAL
// ========================================================

function openModal(src) {

    document
        .getElementById("modalImage")
        .src = src;

    document
        .getElementById("modal")
        .style.display = "block";
}


function closeModal() {

    document
        .getElementById("modal")
        .style.display = "none";
}


// ========================================================
// UPDATE PROGRESS
// ========================================================

function updateProgress() {

    const percent =
        total === 0
            ? 0
            : (completed / total) * 100;

    document
        .getElementById("progressBar")
        .style.width =
        percent + "%";

    document
        .getElementById("progressNumber")
        .textContent =
        completed + " / " + total;

    document
        .getElementById("progressText")
        .textContent =
        completed === total
            ? "Testing completed"
            : "Testing proxies...";
}


// ========================================================
// START
// ========================================================

async function startTest() {

    const proxies =
        getProxies();

    if (proxies.length === 0) {

        alert(
            "Please paste at least one proxy."
        );

        return;
    }


    if (eventSource) {

        eventSource.close();
        eventSource = null;
    }


    document
        .getElementById("results")
        .innerHTML = "";


    total = proxies.length;
    completed = 0;

    updateProgress();


    const startButton =
        document.getElementById(
            "startButton"
        );

    startButton.disabled = true;


    try {

        const response =
            await fetch("/start", {

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify({

                        proxies,

                        parallel:
                            Number(
                                document
                                    .getElementById("parallel")
                                    .value
                            )

                    })

            });


        const job =
            await response.json();


        if (!response.ok) {

            throw new Error(
                job.error ||
                "Could not start test."
            );
        }


        eventSource =
            new EventSource(
                "/events/" +
                job.jobId
            );


        eventSource.addEventListener(
            "started",
            event => {

                createTestingCard(
                    JSON.parse(
                        event.data
                    )
                );

            }
        );


        eventSource.addEventListener(
            "completed",
            event => {

                showCompleted(
                    JSON.parse(
                        event.data
                    )
                );

                completed++;

                updateProgress();

            }
        );


        eventSource.addEventListener(
            "failed",
            event => {

                showFailed(
                    JSON.parse(
                        event.data
                    )
                );

                completed++;

                updateProgress();

            }
        );


        eventSource.addEventListener(
            "done",
            () => {

                completed = total;

                updateProgress();

                startButton.disabled = false;

                if (eventSource) {
                    eventSource.close();
                    eventSource = null;
                }

            }
        );


        eventSource.onerror =
            function () {

                // Do not immediately mark the test as failed.
                // SSE can reconnect automatically.

            };


    } catch (error) {

        alert(error.message);

        startButton.disabled = false;

    }
}


// ========================================================
// CLEAR
// ========================================================

function clearResults() {

    if (eventSource) {

        eventSource.close();
        eventSource = null;

    }

    document
        .getElementById("results")
        .innerHTML = "";

    total = 0;
    completed = 0;

    updateProgress();

    document
        .getElementById("startButton")
        .disabled = false;
}

</script>

</body>
</html>`);
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

    console.log("");
    console.log("==========================================");
    console.log(" Proxy DNS Tester is running");
    console.log(` http://localhost:${PORT}`);
    console.log("==========================================");
    console.log("");

});