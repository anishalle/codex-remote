import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = "/Users/ani/workspaces/github.com/anishalle/codex-remote";
const artifactDir = path.join(repoRoot, "output/playwright");
const localThreadUrl =
  "http://127.0.0.1:3773/378f2b7b-7f7b-4d37-a701-bb758d25b13f/7da6366f-903b-4f30-a3ba-e18d9eb8d0ed";
const publicThreadUrl =
  "https://codex.anishalle.com/378f2b7b-7f7b-4d37-a701-bb758d25b13f/7da6366f-903b-4f30-a3ba-e18d9eb8d0ed";
const publicTokenPath = "/Users/ani/.config/t3r/token";
const requireFromWeb = createRequire(path.join(repoRoot, "apps/web/package.json"));
const playwrightEntry = requireFromWeb.resolve("playwright");

mkdirSync(artifactDir, { recursive: true });

const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const results = {
  runStamp,
  duplicate: null,
  deny: null,
  approve: null,
  stop: null,
};

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function waitFor(fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(options.errorMessage ?? "Timed out waiting for condition.");
    }
    await delay(intervalMs);
  }
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function mainText(page) {
  return page.locator("main").innerText();
}

async function messageTimelineText(page) {
  const messages = await page.locator('[data-timeline-row-kind="message"]').allInnerTexts();
  return messages.join("\n");
}

async function waitForBodyText(page, text, label, timeoutMs = 60_000) {
  await waitFor(
    async () => (await bodyText(page)).includes(text),
    {
      timeoutMs,
      errorMessage: `Timed out waiting for "${text}" on ${label}.`,
    },
  );
}

async function waitForMainText(page, text, label, timeoutMs = 60_000) {
  await waitFor(
    async () => (await mainText(page)).includes(text),
    {
      timeoutMs,
      errorMessage: `Timed out waiting for "${text}" on ${label}.`,
    },
  );
}

async function waitForMainTextCount(page, text, count, label, timeoutMs = 60_000) {
  await waitFor(
    async () => countOccurrences(await mainText(page), text) === count,
    {
      timeoutMs,
      errorMessage: `Timed out waiting for ${count} occurrence(s) of "${text}" on ${label}.`,
    },
  );
}

async function waitForMessageText(page, text, label, timeoutMs = 60_000) {
  await waitFor(
    async () => (await messageTimelineText(page)).includes(text),
    {
      timeoutMs,
      errorMessage: `Timed out waiting for "${text}" in message rows on ${label}.`,
    },
  );
}

async function waitForMessageTextCount(page, text, count, label, timeoutMs = 60_000) {
  await waitFor(
    async () => countOccurrences(await messageTimelineText(page), text) === count,
    {
      timeoutMs,
      errorMessage: `Timed out waiting for ${count} occurrence(s) of "${text}" in message rows on ${label}.`,
    },
  );
}

async function waitForExactTextCount(page, text, count, label, timeoutMs = 60_000) {
  await waitFor(
    async () => (await page.getByText(text, { exact: true }).count()) === count,
    {
      timeoutMs,
      errorMessage: `Timed out waiting for ${count} exact occurrence(s) of "${text}" on ${label}.`,
    },
  );
}

async function waitForFile(pathname, timeoutMs = 60_000) {
  await waitFor(
    async () => existsSync(pathname),
    {
      timeoutMs,
      errorMessage: `Timed out waiting for file ${pathname}.`,
    },
  );
}

async function waitForNoFile(pathname, timeoutMs = 60_000) {
  await waitFor(
    async () => !existsSync(pathname),
    {
      timeoutMs,
      errorMessage: `Timed out waiting for file ${pathname} to stay absent.`,
    },
  );
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(artifactDir, `${runStamp}-${name}.png`), fullPage: true });
}

async function assertComposerBaseline(page, label) {
  await page.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("combobox", { name: "Runtime mode" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const text = await bodyText(page);
  assert(text.includes("GPT-5.3-Codex-Spark"), `${label} did not show GPT-5.3-Codex-Spark.`);
  assert(text.includes("Low"), `${label} did not show Low reasoning.`);
  assert(text.includes("Supervised"), `${label} did not show Supervised runtime mode.`);
}

async function clearAndSend(page, prompt) {
  const composer = page.getByTestId("composer-editor");
  const sendButton = page.getByRole("button", { name: "Send message", exact: true });
  await composer.click();
  await composer.fill("");
  await composer.fill(prompt);
  await waitFor(
    async () => sendButton.isEnabled(),
    { timeoutMs: 10_000, errorMessage: "Send button never enabled." },
  );
  await sendButton.click();
}

async function waitForApprovalControls(page, label) {
  const approveOnce = page.getByRole("button", { name: "Approve once", exact: true });
  const decline = page.getByRole("button", { name: "Decline", exact: true });
  await approveOnce.waitFor({ state: "visible", timeout: 60_000 });
  await decline.waitFor({ state: "visible", timeout: 60_000 });
  const text = await bodyText(page);
  assert(text.includes("PENDING APPROVAL"), `${label} never showed a pending approval banner.`);
  return { approveOnce, decline };
}

function createPairingToken() {
  const stdout = execFileSync("node", ["apps/server/dist/bin.mjs", "auth", "pairing", "create", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout);
  assert(typeof parsed.credential === "string" && parsed.credential.length > 0, "Missing pairing credential.");
  return parsed.credential;
}

async function main() {
  const playwrightModule = await import(pathToFileURL(playwrightEntry).href);
  const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
  assert(chromium, "Unable to resolve Playwright chromium launcher.");
  const pairingToken = createPairingToken();
  const publicToken = readFileSync(publicTokenPath, "utf8").trim();
  assert(publicToken.length > 0, "Missing public session token.");

  const browser = await chromium.launch({
    headless: true,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: "/tmp/playwright-browsers",
    },
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });

  try {
    const localPage = await context.newPage();
    await localPage.goto(`http://127.0.0.1:3773/pair#token=${pairingToken}`, {
      waitUntil: "domcontentloaded",
    });
    await localPage.waitForURL("http://127.0.0.1:3773/", { timeout: 30_000 });
    await localPage.goto(localThreadUrl, { waitUntil: "domcontentloaded" });
    await localPage.waitForURL(localThreadUrl, { timeout: 30_000 });
    await assertComposerBaseline(localPage, "local page");

    await context.addCookies([
      {
        name: "t3_session",
        value: publicToken,
        domain: "codex.anishalle.com",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax",
      },
    ]);
    const publicPage = await context.newPage();
    await publicPage.goto(publicThreadUrl, { waitUntil: "domcontentloaded" });
    await publicPage.waitForURL(publicThreadUrl, { timeout: 30_000 });
    await assertComposerBaseline(publicPage, "public page");

    await screenshot(localPage, "local-ready");
    await screenshot(publicPage, "public-ready");

    const duplicateToken = `REMOTE_DUPLICATE_PROMPT_${runStamp}`;
    const duplicateAck = `REMOTE_DUPLICATE_ACK_${runStamp}`;
    const duplicatePrompt = `${duplicateToken}. Reply with exactly ${duplicateAck} and nothing else.`;

    await clearAndSend(publicPage, duplicatePrompt);
    await waitForExactTextCount(localPage, duplicatePrompt, 1, "local duplicate check");
    await waitForExactTextCount(publicPage, duplicatePrompt, 1, "public duplicate check");
    await waitForExactTextCount(localPage, duplicateAck, 1, "local duplicate response");
    await waitForExactTextCount(publicPage, duplicateAck, 1, "public duplicate response");
    results.duplicate = {
      prompt: duplicateToken,
      response: duplicateAck,
      localPromptCount: await localPage.getByText(duplicatePrompt, { exact: true }).count(),
      publicPromptCount: await publicPage.getByText(duplicatePrompt, { exact: true }).count(),
    };
    await screenshot(localPage, "duplicate-local");
    await screenshot(publicPage, "duplicate-public");

    const denyPath = `/tmp/codex-remote-approval-deny-${runStamp}.txt`;
    rmSync(denyPath, { force: true });
    const denyAck = `DENY_ACK_${runStamp}`;
    const denyPrompt = `Write the text DENY_${runStamp} to ${denyPath}, then reply with only ${denyAck}.`;
    await clearAndSend(localPage, denyPrompt);
    const denyApproval = await waitForApprovalControls(publicPage, "public deny flow");
    await screenshot(publicPage, "deny-pending");
    await denyApproval.decline.click();
    await waitForMainText(localPage, "Command declined", "local deny result");
    await waitForNoFile(denyPath, 5_000);
    await delay(5_000);
    const localDenyAckCount = await localPage.getByText(denyAck, { exact: true }).count();
    const publicDenyAckCount = await publicPage.getByText(denyAck, { exact: true }).count();
    assert.equal(localDenyAckCount, 0, "Local page rendered a deny ack after decline.");
    assert.equal(publicDenyAckCount, 0, "Public page rendered a deny ack after decline.");
    results.deny = {
      path: denyPath,
      fileExists: existsSync(denyPath),
      localAckCount: localDenyAckCount,
      publicAckCount: publicDenyAckCount,
    };
    await screenshot(localPage, "deny-local");
    await screenshot(publicPage, "deny-public");

    const approvePath = `/tmp/codex-remote-approval-approve-${runStamp}.txt`;
    rmSync(approvePath, { force: true });
    const approveValue = `APPROVE_${runStamp}`;
    const approveAck = `APPROVE_ACK_${runStamp}`;
    const approvePrompt = `Write the text ${approveValue} to ${approvePath}, then reply with only ${approveAck}.`;
    await clearAndSend(localPage, approvePrompt);
    const approveApproval = await waitForApprovalControls(publicPage, "public approve flow");
    await screenshot(publicPage, "approve-pending");
    await approveApproval.approveOnce.click();
    await waitForFile(approvePath, 60_000);
    const approveContents = readFileSync(approvePath, "utf8");
    assert.equal(approveContents.trimEnd(), approveValue, "Approved write contents did not match.");
    await waitForExactTextCount(localPage, approveAck, 1, "local approve ack");
    await waitForExactTextCount(publicPage, approveAck, 1, "public approve ack");
    results.approve = {
      path: approvePath,
      contents: approveContents,
      ack: approveAck,
    };
    await screenshot(localPage, "approve-local");
    await screenshot(publicPage, "approve-public");

    const stopPath = `/tmp/codex-remote-stop-${runStamp}.txt`;
    rmSync(stopPath, { force: true });
    const stopValue = `STOP_${runStamp}`;
    const stopAck = `STOP_ACK_${runStamp}`;
    const stopPrompt = `Run the shell command sleep 12 && printf ${stopValue} > ${stopPath} exactly once, then reply with only ${stopAck}.`;
    await clearAndSend(localPage, stopPrompt);
    const stopApproval = await waitForApprovalControls(publicPage, "public stop flow");
    await screenshot(publicPage, "stop-pending");
    await stopApproval.approveOnce.click();
    const stopButton = publicPage.getByRole("button", { name: "Stop generation", exact: true });
    await stopButton.waitFor({ state: "visible", timeout: 30_000 });
    await screenshot(publicPage, "stop-visible");
    await stopButton.click();
    await waitFor(
      async () => !(await stopButton.isVisible().catch(() => false)),
      {
        timeoutMs: 20_000,
        errorMessage: "Stop button never cleared after interrupt.",
      },
    );
    await delay(15_000);
    assert(!existsSync(stopPath), "Stop flow still allowed the command side effect to land.");
    const localStopAckCount = await localPage.getByText(stopAck, { exact: true }).count();
    const publicStopAckCount = await publicPage.getByText(stopAck, { exact: true }).count();
    assert.equal(localStopAckCount, 0, "Local page rendered a stop ack after interrupt.");
    assert.equal(publicStopAckCount, 0, "Public page rendered a stop ack after interrupt.");
    results.stop = {
      path: stopPath,
      fileExists: existsSync(stopPath),
      localAckCount: localStopAckCount,
      publicAckCount: publicStopAckCount,
    };
    await screenshot(localPage, "stop-local");
    await screenshot(publicPage, "stop-public");

    writeFileSync(
      path.join(artifactDir, `${runStamp}-handoff-validation-results.json`),
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
