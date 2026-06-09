import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, ".easy_exam_runtime");
const settingsPath = path.join(runtimeDir, "settings.json");
const profileDir = path.join(runtimeDir, "time-test-profile");
const shotPath = path.join(runtimeDir, "time-test-result.png");
const addUrl = "https://eztest.org/manager/schedule/session/wizard/add/";

const START = "2026-06-15 13:30:00";
const END = "2026-06-15 16:00:00";

function parseDt(value) {
  const match = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return `${match[1]}/${match[2].padStart(2, "0")}/${match[3].padStart(2, "0")} ${match[4].padStart(2, "0")}:${match[5]}`;
}

async function fillLogin(page, login) {
  if (!/login/i.test(page.url()) && (await page.locator("input[type='password']").count()) === 0) return;
  const userInput = page
    .locator("input")
    .filter({ hasText: "" })
    .and(page.locator("input[placeholder*='手机'], input[placeholder*='邮箱'], input[placeholder*='账号']"))
    .first();
  if ((await userInput.count()) > 0) {
    await userInput.fill(login.username);
  } else {
    await page.locator("input:not([type='password']):not([type='checkbox'])").first().fill(login.username);
  }
  await page.locator("input[type='password'], input[placeholder*='密码']").first().fill(login.password);
  await page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const checkbox = [...document.querySelectorAll("input[type='checkbox'], .ant-checkbox-input")].find(visible);
    if (checkbox && !checkbox.checked) {
      checkbox.click();
    }
  });
  await page.getByRole("button", { name: /登\s*录/ }).click({ force: true });
  await page.waitForURL((url) => !/login/i.test(url.href), { timeout: 30000 }).catch(() => {});
}

async function setTime(page, placeholder, value) {
  const ok = await page.evaluate(
    ({ targetPlaceholder, nextValue }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const input = [...document.querySelectorAll("input")]
        .find((el) => visible(el) && (el.getAttribute("placeholder") || "").includes(targetPlaceholder));
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const previous = input.value;
      input.closest(".ant-picker, .ant-calendar-picker")?.click();
      input.focus();
      input.removeAttribute("readonly");
      input.removeAttribute("disabled");
      if (setter) setter.call(input, nextValue);
      else input.value = nextValue;
      if (input._valueTracker) input._valueTracker.setValue(previous);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    },
    { targetPlaceholder: placeholder, nextValue: value },
  );
  if (!ok) throw new Error(`未找到${placeholder}输入框`);
}

async function setTimeRange(page, startValue, endValue) {
  const ok = await page.evaluate(({ startText, endText }) => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const inputs = [...document.querySelectorAll("input")]
      .filter((el) => visible(el) && /开始时间|结束时间/.test(el.getAttribute("placeholder") || ""))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const startInput = inputs.find((el) => (el.getAttribute("placeholder") || "").includes("开始时间")) || inputs[0];
    const endInput = inputs.find((el) => (el.getAttribute("placeholder") || "").includes("结束时间")) || inputs[1];
    if (!startInput || !endInput) return false;

    const setNativeValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const previous = input.value;
      input.removeAttribute("readonly");
      input.removeAttribute("disabled");
      input.focus();
      if (setter) setter.call(input, value);
      else input.value = value;
      if (input._valueTracker) input._valueTracker.setValue(previous);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    setNativeValue(startInput, startText);
    setNativeValue(endInput, endText);
    document.body.click();
    return true;
  }, { startText: startValue, endText: endValue });
  if (!ok) throw new Error("未找到开始/结束时间输入框");
  await page.keyboard.press("Escape").catch(() => {});
}

async function confirmTime(page) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const okButton = [...document.querySelectorAll(".ant-calendar-ok-btn, .ant-picker-ok button, button")]
      .filter(visible)
      .find((el) => /确\s*定/.test(el.textContent || ""));
    if (okButton) {
      okButton.removeAttribute("disabled");
      okButton.classList.remove("ant-calendar-ok-btn-disabled");
      okButton.click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    await page.keyboard.press("Enter").catch(() => {});
  }
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape").catch(() => {});
}

async function readTime(page, placeholder) {
  return page.evaluate((targetPlaceholder) => {
    const input = [...document.querySelectorAll("input")]
      .find((el) => (el.getAttribute("placeholder") || "").includes(targetPlaceholder));
    return input?.value || "";
  }, placeholder);
}

const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
await fs.mkdir(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 1100 },
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  args: ["--window-size=1440,1100"],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(addUrl, { waitUntil: "domcontentloaded" });
await fillLogin(page, settings.login);
if (!page.url().includes("/wizard/add")) {
  await page.goto(addUrl, { waitUntil: "domcontentloaded" });
}
await page.waitForTimeout(2000);
console.log(`当前 URL: ${page.url()}`);
console.log(`页面标题: ${await page.title().catch(() => "")}`);
await page.screenshot({ path: path.join(runtimeDir, "time-test-before-wait.png"), fullPage: true });
await page.getByPlaceholder("开始时间").first().waitFor({ state: "visible", timeout: 30000 });

await setTimeRange(page, START, END);
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(500);

const start = await readTime(page, "开始时间");
const end = await readTime(page, "结束时间");
await page.screenshot({ path: shotPath, fullPage: true });

console.log(`开始时间回显: ${start}`);
console.log(`结束时间回显: ${end}`);
console.log(`截图: ${shotPath}`);

if (parseDt(start) !== parseDt(START) || parseDt(end) !== parseDt(END)) {
  throw new Error(`时间回显不一致，期望 ${START} - ${END}，实际 ${start} - ${end}`);
}

console.log("时间单项测试通过");
