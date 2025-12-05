// server.js — Render Optimized with Warm-Up Browser
// December 2025 — Ultra Stable Version

import cors from "cors";
import express from "express";
import { chromium } from "playwright-core";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

const PORT = process.env.PORT || 3001;
const ETHER_URL = "https://ether0.platform.futurehouse.org/";

// ------------------------------------------------------
// GLOBAL BROWSER INSTANCE (Warm-up)
// ------------------------------------------------------
let warmBrowser = null;
let warmReady = false;

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--blink-settings=imagesEnabled=false",
      "--media-cache-size=0",
      "--disk-cache-size=0"
    ]
  });
}

// ------------------------------------------------------
// WARM-UP: Runs AFTER server boots (non-blocking)
// ------------------------------------------------------
async function warmUp() {
  try {
    console.log("Warm-up: launching Chromium...");
    warmBrowser = await launchBrowser();

    const ctx = await warmBrowser.newContext({ bypassCSP: true });
    const page = await ctx.newPage();

    await page.route("**/*", route => {
      const url = route.request().url();
      if (
        [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".woff", ".ttf"].some(x => url.includes(x)) ||
        url.includes("analytics") ||
        url.includes("googletag") ||
        url.includes("hotjar")
      ) {
        return route.abort();
      }
      route.continue();
    });

    console.log("Warm-up: preloading Ether0...");
    await page.goto(ETHER_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000   // IMPORTANT
    });

    warmReady = true;
    console.log("Warm-up DONE ✔ Browser is ready.");
  } catch (err) {
    warmReady = false;
    console.log("Warm-up failed:", err.message);
  }
}

// Trigger warm-up 5 seconds after boot
setTimeout(warmUp, 5000);

// ------------------------------------------------------
// Create a new page from warm browser or fallback
// ------------------------------------------------------
async function getPage() {
  if (warmReady && warmBrowser) {
    try {
      const context = await warmBrowser.newContext({ bypassCSP: true });
      return await context.newPage();
    } catch {
      console.log("Warm browser died → launching fallback.");
    }
  }

  // fallback launch
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  page._tempBrowser = browser;  // store for cleanup
  return page;
}

// ------------------------------------------------------
// MAIN ENDPOINT  — /ask
// ------------------------------------------------------
app.post("/ask", async (req, res) => {
  const { question } = req.body;
  if (!question?.trim())
    return res.status(400).json({ error: "question required" });

  // SSE HEADERS
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let page = null;
  try {
    page = await getPage();

    // BLOCK heavy resources
    await page.route("**/*", route => {
      const url = route.request().url();
      if (
        [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".woff", ".ttf"].some(x => url.includes(x)) ||
        url.includes("analytics") ||
        url.includes("googletag") ||
        url.includes("hotjar")
      ) {
        return route.abort();
      }
      route.continue();
    });

    console.log("Navigating to Ether0...");
    await page.goto(ETHER_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Fill question
    const textarea = await page.waitForSelector(
      'textarea[aria-label*="Ask your chemistry question"]',
      { timeout: 30000 }
    );

    await textarea.fill(question);

    const submit = await page.waitForSelector(
      'button[kind="primary"]:has-text("Submit")'
    );
    await submit.click();

    // Stream reasoning
    const box = page.locator(
      'div[style*="background-color: rgb(38, 39, 48)"], div[style*="background-color: #26272f"]'
    );

    await box.waitFor({ state: "visible", timeout: 30000 });

    let full = "";
    let prev = "";

    while (true) {
      const txt = await box.innerText().catch(() => "");
      if (txt && txt.length > prev.length) {
        const delta = txt.slice(prev.length);
        prev = txt;
        full += delta;
        send({ type: "reasoning", content: delta });
      }

      if (/\*\*[^*]+\*\*/.test(full)) break;

      await page.waitForTimeout(300);
    }

    // Extract SMILES
    const match = full.match(/\*\*([^*]+)\*\*/);
    const smiles = match ? match[1].trim() : null;
    send({ type: "answer", content: smiles || "No SMILES found" });

    if (smiles) {
      const id = "smiles-" + Date.now();
      const html = `
        <div style="background:white;padding:20px;border-radius:10px;margin-top:10px;">
          <script src="https://unpkg.com/smiles-drawer@2.0.1/dist/smiles-drawer.min.js"></script>
          <div id="${id}" style="height:400px;display:flex;justify-content:center;align-items:center;"></div>
          <script>
            (function(){
              const smiles = "${smiles}";
              const container = document.getElementById("${id}");
              try {
                const isReaction = smiles.includes(">");
                if (isReaction) {
                  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                  svg.setAttribute("data-smiles", smiles);
                  svg.setAttribute("width", "100%");
                  svg.setAttribute("height", "400");
                  container.appendChild(svg);
                } else {
                  const img = document.createElement("img");
                  img.setAttribute("data-smiles", smiles);
                  img.setAttribute("data-smiles-options", '{"width":600,"height":400}');
                  container.appendChild(img);
                }
                SmiDrawer.apply();
              } catch (err) {
                container.innerHTML = "<p>Unable to render structure</p>";
              }
            })();
          </script>
        </div>
      `;

      send({ type: "structure", smiles, html });
    }

    send({ type: "done" });

  } catch (err) {
    console.log("ERR:", err.message);
    send({ type: "error", message: err.message });
  } finally {
    if (page && page._tempBrowser) {
      await page._tempBrowser.close();
    }
    res.end();
  }
});

app.listen(PORT, () => {
  console.log("Ether0 Proxy running on port " + PORT);
});
