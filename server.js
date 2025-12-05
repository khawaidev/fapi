// server.js — Render-Optimized Ether0 Proxy
// Last Updated: Dec 2025 (Ultra-Low-RAM Chromium Mode)

import cors from "cors";
import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const URL = "https://ether0.platform.futurehouse.org/";

app.post("/ask", async (req, res) => {
  const { question } = req.body;
  if (!question?.trim())
    return res.status(400).json({ error: "question required" });

  // -------- SSE HEADERS ----------
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let browser = null;

  try {
    // ----------------------------
    // LOW-RAM CHROMIUM LAUNCH
    // ----------------------------
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--single-process",
        "--no-zygote",
        "--no-first-run",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--disable-features=IsolateOrigins,site-per-process",
        "--blink-settings=imagesEnabled=false",
        "--media-cache-size=0",
        "--disk-cache-size=0",
      ],
    });

    const context = await browser.newContext({
      bypassCSP: true,
      javaScriptEnabled: true,
    });

    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(20000);

    const page = await context.newPage();

    // -------------------------------------------------
    // BLOCK ALL HEAVY RESOURCES (HUGE RAM SAVINGS)
    // -------------------------------------------------
    await page.route("**/*", (route) => {
      const url = route.request().url();

      if (
        [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".svg",
          ".webp",
          ".woff",
          ".ttf",
          ".otf",
          ".mp4",
          ".avi",
          ".mov",
        ].some((e) => url.includes(e)) ||
        url.includes("googletag") ||
        url.includes("analytics") ||
        url.includes("hotjar") ||
        url.includes("ads")
      ) {
        return route.abort();
      }

      route.continue();
    });

    // ----------------------------
    // LOAD ETHER0 PAGE
    // ----------------------------
    await page.goto(URL, { waitUntil: "domcontentloaded" });

    const textarea = await page.waitForSelector(
      'textarea[aria-label*="Ask your chemistry question"]',
      { state: "visible" }
    );

    await textarea.fill(question);

    const submit = await page.waitForSelector(
      'button[kind="primary"]:has-text("Submit")'
    );
    await submit.click();

    // ----------------------------
    // STREAM REASONING
    // ----------------------------
    const reasoningBox = page.locator(
      'div[style*="background-color: rgb(38, 39, 48)"], div[style*="background-color: #26272f"]'
    );
    await reasoningBox.waitFor({ state: "visible", timeout: 30000 });

    let full = "";
    let prev = "";

    while (true) {
      const txt = await reasoningBox.innerText({ timeout: 2000 }).catch(() => "");

      if (txt && txt.length > prev.length) {
        const delta = txt.slice(prev.length);
        full += delta;
        prev = txt;
        send({ type: "reasoning", content: delta });
      }

      // Ether0 always outputs **SMILES** in bold
      if (/\*\*[^*]+\*\*/.test(full)) break;

      await page.waitForTimeout(350);
    }

    // ----------------------------
    // EXTRACT SMILES
    // ----------------------------
    const match = full.match(/\*\*([^*]+)\*\*/);
    const smiles = match ? match[1].trim() : null;

    if (!smiles) {
      send({ type: "answer", content: "No SMILES found" });
      send({ type: "done" });
      return;
    }

    send({ type: "answer", content: smiles });

    // ----------------------------
    // PREPARE STRUCTURE RENDERING HTML
    // ----------------------------
    const id = `smiles-container-${Date.now()}`;

    const structureHtml = `
      <div style="background-color:white;padding:20px;border-radius:10px;margin:10px 0;">
        <script src="https://unpkg.com/smiles-drawer@2.0.1/dist/smiles-drawer.min.js"></script>
        <div id="${id}" style="display:flex;justify-content:center;align-items:center;min-height:400px;"></div>
        <script>
          (function(){
            const smiles = "${smiles}";
            const container = document.getElementById("${id}");

            try {
              const isReaction = smiles.includes('>');
              if (isReaction) {
                const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
                svg.setAttribute("data-smiles", smiles);
                svg.setAttribute("width","100%");
                svg.setAttribute("height","400");
                container.appendChild(svg);
              } else {
                const img = document.createElement("img");
                img.setAttribute("data-smiles", smiles);
                img.setAttribute("data-smiles-options", '{ "width":600, "height":400 }');
                container.appendChild(img);
              }
              SmiDrawer.apply();
            } catch(e){
              container.innerHTML="<p style='color:#555'>Unable to render structure</p>";
            }
          })();
        </script>
      </div>
    `;

    send({
      type: "structure",
      smiles,
      html: structureHtml,
    });

    send({ type: "done" });
  } catch (err) {
    console.error("ERR:", err);
    send({ type: "error", message: err.message });
  } finally {
    if (browser) await browser.close();
    res.end();
  }
});

app.listen(PORT, () => {
  console.log("Ether0 Proxy Ready on port " + PORT);
});
