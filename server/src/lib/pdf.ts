// ─────────────────────────────────────────────────────────────────────────────
// Geração de PDF a partir de HTML usando Puppeteer (Chromium headless)
// ─────────────────────────────────────────────────────────────────────────────

let puppeteerMod: typeof import("puppeteer") | null = null;

async function getPuppeteer() {
  if (!puppeteerMod) {
    puppeteerMod = await import("puppeteer");
  }
  return puppeteerMod;
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const pup = await getPuppeteer();
  const executablePath =
    process.env["PUPPETEER_EXECUTABLE_PATH"] ||
    "/root/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome";
  const browser = await pup.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
