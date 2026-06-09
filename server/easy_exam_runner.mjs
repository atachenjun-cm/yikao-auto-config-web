import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const EZTEST_ADD_URL = "https://eztest.org/manager/schedule/session/wizard/add/";
const EZTEST_LIST_URL = "https://eztest.org/manager/schedule/session/list/all/";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pythonBin =
  process.env.CODEX_PYTHON ||
  "/Users/chen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const subjectTemplateScript = path.join(__dirname, "fill_subject_template.py");

function timestamp() {
  return new Date().toISOString();
}

function event(type, payload = {}) {
  return { type, ts: timestamp(), ...payload };
}

function parseDateTimeValue(value) {
  const match = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function pause(ms = 500) {
  await delay(ms);
}

async function isLoginPage(page) {
  const hints = ["账号密码登录", "验证码登录", "请输入密码", "手机或邮箱", "请输入正确的手机或邮箱"];
  for (const hint of hints) {
    if ((await page.getByText(hint, { exact: false }).count()) > 0) {
      return true;
    }
  }
  return (await page.locator("input[type='password']").count()) > 0;
}

async function firstVisibleLocator(candidates, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const locator of candidates) {
      try {
        if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
          return locator.first();
        }
      } catch {}
    }
    await delay(250);
  }
  return null;
}

async function clearAndType(locator, value) {
  await locator.click({ clickCount: 3 });
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await locator.fill("");
  await locator.type(value, { delay: 0 });

  let current = await locator.inputValue().catch(() => "");
  if (current !== value) {
    await locator.fill(value);
    current = await locator.inputValue().catch(() => "");
  }
  if (current !== value) {
    throw new Error("输入框回读校验失败，页面未接受输入值。");
  }
}

async function performLogin(page, login, emit) {
  if (!login?.url || !login?.username || !login?.password) {
    return false;
  }

  if ((await isLoginPage(page)) || page.url().includes("/login")) {
    emit(event("status", { status: "running", message: "正在登录页填写账号密码" }));
  } else {
    emit(event("status", { status: "running", message: "正在打开登录页" }));
    await page.goto(login.url, { waitUntil: "domcontentloaded" });
    await pause(1200);
  }

  if (!(await isLoginPage(page))) {
    emit(event("log", { level: "success", message: "当前会话已处于登录态，跳过账号密码输入。" }));
    return false;
  }

  const userLocator = await firstVisibleLocator([
    page.getByPlaceholder("请输入手机或邮箱（必填）"),
    page.getByPlaceholder("请输入手机或邮箱"),
    page.locator("input[placeholder*='手机或邮箱']"),
    page.locator("input[placeholder*='邮箱']"),
    page.locator("input[placeholder*='账号']"),
    page.locator("input[type='email']"),
    page.locator("input[type='text']").first(),
  ]);
  const passwordLocator = await firstVisibleLocator([
    page.getByPlaceholder("请输入密码（必填）"),
    page.getByPlaceholder("请输入密码"),
    page.locator("input[type='password']"),
  ]);

  if (!userLocator || !passwordLocator) {
    throw new Error("未识别到登录页的账号或密码输入框。");
  }

  emit(event("log", { level: "success", message: "已识别登录页输入框，开始填写账号密码。" }));
  emit(event("status", { status: "running", message: "正在填写账号密码" }));
  await clearAndType(userLocator, login.username);
  await clearAndType(passwordLocator, login.password);

  const consent = await firstVisibleLocator([
    page.locator("label:has-text('已阅读并同意') input[type='checkbox']"),
    page.locator("input[type='checkbox']").first(),
  ], 2000);
  if (consent) {
    try {
      if (!(await consent.isChecked())) {
        await consent.check();
      }
    } catch {}
  }

  const submitCandidates = [
    page.getByRole("button", { name: "登录" }).first(),
    page.getByRole("button", { name: "登 录" }).first(),
    page.locator("button[type='submit']").first(),
    page.locator("input[type='submit']").first(),
  ];

  let clicked = false;
  for (const locator of submitCandidates) {
    if ((await locator.count()) > 0) {
      await locator.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    await passwordLocator.press("Enter");
  }

  emit(event("log", { level: "success", message: "已提交易考后台登录信息。" }));
  emit(event("status", { status: "running", message: "已提交登录，等待后台跳转" }));
  const loginDeadline = Date.now() + 12_000;
  while (Date.now() < loginDeadline) {
    if (!(await isLoginPage(page))) {
      return true;
    }
    await delay(500);
  }
  return true;
}

async function isAddWizardPage(page) {
  if (await isLoginPage(page)) {
    return false;
  }
  const hasExamName =
    (await page.getByText("考试名称", { exact: false }).count()) > 0 ||
    (await page.getByPlaceholder("考试名称").count()) > 0;
  const hasBasicStep = (await page.getByText("基本信息", { exact: false }).count()) > 0;
  const hasTimeFields =
    (await page.getByPlaceholder("开始时间").count()) > 0 || (await page.getByPlaceholder("结束时间").count()) > 0;
  return hasBasicStep && (hasExamName || hasTimeFields);
}

async function waitForBasicInfoReady(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isAddWizardPage(page)) {
      return true;
    }
    await delay(500);
  }
  return false;
}

async function openNewExamFromExamNav(page, emit) {
  if (await isAddWizardPage(page)) {
    return true;
  }

  const examNav = page.getByText("考试", { exact: true }).first();
  if ((await examNav.count()) > 0 && (await examNav.isVisible().catch(() => false))) {
    emit(event("log", { level: "success", message: "已登录后台，正在点击“考试”。" }));
    await examNav.click();
    await pause(1200);
  }

  const newExamButton = page.getByText("新建考试", { exact: false }).first();
  if ((await newExamButton.count()) > 0 && (await newExamButton.isVisible().catch(() => false))) {
    emit(event("log", { level: "success", message: "已找到“新建考试”，正在进入基本信息页。" }));
    await newExamButton.click();
    await pause(1500);
    return true;
  }

  return false;
}

async function enterNewExamFromCurrentPage(page, emit) {
  const newExamButton = page.getByText("新建考试", { exact: false }).first();
  if ((await newExamButton.count()) > 0 && (await newExamButton.isVisible().catch(() => false))) {
    emit(event("log", { level: "success", message: "已找到“新建考试”，正在进入基本信息页。" }));
    await newExamButton.click();
    return true;
  }
  return false;
}

async function gotoAddWizardAfterLogin(page, emit, timeout = 12_000) {
  if (await waitForBasicInfoReady(page, 1000)) {
    return true;
  }
  if ((await isLoginPage(page)) || page.url().includes("/login")) {
    return false;
  }

  try {
    emit(event("log", { level: "success", message: "登录态已确认，直接进入新建考试页。" }));
    emit(event("status", { status: "running", message: "正在直接打开新建考试页" }));
    await page.goto(EZTEST_ADD_URL, { waitUntil: "domcontentloaded", timeout });
    return await waitForBasicInfoReady(page, timeout);
  } catch (error) {
    emit(event("log", { level: "warn", message: `直接进入新建考试页失败，改用页面点击兜底：${error.message}` }));
    return false;
  }
}

async function waitForLogin(page, emit, login) {
  if (await waitForBasicInfoReady(page, 5_000)) {
    return;
  }

  let triedAutoLogin = false;
  if ((await isLoginPage(page)) || page.url().includes("/login")) {
    if (login?.url && login?.username && login?.password) {
      emit(event("log", { level: "success", message: "检测到登录页，开始自动登录易考后台。" }));
      await performLogin(page, login, emit);
      triedAutoLogin = true;
      if (await gotoAddWizardAfterLogin(page, emit)) {
        emit(event("log", { level: "success", message: "已通过固定网址进入新建考试页。" }));
        emit(event("status", { status: "running", message: "继续配置考试" }));
        return;
      }
    } else {
      emit(event("status", { status: "action_required", message: "请先在打开的 Chrome 窗口登录易考后台。" }));
      emit(event("log", { level: "warn", message: "检测到登录页，等待人工完成登录。" }));
    }
  }

  const timeoutAt = Date.now() + 10 * 60_000;
  let lastNoticeAt = 0;
  let attemptedListPage = false;
  while (Date.now() < timeoutAt) {
    if (await waitForBasicInfoReady(page, 8_000)) {
      emit(event("log", { level: "success", message: "已检测到登录完成，继续执行。" }));
      emit(event("status", { status: "running", message: "继续配置考试" }));
      return;
    }
    if (Date.now() - lastNoticeAt > 5000) {
      emit(event("status", { status: "running", message: "等待进入新建考试页" }));
      lastNoticeAt = Date.now();
    }
    if ((await isLoginPage(page)) || page.url().includes("/login")) {
      if (!triedAutoLogin && login?.url && login?.username && login?.password) {
        emit(event("log", { level: "warn", message: "登录后仍停留在登录页，正在重试。" }));
        await performLogin(page, login, emit);
        triedAutoLogin = true;
      } else {
        emit(event("status", { status: "action_required", message: "登录未完成，请在浏览器中手动完成后脚本会继续。" }));
      }
      await delay(1500);
      continue;
    }

    if (await gotoAddWizardAfterLogin(page, emit, 8000)) {
      emit(event("log", { level: "success", message: "已通过固定网址进入新建考试页。" }));
      emit(event("status", { status: "running", message: "继续配置考试" }));
      return;
    }

    if (await openNewExamFromExamNav(page, emit)) {
      await delay(1500);
      continue;
    }

    if (await enterNewExamFromCurrentPage(page, emit)) {
      await delay(2000);
      continue;
    }

    if (!attemptedListPage) {
      try {
        emit(event("log", { level: "success", message: "当前页未发现“新建考试”，正在进入考试列表页。" }));
        await page.goto(EZTEST_LIST_URL, { waitUntil: "domcontentloaded" });
        attemptedListPage = true;
        await delay(1500);
        continue;
      } catch {}
    }

    await delay(2000);
  }

  throw new Error("等待登录超时，请刷新任务后重试。");
}

async function takeShot(page, shotsDir, jobId, slug, title) {
  const filePath = path.join(shotsDir, `${slug}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return { title, slug, filePath, url: `/artifacts/${jobId}/${path.basename(filePath)}` };
}

async function clickButton(page, name) {
  try {
    await page.getByRole("button", { name }).click({ timeout: 3000 });
    return;
  } catch {}

  const clicked = await evaluate(
    page,
    (targetName) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll("button, .ant-btn, a, div")]
        .filter((el) => visible(el) && norm(el.textContent) === targetName)
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (Math.abs(br.bottom - ar.bottom) > 2) return br.bottom - ar.bottom;
          return ar.left - br.left;
        });
      const target = candidates[0];
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
      }
      return true;
    },
    name,
  );
  if (!clicked) throw new Error(`未找到按钮：${name}`);
}

async function checkRadio(page, name) {
  await page.getByRole("radio", { name }).check();
}

async function selectRadioInGroup(page, groupLabel, optionLabel) {
  await evaluate(
    page,
    ({ targetGroupLabel, targetOptionLabel }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const group = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetGroupLabel))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)
        .find((el) => [...el.querySelectorAll("input[type='radio']")].length > 0);
      if (!group) {
        throw new Error(`未找到单选分组：${targetGroupLabel}`);
      }

      const labels = [...group.querySelectorAll("label")].filter((el) => visible(el) && norm(el.textContent).includes(targetOptionLabel));
      for (const label of labels) {
        const radio = label.querySelector("input[type='radio']");
        if (radio) {
          if (!radio.checked) {
            label.click();
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return;
        }
      }

      const radios = [...group.querySelectorAll("input[type='radio']")];
      const matchedRadio = radios.find((radio) => {
        const candidates = [
          radio.closest("label"),
          radio.parentElement,
          radio.parentElement?.parentElement,
          radio.closest("div"),
          radio.closest("span"),
        ].filter(Boolean);
        return candidates.some((node) => norm(node.textContent || "") === targetOptionLabel || norm(node.textContent || "").includes(targetOptionLabel));
      });
      if (!matchedRadio) {
        throw new Error(`未找到单选项：${targetGroupLabel} / ${targetOptionLabel}`);
      }
      if (!matchedRadio.checked) {
        matchedRadio.click();
        matchedRadio.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { targetGroupLabel: groupLabel, targetOptionLabel: optionLabel },
  );
}

async function fillTextInputByPlaceholder(page, placeholder, value) {
  const locator = page.getByPlaceholder(placeholder).first();
  await locator.click();
  await locator.fill(value);
}

async function fillLabeledTextField(page, label, value) {
  await evaluate(
    page,
    ({ targetLabel, nextValue }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const row = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)
        .find((el) => el.querySelector("input, textarea"));
      if (!row) {
        throw new Error(`未找到字段：${targetLabel}`);
      }

      const input = row.querySelector("input, textarea");
      input.focus();
      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { targetLabel: label, nextValue: value },
  );
}

async function fillExamNameField(page, value) {
  const locator = page.locator("textarea.ant-input").first();
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  await locator.click();
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await locator.fill("");
  await locator.type(value, { delay: 0 });
  const success = await expectExactTextareaValue(locator, value, 3000).then(() => true).catch(() => false);
  if (!success) {
    throw new Error("考试名称填写后校验失败。");
  }
}

async function readBasicInfoField(page, field) {
  return evaluate(
    page,
    ({ fieldName }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      if (fieldName === "考试名称") {
        const textarea = [...document.querySelectorAll("textarea.ant-input")].find(visible);
        return textarea?.value || "";
      }

      const placeholder = fieldName === "开始时间" ? "开始时间" : "结束时间";
      const input = [...document.querySelectorAll("input")]
        .find((el) => visible(el) && (el.getAttribute("placeholder") || "").includes(placeholder));
      return input?.value || "";
    },
    { fieldName: field },
  );
}

async function readBasicInfoTimezone(page) {
  return evaluate(page, () => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll("span, div, p")]
      .filter((el) => visible(el))
      .map((el) => (el.textContent || "").trim())
      .filter((text) => /^\(.+\)$/.test(text) && (text.includes("UTC") || text.includes("/")));
    return candidates[0] || "";
  });
}

async function setDateTimeField(page, placeholder, value, timezoneText = "", emit = null) {
  const locator = page.getByPlaceholder(placeholder).first();
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  const requirementParts = parseDateTimeValue(value);
  if (requirementParts) {
    emit?.(event("log", { level: "success", message: `${placeholder}按顺序输入并确认：${formatPartsForLog(requirementParts)}` }));
    if (await typeDateTimeAndConfirm(page, locator, requirementParts)) {
      const typedActual = await locator.inputValue().catch(() => "");
      emit?.(event("log", { level: parseDateTimeValue(typedActual) ? "success" : "warn", message: `${placeholder}输入确认后回显：${typedActual || "空"}` }));
      if (await isExactDateTimeValue(locator, requirementParts)) return;
      if (parseDateTimeValue(typedActual)) {
        emit?.(event("log", { level: "warn", message: `${placeholder}回显与需求单不一致，先继续填写提前登录/迟到，提交前会再次校验。` }));
        return;
      }
      emit?.(event("log", { level: "warn", message: `${placeholder}输入确认后仍为空，先继续填写提前登录/迟到。` }));
      return;
    }

    let pickerParts = requirementParts;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clearDateTimeInput(page, placeholder);
      await pause(120);
      await locator.click();
      await pause(150);
      try {
        emit?.(event("log", { level: "success", message: `${placeholder}第 ${attempt + 1} 次点击选择：${formatPartsForLog(pickerParts)}；目标回显：${formatPartsForLog(requirementParts)}` }));
        const selected = await selectDateTimeFromPicker(page, pickerParts, emit);
        if (selected) {
          await pause(300);
          const actual = await locator.inputValue().catch(() => "");
          emit?.(event("log", { level: parseDateTimeValue(actual) ? "success" : "warn", message: `${placeholder}页面回显：${actual || "空"}` }));
          const exact = await isExactDateTimeValue(locator, requirementParts);
          if (!exact) {
            const actualParts = parseDateTimeValue(actual);
            const offsetMinutes = actualParts ? diffDateTimeMinutes(actualParts, requirementParts) : null;
            if (actualParts && offsetMinutes !== 0 && attempt < 2) {
              pickerParts = addMinutesToParts(requirementParts, -offsetMinutes);
              emit?.(event("log", { level: "warn", message: `${placeholder}回显偏移 ${offsetMinutes} 分钟，改用控件重选：${formatPartsForLog(pickerParts)}` }));
              continue;
            }
            emit?.(event("log", { level: "warn", message: `${placeholder}控件重选仍不一致，最后写回需求单时间：${formatPartsForLog(requirementParts)}` }));
            await forceSetDateTimeInput(page, placeholder, formatPartsForLog(requirementParts));
          }
          await expectExactDateTimeValue(locator, requirementParts, 2500);
          return;
        }
      } catch (error) {
        emit?.(event("log", { level: "warn", message: `${placeholder}选择尝试失败：${error.message || String(error)}` }));
      }
      await locator.blur().catch(() => {});
      await pause(160);
    }
    const actual = await locator.inputValue().catch(() => "");
    throw new Error(`${placeholder}选择失败，期望 ${value}，实际 ${actual || "空"}`);
  }

  const fast = await fastSetInputByPlaceholder(page, placeholder, value);
  if (!fast) {
    await locator.click();
    await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await locator.fill("");
    await locator.type(value, { delay: 0 });
  }

  const confirm = page.getByRole("button", { name: "确 定" }).last();
  if ((await confirm.count()) > 0 && (await confirm.isVisible().catch(() => false))) {
    await confirm.click();
  } else {
    await locator.press("Enter").catch(() => {});
    await locator.blur().catch(() => {});
  }

  if (requirementParts) {
    await expectExactDateTimeValue(locator, requirementParts, 5000);
  } else {
    await expectInputContains(locator, value, 5000);
  }
}

async function setDateTimeRangeByZipLogic(page, startValue, endValue, emit = null) {
  const startParts = parseDateTimeValue(startValue);
  const endParts = parseDateTimeValue(endValue);
  if (!startParts || !endParts) return false;

  const startIso = formatPartsForIsoSeconds(startParts);
  const endIso = formatPartsForIsoSeconds(endParts);
  emit?.(event("log", { level: "success", message: `使用 zip 逻辑同时设置考试时间：${startIso} - ${endIso}` }));

  const ok = await evaluate(
    page,
    ({ startText, endText }) => {
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
    },
    { startText: startIso, endText: endIso },
  );
  await page.keyboard.press("Escape").catch(() => {});
  await pause(400);
  return ok;
}

async function confirmDateTimeInput(page) {
  const clicked = await evaluate(page, () => {
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
  await pause(180);
  await page.keyboard.press("Escape").catch(() => {});
}

async function typeDateTimeAndConfirm(page, locator, parts) {
  const value = formatPartsForLog(parts);
  await locator.click();
  await pause(150);
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await locator.fill("");
  await locator.type(value, { delay: 0 });
  await pause(180);
  await page.keyboard.press("Enter").catch(() => {});
  await pause(220);
  await confirmDateTimeInput(page);
  await pause(250);
  return true;
}

async function closeDateTimePanel(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await pause(120);
  await evaluate(page, () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const panels = [
      ...document.querySelectorAll(".ant-calendar-picker-container, .ant-picker-dropdown"),
    ];
    for (const panel of panels) {
      if (panel instanceof HTMLElement) {
        panel.style.display = "none";
        panel.classList.add("ant-picker-dropdown-hidden", "ant-calendar-picker-container-hidden");
      }
    }
    document.body.click();
  }).catch(() => {});
  await pause(150);
}

async function setDateTimeByZipLogic(page, placeholder, parts) {
  const value = formatPartsForIsoSeconds(parts);
  return evaluate(
    page,
    ({ targetPlaceholder, nextValue }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const placeholderInput = [...document.querySelectorAll("input")]
        .find((el) => visible(el) && (el.getAttribute("placeholder") || "").includes(targetPlaceholder));
      const pickerInput =
        placeholderInput ||
        [...document.querySelectorAll(".ant-picker input, .ant-calendar-picker input")]
          .filter(visible)[targetPlaceholder.includes("开始") ? 0 : 1];
      if (!pickerInput) {
        return false;
      }

      const picker = pickerInput.closest(".ant-picker, .ant-calendar-picker") || pickerInput;
      picker.click();
      pickerInput.focus();

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const previousValue = pickerInput.value;
      pickerInput.removeAttribute("readonly");
      pickerInput.removeAttribute("disabled");
      if (setter) {
        setter.call(pickerInput, nextValue);
      } else {
        pickerInput.value = nextValue;
      }
      if (pickerInput._valueTracker) {
        pickerInput._valueTracker.setValue(previousValue);
      }
      pickerInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      pickerInput.dispatchEvent(new Event("input", { bubbles: true }));
      pickerInput.dispatchEvent(new Event("change", { bubbles: true }));
      pickerInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      pickerInput.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    },
    { targetPlaceholder: placeholder, nextValue: value },
  );
}

function formatPartsForIsoSeconds(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:00`;
}

function dateFromParts(parts) {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

function partsFromDate(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function diffDateTimeMinutes(actualParts, expectedParts) {
  return Math.round((dateFromParts(actualParts).getTime() - dateFromParts(expectedParts).getTime()) / 60000);
}

function addMinutesToParts(parts, minutes) {
  const date = dateFromParts(parts);
  date.setMinutes(date.getMinutes() + minutes);
  return partsFromDate(date);
}

async function isExactDateTimeValue(locator, parsed) {
  const current = await locator.inputValue().catch(() => "");
  const currentParsed = parseDateTimeValue(current);
  return Boolean(
    currentParsed &&
      currentParsed.year === parsed.year &&
      currentParsed.month === parsed.month &&
      currentParsed.day === parsed.day &&
      currentParsed.hour === parsed.hour &&
      currentParsed.minute === parsed.minute,
  );
}

async function forceSetDateTimeInput(page, placeholder, value) {
  await evaluate(
    page,
    ({ targetPlaceholder, nextValue }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const input = [...document.querySelectorAll("input")]
        .find((el) => visible(el) && (el.getAttribute("placeholder") || "").includes(targetPlaceholder));
      if (!input) {
        throw new Error(`未找到时间输入框：${targetPlaceholder}`);
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const previousValue = input.value;
      input.focus();
      input.removeAttribute("readonly");
      input.removeAttribute("disabled");
      if (setter) {
        setter.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      if (input._valueTracker) {
        input._valueTracker.setValue(previousValue);
      }
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    { targetPlaceholder: placeholder, nextValue: value },
  );
  await pause(200);
}

function formatPartsForLog(parts) {
  return `${parts.year}/${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function parseTimezoneOffsetMinutes(timezoneText = "") {
  const text = String(timezoneText || "").trim();
  if (!text) return null;
  if (/^\(?UTC\)?$/i.test(text)) return 0;
  const match = text.match(/UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

async function clearDateTimeInput(page, placeholder) {
  await evaluate(
    page,
    ({ targetPlaceholder }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const input = [...document.querySelectorAll("input")]
        .find((el) => visible(el) && (el.getAttribute("placeholder") || "").includes(targetPlaceholder));
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      input.focus();
      if (setter) {
        setter.call(input, "");
      } else {
        input.value = "";
      }
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    { targetPlaceholder: placeholder },
  );
}

async function selectDateTimeFromPicker(page, parts, emit = null) {
  await page
    .waitForFunction(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll(".ant-calendar-picker-container, .ant-calendar, .ant-picker-dropdown")]
        .some(visible);
    }, null, { timeout: 3000 })
    .catch(() => {});

  const legacySelected = await selectLegacyCalendarDateTime(page, parts, emit);
  if (legacySelected) {
    return true;
  }
  return selectModernPickerDateTime(page, parts);
}

async function selectLegacyCalendarDateTime(page, parts, emit = null) {
  const legacyVisible = await page
    .locator(".ant-calendar-picker-container:visible, .ant-calendar:visible")
    .count()
    .catch(() => 0);
  if (legacyVisible === 0) {
    return false;
  }

  const result = await page.evaluate(async ({ target }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const getContainer = () =>
      [...document.querySelectorAll(".ant-calendar-picker-container, .ant-calendar")]
        .filter(visible)
        .pop();
    const getPickerContainers = () => [...document.querySelectorAll(".ant-calendar-picker-container")].filter(visible);

    const readMonth = (container) => {
      const headerText = norm(
        container.querySelector(".ant-calendar-my-select")?.textContent ||
          container.querySelector(".ant-calendar-header")?.textContent ||
          "",
      );
      const match = headerText.match(/(\d{4})\D+(\d{1,2})/);
      if (!match) return null;
      return { year: Number(match[1]), month: Number(match[2]) };
    };

    const clickButton = (container, selectors) => {
      for (const selector of selectors) {
        const button = container.querySelector(selector);
        if (button && visible(button)) {
          button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          button.click();
          return true;
        }
      }
      return false;
    };

    let container = getContainer();
    if (!container) {
      return false;
    }

    for (let attempt = 0; attempt < 48; attempt += 1) {
      container = getContainer();
      const current = readMonth(container);
      if (!current) break;
      if (current.year === target.year && current.month === target.month) {
        break;
      }
      const before = current.year * 12 + current.month;
      const desired = target.year * 12 + target.month;
      const moved =
        before > desired
          ? clickButton(container, [".ant-calendar-prev-month-btn", ".ant-calendar-prev-year-btn"])
          : clickButton(container, [".ant-calendar-next-month-btn", ".ant-calendar-next-year-btn"]);
      if (!moved) break;
      await sleep(80);
    }

    container = getContainer();
    if (!container) {
      throw new Error("未找到旧版时间选择器弹层");
    }

    const targetDay = String(target.day);
    const dateCell = [...container.querySelectorAll(".ant-calendar-cell")]
      .filter((cell) => {
        if (!visible(cell)) return false;
        if (cell.classList.contains("ant-calendar-disabled-cell")) return false;
        if (cell.classList.contains("ant-calendar-last-month-cell")) return false;
        if (cell.classList.contains("ant-calendar-next-month-cell")) return false;
        const dateNode = cell.querySelector(".ant-calendar-date");
        if (dateNode?.classList.contains("ant-calendar-last-month-cell")) return false;
        if (dateNode?.classList.contains("ant-calendar-next-month-btn-day")) return false;
        return norm(dateNode?.textContent) === targetDay;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        if (ar.top !== br.top) return ar.top - br.top;
        return ar.left - br.left;
      })[0];

    if (!dateCell) {
      throw new Error(`未找到日期：${targetDay}`);
    }
    const dateButton = dateCell.querySelector(".ant-calendar-date") || dateCell;
    dateButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    dateButton.click();
    await sleep(120);

    container = getContainer();
    const columns = [...container.querySelectorAll(".ant-calendar-time-picker-select")].filter(visible);
    if (columns.length >= 2) {
      const pickerContainers = getPickerContainers();
      const previewOptions = (column) =>
        [...column.querySelectorAll("li")]
          .slice(0, 24)
          .map((li) => norm(li.textContent))
          .filter(Boolean)
          .join(",");
      return {
        mode: "timeColumns",
        containerIndex: Math.max(0, pickerContainers.length - 1),
        dateText: `${target.year}/${String(target.month).padStart(2, "0")}/${String(target.day).padStart(2, "0")}`,
        hourOptions: previewOptions(columns[0]),
        minuteOptions: previewOptions(columns[1]),
      };
    }

    container = getContainer();
    const okButton = container.querySelector(".ant-calendar-ok-btn");
    if (!okButton || !visible(okButton)) {
      throw new Error("未找到时间选择器确定按钮");
    }

    return { mode: "noTimeColumns" };
  }, { target: parts });

  if (result?.mode === "timeColumns") {
    emit?.(event("log", { level: "success", message: `时间弹层识别：日期 ${result.dateText}；小时候选 ${result.hourOptions}；分钟候选 ${result.minuteOptions}` }));
    const hourSelected = await clickLegacyTimeColumnItem(page, result.containerIndex, 0, parts.hour);
    emit?.(event("log", { level: "success", message: `小时列精确选中：${hourSelected}` }));
    const minuteSelected = await clickLegacyTimeColumnItem(page, result.containerIndex, 1, parts.minute);
    emit?.(event("log", { level: "success", message: `分钟列精确选中：${minuteSelected}` }));
  }

  emit?.(event("log", { level: "success", message: "时间弹层选择完成，准备点击确定。" }));

  await page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const container = [...document.querySelectorAll(".ant-calendar-picker-container")]
      .filter(visible)
      .pop();
    const okButton = container?.querySelector(".ant-calendar-ok-btn");
    if (!okButton) {
      throw new Error("未找到时间选择器确定按钮");
    }
    okButton.classList.remove("ant-calendar-ok-btn-disabled");
    okButton.removeAttribute("disabled");
    okButton.click();
  });
  await pause(160);
  return true;
}

async function clickLegacyTimeColumnItem(page, containerIndex, columnIndex, value) {
  const padded = String(value).padStart(2, "0");
  const selected = await page.evaluate(
    async ({ targetText, targetContainerIndex, targetColumnIndex }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const containers = [...document.querySelectorAll(".ant-calendar-picker-container")]
        .filter(visible);
      const container = containers[targetContainerIndex] || containers.at(-1);
      if (!container) {
        throw new Error("未找到当前时间弹层");
      }
      const columns = [...container.querySelectorAll(".ant-calendar-time-picker-select")].filter(visible);
      const column = columns[targetColumnIndex];
      if (!column) {
        throw new Error(`未找到时间列：${targetColumnIndex + 1}`);
      }
      const item = [...column.querySelectorAll("li")].find((li) => norm(li.textContent) === targetText);
      if (!item) {
        throw new Error(`未找到时间项：${targetText}`);
      }
      column.scrollTop = Math.max(0, item.offsetTop - column.clientHeight / 2);
      await sleep(80);
      const clickable = item.querySelector("a, span, div") || item;
      const rect = clickable.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      clickable.dispatchEvent(new MouseEvent("mousedown", init));
      clickable.dispatchEvent(new MouseEvent("mouseup", init));
      clickable.dispatchEvent(new MouseEvent("click", init));
      clickable.click();
      await sleep(80);
      const selectedItem = [...column.querySelectorAll(".ant-calendar-time-picker-select-option-selected, li")]
        .find((li) => li.classList.contains("ant-calendar-time-picker-select-option-selected"));
      return norm(selectedItem?.textContent || item.textContent);
    },
    { targetText: padded, targetContainerIndex: containerIndex, targetColumnIndex: columnIndex },
  );
  if (String(selected || "").replace(/\s+/g, " ").trim() !== padded) {
    throw new Error(`时间列 ${columnIndex + 1} 选中错误，期望 ${padded}，实际 ${selected || "空"}`);
  }
  return padded;
}

async function selectModernPickerDateTime(page, parts) {
  const dropdown = page.locator(".ant-picker-dropdown").last();
  await dropdown.waitFor({ state: "visible", timeout: 5000 });

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const header = await dropdown.locator(".ant-picker-header-view").first().innerText().catch(() => "");
    const monthMatch = header.match(/(\d{4})\D+(\d{1,2})\D*/);
    if (monthMatch) {
      const currentYear = Number(monthMatch[1]);
      const currentMonth = Number(monthMatch[2]);
      if (currentYear === parts.year && currentMonth === parts.month) {
        break;
      }
      if (currentYear > parts.year || (currentYear === parts.year && currentMonth > parts.month)) {
        await dropdown.locator(".ant-picker-header-prev-btn").first().click();
      } else {
        await dropdown.locator(".ant-picker-header-next-btn").first().click();
      }
      await pause(120);
      continue;
    }
    break;
  }

  await page.evaluate(
    ({ day }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const dropdown = [...document.querySelectorAll(".ant-picker-dropdown")]
        .filter((el) => visible(el))
        .pop();
      if (!dropdown) {
        throw new Error("未找到时间选择器弹层");
      }

      const dateCell = [...dropdown.querySelectorAll(".ant-picker-cell")]
        .find((cell) =>
          cell.classList.contains("ant-picker-cell-in-view") &&
          !cell.classList.contains("ant-picker-cell-disabled") &&
          (cell.querySelector(".ant-picker-cell-inner")?.textContent || "").trim() === String(day),
        );
      if (!dateCell) {
        throw new Error(`未找到日期：${day}`);
      }
      dateCell.click();
    },
    { day: parts.day },
  );

  await pause(120);

  await page.evaluate(
    ({ hour, minute }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const dropdown = [...document.querySelectorAll(".ant-picker-dropdown")]
        .filter((el) => visible(el))
        .pop();
      if (!dropdown) {
        throw new Error("未找到时间选择器弹层");
      }

      const pickFromColumn = (columnIndex, value) => {
        const columns = [...dropdown.querySelectorAll(".ant-picker-time-panel-column")].filter(visible);
        const column = columns[columnIndex];
        if (!column) {
          throw new Error(`未找到时间列：${columnIndex}`);
        }
        const text = String(value).padStart(2, "0");
        const item = [...column.querySelectorAll(".ant-picker-time-panel-cell-inner")]
          .find((el) => (el.textContent || "").trim() === text);
        if (!item) {
          throw new Error(`未找到时间项：${text}`);
        }
        column.scrollTop = Math.max(0, item.offsetTop - column.clientHeight / 2);
        item.click();
      };

      pickFromColumn(0, hour);
      pickFromColumn(1, minute);
    },
    { hour: parts.hour, minute: parts.minute },
  );
  await pause(120);

  return page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const dropdown = [...document.querySelectorAll(".ant-picker-dropdown")]
      .filter((el) => visible(el))
      .pop();
    const button = dropdown?.querySelector(".ant-picker-ok button");
    if (!button || button.disabled) {
      return false;
    }
    button.click();
    return true;
  });
}

async function expectInputContains(locator, value, timeout = 2_000) {
  const expectedDateTime = parseDateTimeValue(value);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await locator.inputValue().catch(() => "");
    const currentDateTime = expectedDateTime ? parseDateTimeValue(current) : null;
    if (
      expectedDateTime &&
      currentDateTime &&
      currentDateTime.year === expectedDateTime.year &&
      currentDateTime.month === expectedDateTime.month &&
      currentDateTime.day === expectedDateTime.day &&
      currentDateTime.hour === expectedDateTime.hour &&
      currentDateTime.minute === expectedDateTime.minute
    ) {
      return;
    }
    if (current.includes(value)) {
      return;
    }
    await delay(200);
  }
  throw new Error(`输入值未生效：${value}`);
}

async function expectExactInputValue(locator, value, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await locator.inputValue().catch(() => "");
    if ((current || "").trim() === String(value).trim()) {
      return;
    }
    await delay(200);
  }
  throw new Error(`输入值未精确生效：${value}`);
}

async function expectExactTextareaValue(locator, value, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await locator.inputValue().catch(() => "");
    if ((current || "").trim() === String(value).trim()) {
      return;
    }
    await delay(200);
  }
  throw new Error(`文本框值未精确生效：${value}`);
}

async function expectExactDateTimeValue(locator, parsed, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await locator.inputValue().catch(() => "");
    const currentParsed = parseDateTimeValue(current);
    if (
      currentParsed &&
      currentParsed.year === parsed.year &&
      currentParsed.month === parsed.month &&
      currentParsed.day === parsed.day &&
      currentParsed.hour === parsed.hour &&
      currentParsed.minute === parsed.minute
    ) {
      return;
    }
    await delay(200);
  }
  throw new Error(
    `时间值未精确生效：${parsed.year}/${String(parsed.month).padStart(2, "0")}/${String(parsed.day).padStart(2, "0")} ${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`,
  );
}

async function expectBasicInfoReadyToSubmit(page, config, emit) {
  const checks = [];
  const examName = await readBasicInfoField(page, "考试名称");
  checks.push(["考试名称", config.examName, examName]);

  const startTime = await readBasicInfoField(page, "开始时间");
  checks.push(["开始时间", config.startTimeDisplay, normalizeDateTimeDisplay(startTime)]);

  const endTime = await readBasicInfoField(page, "结束时间");
  checks.push(["结束时间", config.endTimeDisplay, normalizeDateTimeDisplay(endTime)]);

  if (config.earlyLoginMinutes != null) {
    const earlyLogin = await readMinuteValueByLabel(page, "提前登录");
    checks.push(["提前登录", String(config.earlyLoginMinutes), earlyLogin]);
  }
  if (config.lateLimitMinutes != null) {
    const lateLimit = await readMinuteValueByLabel(page, "限制迟到");
    checks.push(["限制迟到", String(config.lateLimitMinutes), lateLimit]);
  }

  for (const [label, expected, actual] of checks) {
    emit?.(event("log", { level: actual === expected ? "success" : "warn", message: `提交前校验 ${label}：期望 ${expected || "空"}，实际 ${actual || "空"}` }));
    if (actual !== expected) {
      throw new Error(`基础信息提交前校验失败：${label} 期望 ${expected || "空"}，实际 ${actual || "空"}`);
    }
  }
}

function normalizeDateTimeDisplay(value) {
  const parsed = parseDateTimeValue(value);
  return parsed ? formatPartsForLog(parsed) : String(value || "").trim();
}

async function readMinuteNumberValue(page, index) {
  const input = page.locator("input[type='number']").nth(index);
  return (await input.inputValue().catch(() => "")).trim();
}

async function fastSetInputByPlaceholder(page, placeholder, value) {
  return evaluate(
    page,
    ({ targetPlaceholder, nextValue }) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const input = [...document.querySelectorAll("input, textarea")]
        .find((el) => visible(el) && (el.getAttribute("placeholder") || "").includes(targetPlaceholder));
      if (!input) return false;

      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      input.focus();
      input.click();
      input.removeAttribute("readonly");
      input.removeAttribute("disabled");
      if (setter) {
        setter.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return input.value.length > 0;
    },
    { targetPlaceholder: placeholder, nextValue: value },
  );
}

async function enableMinuteOption(page, label, value, emit = null) {
  const result = await evaluate(
    page,
    ({ targetLabel }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const findTextNode = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (norm(node.textContent).includes(targetLabel) && visible(node.parentElement)) return node;
        }
        return null;
      };
      const findContainer = (textNode) => {
        let container = textNode?.parentElement || null;
        for (let i = 0; container && i < 8; i += 1) {
          const checkbox = container.querySelector("input[type='checkbox']");
          const visibleInputs = [...container.querySelectorAll("input")]
            .filter((input) => {
              const type = (input.getAttribute("type") || "").toLowerCase();
              return visible(input) && !["checkbox", "hidden", "password"].includes(type);
            });
          if (checkbox && visibleInputs.length > 0) {
            return { container, checkbox, visibleInputs };
          }
          container = container.parentElement;
        }
        return null;
      };

      const textNode = findTextNode();
      const found = findContainer(textNode);
      if (!found) {
        throw new Error(`未找到${targetLabel}复选框或分钟输入框`);
      }

      const wrapper = found.checkbox.closest(".ant-checkbox-wrapper") || found.checkbox.closest("label") || found.checkbox;
      if (!found.checkbox.checked) {
        wrapper.click();
      }
      return {
        label: targetLabel,
        checked: found.checkbox.checked,
      };
    },
    { targetLabel: label },
  );
  await pause(250);

  const spinIndex = label.includes("提前登录") ? 0 : label.includes("限制迟到") ? 1 : -1;
  if (spinIndex < 0) {
    throw new Error(`未知分钟字段：${label}`);
  }
  const spinbutton = page.getByRole("spinbutton").nth(spinIndex);
  await spinbutton.waitFor({ state: "visible", timeout: 5000 });
  await spinbutton.click();
  await spinbutton.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await spinbutton.fill(String(value));
  await pause(120);
  const actual = (await spinbutton.inputValue().catch(() => "")).trim();

  emit?.(event("log", { level: "success", message: `${label}写入结果：checked=${Boolean(result?.checked)}，value=${actual || "空"}，spinbutton=${spinIndex}` }));
  if (!result?.checked || actual !== String(value)) {
    throw new Error(`${label}配置失败，期望勾选且分钟为 ${value}，实际 checked=${Boolean(result?.checked)} value=${actual || "空"} spinbutton=${spinIndex}`);
  }
}

async function getMinuteRowControls(page, label) {
  return evaluate(
    page,
    ({ targetLabel }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      const findLabelRect = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const rects = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!norm(node.nodeValue).includes(targetLabel)) continue;
          const parent = node.parentElement;
          if (!visible(parent)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          range.detach();
          if (rect.width > 0 && rect.height > 0) rects.push(rect);
        }
        const elementRects = [...document.querySelectorAll("span, label, div, p")]
          .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel))
          .map((el) => el.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .sort((a, b) => a.width * a.height - b.width * b.height);
        return [...rects, ...elementRects].sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top))[0] || null;
      };
      const labelRect = findLabelRect();
      const optionIndex = targetLabel.includes("提前登录") ? 0 : targetLabel.includes("限制迟到") ? 1 : -1;
      const checkboxSquares = [...document.querySelectorAll(".ant-checkbox-inner, input[type='checkbox']")]
        .filter((el) => {
          if (!visible(el)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width >= 10 && rect.height >= 10 && rect.width <= 40 && rect.height <= 40;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (Math.abs(ar.top - br.top) > 2) return ar.top - br.top;
          return ar.left - br.left;
        });
      const pageTop = [...document.querySelectorAll("input")]
        .filter((el) => visible(el) && (el.placeholder || "").includes("开始时间"))
        .map((el) => el.getBoundingClientRect().bottom)
        .sort((a, b) => b - a)[0] || 0;
      const basicOptionSquares = checkboxSquares.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top > pageTop && rect.left < 260;
      });
      const labelCenterY = labelRect
        ? labelRect.top + labelRect.height / 2
        : basicOptionSquares[optionIndex]?.getBoundingClientRect().top + basicOptionSquares[optionIndex]?.getBoundingClientRect().height / 2;
      const visualFallback = () => {
        const timeBottom = [...document.querySelectorAll("input")]
          .filter((el) => visible(el) && ((el.placeholder || "").includes("开始时间") || (el.placeholder || "").includes("结束时间")))
          .map((el) => el.getBoundingClientRect().bottom)
          .sort((a, b) => b - a)[0] || 0;
        const timeLeft = [...document.querySelectorAll("input")]
          .filter((el) => visible(el) && ((el.placeholder || "").includes("开始时间") || (el.placeholder || "").includes("结束时间")))
          .map((el) => el.getBoundingClientRect().left)
          .sort((a, b) => a - b)[0] || 80;
        const textareaTop = [...document.querySelectorAll("textarea")]
          .filter((el) => visible(el))
          .map((el) => el.getBoundingClientRect().top)
          .sort((a, b) => a - b)[0] || Number.POSITIVE_INFINITY;
        const minuteInputs = [...document.querySelectorAll("input")]
          .filter((candidate) => {
            if (!visible(candidate)) return false;
            const rect = candidate.getBoundingClientRect();
            const type = (candidate.getAttribute("type") || "").toLowerCase();
            return (
              !["checkbox", "hidden", "password"].includes(type) &&
              rect.top > timeBottom + 10 &&
              rect.top < textareaTop &&
              rect.width > 50 &&
              rect.width < 260 &&
              rect.height > 20
            );
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            if (Math.abs(ar.top - br.top) > 3) return ar.top - br.top;
            return ar.left - br.left;
          });
        const input = minuteInputs[optionIndex];
        const inputRect = input?.getBoundingClientRect?.();
        if (!inputRect) {
          const rowY = timeBottom + 86 + optionIndex * 86;
          return {
            checked: false,
            checkbox: { x: timeLeft + 20, y: rowY },
            input: { x: timeLeft + 360, y: rowY },
            method: "visual-fixed",
          };
        }
        const rowY = inputRect.top + inputRect.height / 2;
        const checkboxX = Math.max(20, inputRect.left - 285);
        const checked = [...document.querySelectorAll(".ant-checkbox-checked, input[type='checkbox']:checked")]
          .some((el) => {
            if (!visible(el)) return false;
            const rect = el.getBoundingClientRect();
            return Math.abs(rect.top + rect.height / 2 - rowY) < 30 && rect.left < inputRect.left;
          });
        return {
          checked,
          checkbox: { x: checkboxX, y: rowY },
          input: center(inputRect),
          method: "visual",
        };
      };
      if (!labelCenterY) return visualFallback();
      const rowMatch = (rect, tolerance = 28) => Math.abs(rect.top + rect.height / 2 - labelCenterY) < tolerance;

      const checkboxCandidates = [...document.querySelectorAll(".ant-checkbox-inner, input[type='checkbox'], .ant-checkbox, .ant-checkbox-wrapper, label")]
        .filter((el) => {
          if (!visible(el)) return false;
          const rect = el.getBoundingClientRect();
          return rowMatch(rect) && rect.left < 260 && rect.width >= 10 && rect.height >= 10 && rect.width < 90 && rect.height < 90;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.left - br.left;
        });
      const checkboxEl = checkboxCandidates[0];
      const checkboxInput = checkboxEl?.matches?.("input[type='checkbox']")
        ? checkboxEl
        : checkboxEl?.querySelector?.("input[type='checkbox']");
      const checkboxRect = (checkboxInput && visible(checkboxInput) ? checkboxInput : checkboxEl)?.getBoundingClientRect?.();

      const inputEl = [...document.querySelectorAll("input")]
        .filter((candidate) => {
          if (!visible(candidate)) return false;
          const rect = candidate.getBoundingClientRect();
          const type = (candidate.getAttribute("type") || "").toLowerCase();
          return (
            rowMatch(rect, 24) &&
            !["checkbox", "hidden", "password"].includes(type) &&
            rect.left > 250 &&
            rect.width > 20
          );
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      const inputRect = inputEl?.getBoundingClientRect?.();

      const checkedRoot = checkboxEl?.closest?.(".ant-checkbox-wrapper, .ant-checkbox");
      const checked = Boolean(
        checkboxInput?.checked ||
          checkboxEl?.classList?.contains("ant-checkbox-checked") ||
          checkboxEl?.querySelector?.(".ant-checkbox-checked") ||
          checkedRoot?.classList?.contains("ant-checkbox-checked") ||
          checkedRoot?.querySelector?.(".ant-checkbox-checked"),
      );
      const structuralResult = {
        checked,
        checkbox: checkboxRect ? center(checkboxRect) : null,
        input: inputRect ? center(inputRect) : null,
      };
      if (!structuralResult.checkbox || !structuralResult.input) {
        return visualFallback();
      }
      return structuralResult;
    },
    { targetLabel: label },
  );
}

async function clickMinuteCheckbox(page, label) {
  return evaluate(
    page,
    ({ targetLabel }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const findLabelRect = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const rects = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!norm(node.nodeValue).includes(`${targetLabel}：`)) continue;
          const parent = node.parentElement;
          if (!visible(parent)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          range.detach();
          if (rect.width > 0 && rect.height > 0) rects.push(rect);
        }
        return rects.sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top))[0] || null;
      };
      const labelRect = findLabelRect();
      if (!labelRect) return { clicked: false, reason: "label not found" };
      const labelCenterY = labelRect.top + labelRect.height / 2;
      const candidates = [...document.querySelectorAll("input[type='checkbox'], .ant-checkbox, .ant-checkbox-wrapper, span, label")]
        .filter((el) => {
          if (!visible(el)) return false;
          const rect = el.getBoundingClientRect();
          const centerY = rect.top + rect.height / 2;
          return (
            Math.abs(centerY - labelCenterY) < 28 &&
            rect.left < labelRect.left &&
            rect.width > 8 &&
            rect.height > 8 &&
            rect.width < 80 &&
            rect.height < 80
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return Math.abs(ar.right - labelRect.left) - Math.abs(br.right - labelRect.left);
        });
      const target = candidates[0];
      if (!target) return { clicked: false, reason: "checkbox not found" };
      const checkbox = target.matches("input[type='checkbox']")
        ? target
        : target.querySelector?.("input[type='checkbox']");
      if (checkbox instanceof HTMLInputElement && checkbox.checked) {
        return { clicked: true, alreadyChecked: true };
      }
      target.click();
      return { clicked: true };
    },
    { targetLabel: label },
  );
}

async function getMinuteCheckboxClickPoint(page, label) {
  return evaluate(
    page,
    ({ targetLabel }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const rects = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!norm(node.nodeValue).includes(`${targetLabel}：`)) continue;
        const parent = node.parentElement;
        if (!visible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        range.detach();
        if (rect.width > 0 && rect.height > 0) rects.push(rect);
      }
      const rect = rects.sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top))[0];
      if (!rect) return null;
      return {
        x: Math.max(10, rect.left - 58),
        y: rect.top + rect.height / 2,
      };
    },
    { targetLabel: label },
  );
}

async function readMinuteValueByLabel(page, label) {
  const spinIndex = label.includes("提前登录") ? 0 : label.includes("限制迟到") ? 1 : -1;
  if (spinIndex < 0) return "";
  return (await page.getByRole("spinbutton").nth(spinIndex).inputValue().catch(() => "")).trim();
}

async function toggleMinuteCheckboxByLabel(page, label) {
  await evaluate(
    page,
    ({ targetLabel }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const labelEl = [...document.querySelectorAll("span, div, label, p")]
        .filter((el) => visible(el) && norm(el.textContent).includes(`${targetLabel}：`))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (ar.top !== br.top) return ar.top - br.top;
          return ar.left - br.left;
        })[0];
      if (!labelEl) {
        throw new Error(`未找到${targetLabel}标签`);
      }
      const lr = labelEl.getBoundingClientRect();
      const checkbox = [...document.querySelectorAll("input[type='checkbox']")]
        .filter((input) => {
          const rect = input.getBoundingClientRect();
          return Math.abs(rect.top - lr.top) < 35 && rect.left < lr.left;
        })
        .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      if (!checkbox) {
        throw new Error(`未找到${targetLabel}复选框`);
      }
      if (!checkbox.checked) {
        const clickable = checkbox.closest("label") || checkbox.parentElement || checkbox;
        clickable.click();
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { targetLabel: label },
  );
}

async function fillTextboxLike(page, value, index = 0) {
  const locator = page.locator("textarea, [contenteditable='true']").nth(index);
  await locator.click();
  await locator.fill(value);
}

async function setStepValue(page, index, value) {
  const stepper = page.getByRole("spinbutton").nth(index);
  await stepper.click();
  await stepper.fill(String(value));
}

async function evaluate(page, fn, arg) {
  return page.evaluate(fn, arg);
}

async function setCheckboxRowState(page, label, checkboxIndex, desired) {
  await evaluate(
    page,
    ({ label: targetLabel, checkboxIndex: targetIndex, desiredState }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const candidates = [...document.querySelectorAll("div, li, tr, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);

      const row = candidates.find((el) => el.querySelectorAll("input[type='checkbox']").length > targetIndex);
      if (!row) {
        throw new Error(`未找到字段行：${targetLabel}`);
      }

      const checkbox = row.querySelectorAll("input[type='checkbox']")[targetIndex];
      if (!checkbox) {
        throw new Error(`未找到复选框：${targetLabel} #${targetIndex}`);
      }

      if (checkbox.checked !== desiredState) {
        checkbox.click();
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { label, checkboxIndex, desiredState: desired },
  );
}

async function configurePersonalInfoVisibility(page, visibleFields) {
  const rowNames = ["姓名", "邮箱", "手机号码", "性别", "身份证号"];
  await waitForPersonalInfoCheckboxes(page);
  return evaluate(
    page,
    ({ names, visibleNames }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const clickVisibleCheckbox = (checkbox) => {
        const target =
          checkbox.closest("label.ant-checkbox-wrapper") ||
          checkbox.closest(".ant-checkbox-wrapper") ||
          checkbox.closest(".ant-checkbox")?.querySelector(".ant-checkbox-inner") ||
          checkbox.nextElementSibling ||
          checkbox.parentElement ||
          checkbox;
        const rect = target.getBoundingClientRect?.();
        target.scrollIntoView?.({ block: "center", inline: "center" });
        for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: rect ? rect.left + rect.width / 2 : 0,
              clientY: rect ? rect.top + rect.height / 2 : 0,
            }),
          );
        }
      };

      const setNativeChecked = (checkbox, state) => {
        const descriptor =
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(checkbox), "checked") ||
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        if (descriptor?.set) descriptor.set.call(checkbox, state);
        else checkbox.checked = state;
        checkbox.dispatchEvent(new Event("input", { bubbles: true }));
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const isChecked = (checkbox) => {
        if (!checkbox) return null;
        const antCheckbox = checkbox.closest(".ant-checkbox");
        const wrapper = checkbox.closest(".ant-checkbox-wrapper");
        if (antCheckbox) return antCheckbox.classList.contains("ant-checkbox-checked");
        if (wrapper) return wrapper.classList.contains("ant-checkbox-wrapper-checked");
        return checkbox.checked;
      };

      const rows = [...document.querySelectorAll("div, li, tr")]
        .filter((el) => visible(el) && names.some((name) => norm(el.textContent).includes(name)))
        .map((el) => ({
          el,
          text: norm(el.textContent),
          checkboxCount: el.querySelectorAll("input[type='checkbox']").length,
          childCount: el.querySelectorAll("*").length,
        }))
        .filter((row) => row.checkboxCount >= 3)
        .sort((a, b) => {
          const ar = a.el.getBoundingClientRect();
          const br = b.el.getBoundingClientRect();
          if (Math.abs(ar.top - br.top) > 2) return ar.top - br.top;
          return a.childCount - b.childCount;
        });

      const byName = new Map();
      for (const name of names) {
        const matched = rows
          .filter((row) => row.text.includes(name))
          .sort((a, b) => a.childCount - b.childCount)[0];
        if (!matched) {
          throw new Error(`个人信息页未找到字段行：${name}`);
        }
        byName.set(name, matched.el);
      }

      for (const name of names) {
        const desiredStates = [false, visibleNames.includes(name), false];
        const checkboxes = [...byName.get(name).querySelectorAll("input[type='checkbox']")]
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
          .slice(0, 3);
        if (checkboxes.length < 3) {
          throw new Error(`个人信息页字段 ${name} 复选框数量不足，实际 ${checkboxes.length}`);
        }
        desiredStates.forEach((state, index) => {
          const checkbox = checkboxes[index];
          if (isChecked(checkbox) !== state) clickVisibleCheckbox(checkbox);
          if (isChecked(checkbox) !== state) setNativeChecked(checkbox, state);
        });
      }

      return names.map((name) => {
        const desiredStates = [false, visibleNames.includes(name), false];
        const checkboxes = [...byName.get(name).querySelectorAll("input[type='checkbox']")]
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
          .slice(0, 3);
        return {
          name,
          ok:
            isChecked(checkboxes[0]) === desiredStates[0] &&
            isChecked(checkboxes[1]) === desiredStates[1] &&
            isChecked(checkboxes[2]) === desiredStates[2],
          allowEdit: checkboxes[0] ? isChecked(checkboxes[0]) : null,
          candidateVisible: checkboxes[1] ? isChecked(checkboxes[1]) : null,
          required: checkboxes[2] ? isChecked(checkboxes[2]) : null,
        };
      });
    },
    { names: rowNames, visibleNames: [...visibleFields] },
  );
}

async function waitForPersonalInfoCheckboxes(page, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await evaluate(page, () => document.querySelectorAll("input[type='checkbox']").length).catch(() => 0);
    if (count >= 15) return count;
    await pause(250);
  }
  const finalCount = await evaluate(page, () => document.querySelectorAll("input[type='checkbox']").length).catch(() => 0);
  throw new Error(`个人信息页复选框数量不足，期望至少 15，实际 ${finalCount}`);
}

async function setMasterCheckboxByLabel(page, label, desired) {
  await evaluate(
    page,
    ({ label: targetLabel, desiredState }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const candidates = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);

      const row = candidates.find((el) => el.querySelector("input[type='checkbox']"));
      if (!row) {
        throw new Error(`未找到配置行：${targetLabel}`);
      }

      const checkbox = row.querySelector("input[type='checkbox']");
      if (!checkbox) {
        throw new Error(`未找到配置行复选框：${targetLabel}`);
      }

      if (checkbox.checked !== desiredState) {
        checkbox.click();
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { label, desiredState: desired },
  );
}

async function clickTextInRow(page, rowLabel, actionText) {
  await evaluate(
    page,
    ({ rowLabel: targetRowLabel, actionText: targetActionText }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const candidates = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetRowLabel))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      const row = candidates[0];
      if (!row) {
        throw new Error(`未找到配置行：${targetRowLabel}`);
      }

      const clickable = [...row.querySelectorAll("label, span, div, button")]
        .find((el) => visible(el) && norm(el.textContent).includes(targetActionText));
      if (!clickable) {
        throw new Error(`未找到行内动作：${targetRowLabel} / ${targetActionText}`);
      }
      clickable.click();
    },
    { rowLabel, actionText },
  );
}

async function setCheckboxNearText(page, text, desired = true) {
  await evaluate(
    page,
    ({ targetText, desiredState }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const isChecked = (input) => {
        const antCheckbox = input.closest(".ant-checkbox");
        const antRadio = input.closest(".ant-radio");
        if (antCheckbox) return antCheckbox.classList.contains("ant-checkbox-checked");
        if (antRadio) return antRadio.classList.contains("ant-radio-checked");
        return input.checked;
      };
      const clickInput = (input) => {
        const target =
          input.closest("label") ||
          input.closest(".ant-checkbox-wrapper") ||
          input.closest(".ant-radio-wrapper") ||
          input.closest(".ant-checkbox")?.querySelector(".ant-checkbox-inner") ||
          input.closest(".ant-radio")?.querySelector(".ant-radio-inner") ||
          input;
        target.scrollIntoView?.({ block: "center", inline: "center" });
        target.click();
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const containers = [...document.querySelectorAll("label, div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetText))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      const container = containers.find((el) => el.querySelector("input[type='checkbox'], input[type='radio']"));
      const input = container?.querySelector("input[type='checkbox'], input[type='radio']");
      if (!input) {
        throw new Error(`未找到选项：${targetText}`);
      }
      if (isChecked(input) !== desiredState) {
        clickInput(input);
      }
    },
    { targetText: text, desiredState: desired },
  );
}

async function getVisibleTextRect(page, text) {
  return evaluate(page, (targetText) => {
    const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!norm(node.textContent).includes(targetText) || !visible(node.parentElement)) continue;
      const range = document.createRange();
      const start = String(node.textContent || "").indexOf(targetText);
      if (start >= 0) {
        range.setStart(node, start);
        range.setEnd(node, start + targetText.length);
      } else {
        range.selectNodeContents(node);
      }
      const rect = range.getBoundingClientRect();
      range.detach();
      if (rect.width > 0 && rect.height > 0) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
    }
    const element = [...document.querySelectorAll("label, span, div, li")]
      .filter((el) => visible(el) && norm(el.textContent).includes(targetText))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : null;
  }, text);
}

async function clickControlLeftOfTextByMouse(page, text, type) {
  const rect = await getVisibleTextRect(page, text);
  if (!rect) return false;
  const centerY = rect.top + rect.height / 2;
  const offsets = type === "radio" ? [-24, -34, -46, -60] : [-26, -38, -52, -68];
  for (const offset of offsets) {
    const x = Math.max(4, rect.left + offset);
    await page.mouse.move(x, centerY);
    await page.mouse.down();
    await page.mouse.up();
    await pause(120);
    if (await isAntOptionCheckedNearText(page, text, type)) return true;
  }
  return false;
}

async function isAntOptionCheckedNearText(page, text, type) {
  return evaluate(
    page,
    ({ targetText, optionType }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const selector = optionType === "radio" ? ".ant-radio" : ".ant-checkbox";
      const wrapperSelector = optionType === "radio" ? ".ant-radio-wrapper" : ".ant-checkbox-wrapper";
      const wrapper = [...document.querySelectorAll(`${wrapperSelector}, label`)]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetText) && el.querySelector(selector))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        })[0];
      if (wrapper) {
        const el = wrapper.querySelector(selector);
        return optionType === "radio" ? el?.classList.contains("ant-radio-checked") : el?.classList.contains("ant-checkbox-checked");
      }
      const textRect = (() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!norm(node.textContent).includes(targetText) || !visible(node.parentElement)) continue;
          const range = document.createRange();
          const start = String(node.textContent || "").indexOf(targetText);
          if (start >= 0) {
            range.setStart(node, start);
            range.setEnd(node, start + targetText.length);
          } else {
            range.selectNodeContents(node);
          }
          const rect = range.getBoundingClientRect();
          range.detach();
          if (rect.width > 0 && rect.height > 0) return rect;
        }
        return null;
      })();
      if (!textRect) return false;
      const cy = textRect.top + textRect.height / 2;
      const control = [...document.querySelectorAll(selector)]
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, score: Math.abs(rect.top + rect.height / 2 - cy) * 30 + Math.abs(rect.left - textRect.left) };
        })
        .filter((item) => item.score < 1600)
        .sort((a, b) => a.score - b.score)[0]?.el;
      return optionType === "radio" ? control?.classList.contains("ant-radio-checked") : control?.classList.contains("ant-checkbox-checked");
    },
    { targetText: text, optionType: type },
  );
}

async function ensureOptionCheckedByMouse(page, text, type) {
  if (await isAntOptionCheckedNearText(page, text, type)) return true;
  try {
    const exactText = page.getByText(text, { exact: true }).last();
    if ((await exactText.count()) > 0) {
      await exactText.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await exactText.click({ force: true, timeout: 1500 }).catch(() => {});
      await pause(200);
      if (await isAntOptionCheckedNearText(page, text, type)) return true;
    }
  } catch {}
  await clickControlLeftOfTextByMouse(page, text, type);
  await pause(250);
  return isAntOptionCheckedNearText(page, text, type);
}

async function configureVideoMonitorDefaults(page) {
  await page.waitForFunction(() => document.body.innerText.includes("登录验证"), { timeout: 8_000 });
  await pause(300);
  await evaluate(page, () => {
    const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controlRoot = (el, type) => {
      if (!el) return null;
      if (type === "radio") return el.closest(".ant-radio-wrapper") || el.closest(".ant-radio") || el.closest("label") || el;
      return el.closest(".ant-checkbox-wrapper") || el.closest(".ant-checkbox") || el.closest("label") || el;
    };
    const isChecked = (el, type) => {
      const root = controlRoot(el, type);
      const antCheckbox = root?.querySelector?.(".ant-checkbox") || root?.closest?.(".ant-checkbox");
      const antRadio = root?.querySelector?.(".ant-radio") || root?.closest?.(".ant-radio");
      const input = root?.querySelector?.(`input[type='${type}']`) || (el?.matches?.(`input[type='${type}']`) ? el : null);
      if (type === "checkbox" && antCheckbox) return antCheckbox.classList.contains("ant-checkbox-checked");
      if (type === "radio" && antRadio) return antRadio.classList.contains("ant-radio-checked");
      return Boolean(input?.checked);
    };
    const clickControl = (el, type) => {
      const root = controlRoot(el, type);
      const target =
        root?.querySelector?.(type === "radio" ? ".ant-radio-inner" : ".ant-checkbox-inner") ||
        root?.querySelector?.(`input[type='${type}']`) ||
        root ||
        el;
      target.scrollIntoView?.({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect?.();
      for (const eventType of ["mouseover", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(
          new MouseEvent(eventType, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect ? rect.left + rect.width / 2 : 0,
            clientY: rect ? rect.top + rect.height / 2 : 0,
          }),
        );
      }
      const input = root?.querySelector?.("input");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const videoArea = [...document.querySelectorAll("div, li, section, form")]
      .filter(
        (el) =>
          visible(el) &&
          norm(el.textContent).includes("视频监控") &&
          norm(el.textContent).includes("登录验证") &&
          norm(el.textContent).includes("作弊侦测"),
      )
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const aArea = ar.width * ar.height;
        const bArea = br.width * br.height;
        return aArea - bArea;
      })[0];
    if (!videoArea) throw new Error("未找到视频监控展开配置区域");

    const textRectIn = (scope, text) => {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!norm(node.textContent).includes(text) || !visible(node.parentElement)) continue;
        const range = document.createRange();
        const start = String(node.textContent || "").indexOf(text);
        if (start >= 0) {
          range.setStart(node, start);
          range.setEnd(node, start + text.length);
        } else {
          range.selectNodeContents(node);
        }
        const rect = range.getBoundingClientRect();
        range.detach();
        if (rect.width > 0 && rect.height > 0) return rect;
      }
      const element = [...scope.querySelectorAll("label, span, div, li")]
        .filter((el) => visible(el) && norm(el.textContent).includes(text))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        })[0];
      if (element) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect;
      }
      return null;
    };
    const textRect = (text) => textRectIn(videoArea, text) || textRectIn(document.body, text);
    const findControlInTextContainer = (text, type) => {
      const selector =
        type === "radio"
          ? ".ant-radio-wrapper, .ant-radio, input[type='radio']"
          : ".ant-checkbox-wrapper, .ant-checkbox, input[type='checkbox']";
      const containers = [...videoArea.querySelectorAll("label, .ant-radio-wrapper, .ant-checkbox-wrapper, div, li"), ...document.body.querySelectorAll("label, .ant-radio-wrapper, .ant-checkbox-wrapper")]
        .filter((el) => visible(el) && norm(el.textContent).includes(text) && el.querySelector(selector))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        });
      for (const container of containers) {
        const exactWrapper = [...container.querySelectorAll(".ant-radio-wrapper, .ant-checkbox-wrapper, label")]
          .filter((el) => visible(el) && norm(el.textContent).includes(text) && el.querySelector(selector))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.width * ar.height - br.width * br.height;
          })[0];
        const isWrapperContainer = container.matches?.(".ant-radio-wrapper, .ant-checkbox-wrapper, label");
        const target = exactWrapper || (isWrapperContainer ? container.querySelector(selector) : null);
        if (!target) continue;
        const root = controlRoot(target, type);
        if (root) return root;
      }
      return null;
    };
    const findControlNearText = (text, type) => {
      const inContainer = findControlInTextContainer(text, type);
      if (inContainer) return inContainer;
      const rect = textRect(text);
      if (!rect) return null;
      const centerY = rect.top + rect.height / 2;
      const selector =
        type === "radio"
          ? ".ant-radio-wrapper, .ant-radio, .ant-radio-inner, input[type='radio']"
          : ".ant-checkbox-wrapper, .ant-checkbox, .ant-checkbox-inner, input[type='checkbox']";
      const controls = [...videoArea.querySelectorAll(selector)]
        .map((control) => controlRoot(control, type))
        .filter(Boolean)
        .filter((control, index, list) => list.indexOf(control) === index)
        .map((control) => {
          const visual =
            control.querySelector?.(type === "radio" ? ".ant-radio-inner" : ".ant-checkbox-inner") ||
            control.querySelector?.(`input[type='${type}']`) ||
            control;
          const ir = (visible(visual) ? visual : control).getBoundingClientRect();
          const cx = ir.left + ir.width / 2;
          const cy = ir.top + ir.height / 2;
          return {
            control,
            sameLine: Math.abs(cy - centerY) < Math.max(36, rect.height * 2.2),
            score:
              Math.abs(cy - centerY) * 30 +
              Math.abs(cx - rect.left) +
              (cx > rect.right + 40 ? 1000 : 0) +
              (cx < rect.left - 260 ? 500 : 0),
          };
        })
        .filter((item) => item.sameLine)
        .sort((a, b) => a.score - b.score);
      return controls[0]?.control || null;
    };
    const clickPoint = (x, y) => {
      let target = document.elementFromPoint(x, y);
      if (!target) return false;
      target = target.closest?.(".ant-radio-wrapper, .ant-radio, .ant-checkbox-wrapper, .ant-checkbox, label, button, [role='switch']") || target;
      const rect = target.getBoundingClientRect?.();
      for (const eventType of ["mouseover", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(
          new MouseEvent(eventType, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect ? rect.left + rect.width / 2 : x,
            clientY: rect ? rect.top + rect.height / 2 : y,
          }),
        );
      }
      target.click?.();
      return true;
    };
    const clickByTextOffset = (text, type) => {
      const rect = textRect(text);
      if (!rect) return false;
      const centerY = rect.top + rect.height / 2;
      const offsets = type === "radio" ? [-24, -32, -42, -55] : [-28, -42, -58, -72, -92];
      for (const offset of offsets) {
        const x = Math.max(2, rect.left + offset);
        const y = centerY;
        if (clickPoint(x, y)) return true;
      }
      return false;
    };
    const clickRadioInVerificationRow = (text) => {
      const row = [...document.body.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes("验证方式") && norm(el.textContent).includes(text))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        })[0];
      if (row) {
        const label = [...row.querySelectorAll("label, .ant-radio-wrapper")]
          .filter((el) => visible(el) && norm(el.textContent).includes(text))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.width * ar.height - br.width * br.height;
          })[0];
        const radio = label?.querySelector(".ant-radio-inner, .ant-radio, input[type='radio']");
        if (radio) {
          clickControl(radio, "radio");
          return true;
        }
      }
      const rect = textRect(text);
      if (!rect) return false;
      const y = rect.top + rect.height / 2;
      for (const x of [rect.left - 24, rect.left - 34, rect.left - 46, rect.left - 62]) {
        if (clickPoint(Math.max(2, x), y)) return true;
      }
      return false;
    };
    const setOption = (text, type, desired = true, required = true) => {
      const control = findControlNearText(text, type);
      if (!control) {
        const clicked = desired ? clickByTextOffset(text, type) : false;
        if (!clicked && required) throw new Error(`视频监控区域未找到选项：${text}`);
        return;
      }
      if (isChecked(control, type) !== desired) clickControl(control, type);
      if (isChecked(control, type) !== desired) {
        if (desired && clickByTextOffset(text, type) && isChecked(control, type) === desired) return;
        const input = control.querySelector?.(`input[type='${type}']`) || (control.matches?.(`input[type='${type}']`) ? control : null);
        const descriptor =
          input &&
          (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "checked") ||
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked"));
        if (input && descriptor?.set) descriptor.set.call(input, desired);
        else if (input) input.checked = desired;
        input?.dispatchEvent(new Event("input", { bubbles: true }));
        input?.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    setOption("登录验证", "checkbox", true);
    setOption("自动验证", "radio", true, false);
    if (!clickRadioInVerificationRow("考后公安验证")) {
      setOption("考后公安验证", "radio", true, false);
    }
    setOption("作弊侦测", "checkbox", true, false);
    setOption("基础版AI", "radio", true, false);
  });

  await ensureOptionCheckedByMouse(page, "考后公安验证", "radio");
  await ensureOptionCheckedByMouse(page, "作弊侦测", "checkbox");
  await ensureOptionCheckedByMouse(page, "基础版AI", "radio");

  await pause(300);
  const status = await evaluate(page, () => {
    const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const area = [...document.querySelectorAll("div, li, section, form")]
      .filter(
        (el) =>
          visible(el) &&
          norm(el.textContent).includes("视频监控") &&
          norm(el.textContent).includes("登录验证") &&
          norm(el.textContent).includes("作弊侦测"),
      )
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    const checkedNear = (text, kind) => {
      const scope = area || document.body;
      const selector = kind === "radio" ? ".ant-radio" : ".ant-checkbox";
      const wrapperSelector = kind === "radio" ? ".ant-radio-wrapper" : ".ant-checkbox-wrapper";
      const directWrapper = [...scope.querySelectorAll(`${wrapperSelector}, label`), ...document.body.querySelectorAll(`${wrapperSelector}, label`)]
        .filter((el) => visible(el) && norm(el.textContent).includes(text) && el.querySelector(selector))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        })[0];
      if (directWrapper) {
        const el = directWrapper.querySelector(selector);
        return kind === "radio" ? el?.classList.contains("ant-radio-checked") : el?.classList.contains("ant-checkbox-checked");
      }
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let rect = null;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!norm(node.textContent).includes(text) || !visible(node.parentElement)) continue;
        const range = document.createRange();
        const start = String(node.textContent || "").indexOf(text);
        if (start >= 0) {
          range.setStart(node, start);
          range.setEnd(node, start + text.length);
        } else {
          range.selectNodeContents(node);
        }
        rect = range.getBoundingClientRect();
        range.detach();
        break;
      }
      if (!rect) {
        const element = [...scope.querySelectorAll("label, span, div, li"), ...document.body.querySelectorAll("label, span")]
          .filter((el) => visible(el) && norm(el.textContent).includes(text))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.width * ar.height - br.width * br.height;
          })[0];
        rect = element?.getBoundingClientRect() || null;
      }
      if (!rect) return false;
      const cy = rect.top + rect.height / 2;
      const controls = [...scope.querySelectorAll(selector)]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, score: Math.abs(r.top + r.height / 2 - cy) * 30 + Math.abs(r.left - rect.left) };
        })
        .filter((item) => item.score < 1500)
        .sort((a, b) => a.score - b.score);
      const el = controls[0]?.el;
      return kind === "radio" ? el?.classList.contains("ant-radio-checked") : el?.classList.contains("ant-checkbox-checked");
    };
    return {
      loginValidation: checkedNear("登录验证", "checkbox"),
      postPoliceVerify: checkedNear("考后公安验证", "radio"),
      cheatDetection: checkedNear("作弊侦测", "checkbox"),
    };
  });
  return status;
}

async function ensurePostPoliceVerifySelected(page) {
  await ensureOptionCheckedByMouse(page, "自动验证", "radio");
  await ensureOptionCheckedByMouse(page, "考后公安验证", "radio");
}

async function setWebExamLeaveLimit(page, value) {
  await evaluate(
    page,
    (nextValue) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const row = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes("网页考试") && norm(el.textContent).includes("只允许离开"))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
      const inputs = [...(row || document).querySelectorAll("input")]
        .filter((input) => visible(input) && input.type !== "checkbox" && input.type !== "radio");
      const input = inputs[inputs.length - 1] || inputs[0];
      if (!input) {
        throw new Error("未找到网页考试允许离开次数输入框");
      }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      input.focus();
      if (setter) setter.call(input, String(nextValue));
      else input.value = String(nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    value,
  );
}

async function toggleSwitchByText(page, label, desired) {
  await evaluate(
    page,
    ({ label: targetLabel, desiredState }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const textRect = (() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!norm(node.textContent).includes(targetLabel) || !visible(node.parentElement)) continue;
          const range = document.createRange();
          const start = String(node.textContent || "").indexOf(targetLabel);
          if (start >= 0) {
            range.setStart(node, start);
            range.setEnd(node, start + targetLabel.length);
          } else {
            range.selectNodeContents(node);
          }
          const rect = range.getBoundingClientRect();
          range.detach();
          if (rect.width > 0 && rect.height > 0) return rect;
        }
        const el = [...document.querySelectorAll("label, span, div, li")]
          .filter((item) => visible(item) && norm(item.textContent).includes(targetLabel))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.width * ar.height - br.width * br.height;
          })[0];
        return el?.getBoundingClientRect() || null;
      })();
      if (!textRect) {
        throw new Error(`未找到开关：${targetLabel}`);
      }

      const centerY = textRect.top + textRect.height / 2;
      const switchEl = [...document.querySelectorAll("[role='switch'], .ant-switch, button[aria-checked]")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            el,
            sameLine: Math.abs(rect.top + rect.height / 2 - centerY) < Math.max(40, textRect.height * 2.5),
            score: Math.abs(rect.top + rect.height / 2 - centerY) * 30 + Math.max(0, textRect.left - rect.left) * 20 + Math.abs(rect.left - textRect.right),
          };
        })
        .filter((item) => item.sameLine)
        .sort((a, b) => a.score - b.score)[0]?.el;
      if (!switchEl) {
        throw new Error(`未找到开关控件：${targetLabel}`);
      }

      const current =
        switchEl.getAttribute("aria-checked") === "true" ||
        switchEl.classList.contains("ant-switch-checked") ||
        switchEl.classList.contains("is-checked");
      if (current !== desiredState) {
        switchEl.click();
      }
    },
    { label, desiredState: desired },
  );
}

async function fillTextareaInRow(page, rowLabel, value) {
  return evaluate(
    page,
    ({ targetLabel, nextValue }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const row = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)
        .find((el) => el.querySelector("textarea, input, [contenteditable='true'], .ql-editor, [role='textbox']"));
      const field = row?.querySelector("textarea, input, [contenteditable='true'], .ql-editor, [role='textbox']");
      if (!field) {
        throw new Error(`未找到文本区域：${targetLabel}`);
      }

      field.scrollIntoView({ block: "center", inline: "center" });
      field.focus();
      if (field.matches("textarea, input")) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
        if (setter) setter.call(field, nextValue);
        else field.value = nextValue;
        field.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      } else {
        field.textContent = nextValue;
        field.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
      }
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.dispatchEvent(new Event("blur", { bubbles: true }));
      return {
        tag: field.tagName,
        className: field.className || "",
        value: field.matches("textarea, input") ? field.value : norm(field.textContent),
      };
    },
    { targetLabel: rowLabel, nextValue: value },
  );
}

async function fillPledgeContent(page, value) {
  await openAdvancedEditorForRow(page, "考试承诺书", "需同意以下内容");
  await fillAdvancedEditorSource(page, value);
}

async function openAdvancedEditorForRow(page, rowLabel, rowHint) {
  const clickedEditable = await evaluate(
    page,
    ({ targetLabel, targetHint }) => {
      const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const editableSelector = "textarea, [contenteditable='true'], .ql-editor, [role='textbox'], input, .item-stem";
      const candidates = [...document.querySelectorAll("div, li, section")]
        .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel) && (!targetHint || norm(el.textContent).includes(targetHint)))
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      const row = candidates.find((el) => el.querySelector(editableSelector)) || candidates[0];
      if (!row) throw new Error(`未找到配置行：${targetLabel}`);

      const editable = [...row.querySelectorAll(editableSelector)]
        .filter((el) => visible(el) && el.type !== "checkbox" && el.type !== "radio")
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (Math.abs(br.width * br.height - ar.width * ar.height) > 2) return br.width * br.height - ar.width * ar.height;
          return ar.top - br.top;
        })[0];
      if (editable) {
        editable.scrollIntoView({ block: "center", inline: "center" });
        editable.click();
        return true;
      }
      return false;
    },
    { targetLabel: rowLabel, targetHint: rowHint },
  );
  if (!clickedEditable) {
    throw new Error(`未找到可编辑区域：${rowLabel}`);
  }

  const deadline = Date.now() + 3000;
  let clickedAdvanced = false;
  while (Date.now() < deadline && !clickedAdvanced) {
    clickedAdvanced = await evaluate(
      page,
      ({ targetLabel, targetHint }) => {
        const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll("div, li, section")]
          .filter((el) => visible(el) && norm(el.textContent).includes(targetLabel) && (!targetHint || norm(el.textContent).includes(targetHint)))
          .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
        const row = candidates.find((el) => el.querySelector(".item-stem, [contenteditable='true'], .ql-editor, [role='textbox']")) || candidates[0];
        if (!row) return false;
        const buttons = [...row.querySelectorAll("button, span, i, a, div")]
          .filter((el) => visible(el))
          .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        const textButton =
          buttons.find((el) => String(el.className || "").includes("SeniorEdit")) ||
          buttons.find((el) => norm(el.textContent) === "T") ||
          buttons.find((el) => norm(el.textContent).includes("T")) ||
          buttons.find((el) => el.getBoundingClientRect().right > row.getBoundingClientRect().right - 120);
        if (!textButton) return false;
        textButton.scrollIntoView({ block: "center", inline: "center" });
        textButton.click();
        return true;
      },
      { targetLabel: rowLabel, targetHint: rowHint },
    );
    if (!clickedAdvanced) await pause(150);
  }
  if (!clickedAdvanced) {
    throw new Error(`未找到高级编辑按钮：${rowLabel}`);
  }

  await page.getByText("高级编辑", { exact: false }).first().waitFor({ state: "visible", timeout: 8000 });
  await waitForAdvancedEditorReady(page);
}

async function fillAdvancedEditorSource(page, value) {
  const html = toEditorHtml(value);
  await waitForAdvancedEditorReady(page);
  await clickSourceCodeButton(page);

  const hasSourceDialog = await waitForSourceDialogOptional(page);
  if (hasSourceDialog) {
    await fillVisibleSourceTextarea(page, html);
    const actualHtml = await readVisibleSourceTextarea(page);
    if (actualHtml !== html) {
      throw new Error(`源码内容写入失败，期望 ${html}，实际 ${actualHtml}`);
    }
    await clickTinyMceSourceSave(page);
    await waitForSourceDialogHidden(page);
  } else {
    await fillInlineSourceEditor(page, html);
  }
  await clickButtonInDialog(page, "高级编辑", "保存");
  await page.getByText("高级编辑", { exact: false }).first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
}

function toEditorHtml(value) {
  const raw = String(value ?? "");
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return `<p>${raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
}

async function waitForSourceDialogOptional(page) {
  return page
    .waitForFunction(
      () => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        return [...document.querySelectorAll("textarea")]
          .some((el) => visible(el) && el.getBoundingClientRect().width > 500 && el.getBoundingClientRect().height > 200);
      },
      { timeout: 1200 },
    )
    .then(() => true)
    .catch(() => false);
}

async function fillVisibleSourceTextarea(page, html) {
  const filled = await evaluate(
    page,
    (nextHtml) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textarea = [...document.querySelectorAll("textarea")]
        .filter((el) => visible(el))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        })[0];
      if (!textarea) return false;
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set;
      if (setter) setter.call(textarea, nextHtml);
      else textarea.value = nextHtml;
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextHtml, inputType: "insertText" }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      textarea.dispatchEvent(new Event("blur", { bubbles: true }));
      return textarea.value === nextHtml;
    },
    html,
  );
  if (!filled) {
    const textarea = page.locator("textarea").first();
    await textarea.fill(html, { timeout: 10000 });
  }
}

async function readVisibleSourceTextarea(page) {
  return evaluate(page, () => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textarea = [...document.querySelectorAll("textarea")]
      .filter((el) => visible(el))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0];
    return textarea?.value || "";
  });
}

async function fillInlineSourceEditor(page, html) {
  const result = await evaluate(
    page,
    (nextHtml) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const advancedModals = [...document.querySelectorAll(".ant-modal, .modal, [role='dialog'], div")]
        .filter((el) => visible(el) && (el.textContent || "").includes("高级编辑"))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        });
      const advancedModal = advancedModals[0] || document.body;
      const candidates = [...advancedModal.querySelectorAll("textarea, [contenteditable='true'], iframe")]
        .filter(visible)
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        });
      const editor = candidates[0];
      if (!editor) return { ok: false, reason: "未找到源码模式编辑区" };
      if (editor.tagName === "IFRAME") {
        const body = editor.contentDocument?.body;
        if (!body) return { ok: false, reason: "无法访问编辑 iframe" };
        body.focus();
        body.innerHTML = nextHtml;
        body.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextHtml, inputType: "insertText" }));
        body.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: body.innerHTML.includes(nextHtml.replace(/^<p>|<\/p>$/g, "")), value: body.innerHTML };
      }
      editor.focus();
      if (editor.matches("textarea")) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
        if (setter) setter.call(editor, nextHtml);
        else editor.value = nextHtml;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextHtml, inputType: "insertText" }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: editor.value === nextHtml, value: editor.value };
      }
      editor.textContent = nextHtml;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextHtml, inputType: "insertText" }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: (editor.textContent || "") === nextHtml, value: editor.textContent || "" };
    },
    html,
  );
  if (!result?.ok) {
    throw new Error(`源码模式内容写入失败：${result?.reason || ""} 实际 ${result?.value || ""}`);
  }
}

async function clickSourceCodeButton(page) {
  const openedByCommand = await evaluate(page, () => {
    try {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const tinymce = window.tinymce;
      if (!tinymce?.editors?.length) return false;
      const editors = tinymce.editors
        .filter((editor) => {
          const container = editor.getContainer?.();
          return container && visible(container);
        })
        .sort((a, b) => {
          const ar = a.getContainer().getBoundingClientRect();
          const br = b.getContainer().getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        });
      const editor = editors[0] || tinymce.activeEditor;
      if (!editor) return false;
      editor.focus();
      editor.execCommand("mceCodeEditor");
      return true;
    } catch {
      return false;
    }
  });
      if (openedByCommand) {
    const opened = await page
      .waitForFunction(
        () => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll("textarea")]
            .some((el) => visible(el) && el.getBoundingClientRect().width > 500 && el.getBoundingClientRect().height > 200);
        },
        { timeout: 1500 },
      )
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }

  const candidates = await evaluate(page, () => {
    const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const advancedModals = [...document.querySelectorAll(".ant-modal, .modal, [role='dialog'], div")]
      .filter((el) => visible(el) && (el.textContent || "").includes("高级编辑"))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      });
    const advancedModal = advancedModals[0] || document.body;
    const modalRect = advancedModal.getBoundingClientRect();
    const toolbarButtons = [...advancedModal.querySelectorAll("button, .tox-tbtn, [role='button']")].filter(visible);
    const toPoint = (el, priority) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        priority,
        text: norm(el.textContent),
        aria: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
      };
    };
    const points = [];
    for (const button of toolbarButtons) {
      const text = norm(button.textContent);
      const aria = button.getAttribute("aria-label") || "";
      const title = button.getAttribute("title") || "";
      const dataName = button.getAttribute("data-mce-name") || "";
      let priority = 100;
      if ([aria, title, dataName].some((value) => /源代码|源码|source|code/i.test(value))) priority = 1;
      else if (text === "<>" || text === "< >") priority = 2;
      else {
        const rect = button.getBoundingClientRect();
        const targetX = modalRect.left + 130;
        const targetY = modalRect.top + 230;
        priority = 10 + Math.abs(rect.left + rect.width / 2 - targetX) / 20 + Math.abs(rect.top + rect.height / 2 - targetY) / 20;
      }
      points.push(toPoint(button, priority));
    }
    return points
      .sort((a, b) => a.priority - b.priority)
      .filter((point, index, list) => index === list.findIndex((item) => Math.abs(item.x - point.x) < 2 && Math.abs(item.y - point.y) < 2))
      .slice(0, 12);
  });
  if (!candidates.length) throw new Error("未找到考试承诺书源码按钮");
  for (const point of candidates) {
    await page.mouse.click(point.x, point.y);
    const opened = await page
      .waitForFunction(
        () => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll("textarea")]
            .some((el) => visible(el) && el.getBoundingClientRect().width > 500 && el.getBoundingClientRect().height > 200);
        },
        { timeout: 800 },
      )
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error(`未能打开源码弹窗，候选按钮 ${JSON.stringify(candidates.slice(0, 6))}`);
}

async function waitForAdvancedEditorReady(page) {
  await page.waitForFunction(
    () => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const modal = [...document.querySelectorAll(".ant-modal, .modal, [role='dialog'], div")]
        .find((el) => visible(el) && (el.textContent || "").includes("高级编辑"));
      if (!modal) return false;
      return [...modal.querySelectorAll("button, .tox-tbtn, [role='button']")]
        .filter(visible).length >= 5;
    },
    { timeout: 10000 },
  );
}

async function waitForSourceDialog(page) {
  await page.waitForFunction(
    () => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll("textarea")]
        .some((el) => visible(el) && el.getBoundingClientRect().width > 500 && el.getBoundingClientRect().height > 200);
    },
    { timeout: 10000 },
  );
}

async function waitForSourceDialogHidden(page) {
  await page
    .waitForFunction(
      () => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        return ![...document.querySelectorAll("textarea")]
          .some((el) => visible(el) && el.getBoundingClientRect().width > 500 && el.getBoundingClientRect().height > 200);
      },
      { timeout: 8000 },
    )
    .catch(() => {});
}

async function clickTinyMceSourceSave(page) {
  const clicked = await evaluate(page, () => {
    const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
    const compact = (value) => norm(value).replace(/\s/g, "");
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const hasLargeTextarea = (root) =>
      [...root.querySelectorAll("textarea")]
        .some((el) => visible(el) && el.getBoundingClientRect().width > 500 && el.getBoundingClientRect().height > 200);
    const area = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const dialogs = [...document.querySelectorAll(".tox-dialog, .ant-modal, .modal, [role='dialog'], div")]
      .filter((el) => visible(el) && hasLargeTextarea(el))
      .sort((a, b) => area(b) - area(a));
    const roots = dialogs.length ? dialogs : [document.body];
    for (const dialog of roots) {
      const button = [...dialog.querySelectorAll("button, .tox-button, .ant-btn")]
      .filter((el) => visible(el) && compact(el.textContent) === "保存")
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (Math.abs(br.bottom - ar.bottom) > 2) return br.bottom - ar.bottom;
          return br.right - ar.right;
        })[0];
      if (button) {
        button.scrollIntoView({ block: "center", inline: "center" });
        button.click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) throw new Error("未找到源代码保存按钮");
}

async function clickButtonInDialog(page, dialogTitle, buttonText) {
  const clicked = await evaluate(
    page,
    ({ title, text }) => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const compact = (value) => norm(value).replace(/\s/g, "");
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const dialogs = [...document.querySelectorAll(".ant-modal, .modal, [role='dialog'], div")]
        .filter((el) => visible(el) && norm(el.textContent).includes(title))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        });
      const dialog = dialogs[0];
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll("button, .ant-btn")]
        .filter((el) => visible(el) && compact(el.textContent) === compact(text));
      let button = buttons
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (Math.abs(br.bottom - ar.bottom) > 2) return br.bottom - ar.bottom;
          return br.right - ar.right;
        })[0];
      if (!button) {
        button = [...document.querySelectorAll("button, .ant-btn")]
          .filter((el) => visible(el) && compact(el.textContent) === compact(text))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            if (Math.abs(br.bottom - ar.bottom) > 2) return br.bottom - ar.bottom;
            return br.right - ar.right;
          })[0];
      }
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return true;
    },
    { title: dialogTitle, text: buttonText },
  );
  if (!clicked) {
    throw new Error(`未找到弹窗按钮：${dialogTitle} / ${buttonText}`);
  }
}

async function fillPreLoginPrompt(page, value) {
  await openAdvancedEditorForRow(page, "如需考前等待提示", "");
  await fillAdvancedEditorSource(page, value);
}

async function fillWelcomeText(page, value) {
  await openAdvancedEditorForRow(page, "欢迎语", "");
  await fillAdvancedEditorSource(page, value);
  return { tag: "ADVANCED_SOURCE", value };
}

async function collectBasicInfoSnapshot(page) {
  return evaluate(page, () => {
    const norm = (text) => (text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const visibleTextareas = [...document.querySelectorAll("textarea")]
      .filter(visible)
      .map((el, index) => ({ index, value: el.value || "", top: Math.round(el.getBoundingClientRect().top) }));
    const visibleInputs = [...document.querySelectorAll("input")]
      .filter(visible)
      .map((el, index) => ({
        index,
        type: el.getAttribute("type") || "",
        placeholder: el.getAttribute("placeholder") || "",
        value: el.value || "",
        checked: el.type === "checkbox" ? el.checked : undefined,
        top: Math.round(el.getBoundingClientRect().top),
        left: Math.round(el.getBoundingClientRect().left),
      }));
    const findMinute = (label) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!norm(node.textContent).includes(label) || !visible(node.parentElement)) continue;
        let container = node.parentElement;
        for (let i = 0; container && i < 8; i += 1) {
          const checkbox = container.querySelector("input[type='checkbox']");
          const inputs = [...container.querySelectorAll("input")]
            .filter((input) => visible(input) && input.type !== "checkbox" && input.type !== "hidden" && input.type !== "password");
          if (checkbox && inputs.length) {
            return { checked: checkbox.checked, value: inputs[0].value || "" };
          }
          container = container.parentElement;
        }
      }
      return { checked: null, value: "" };
    };
    return {
      textareas: visibleTextareas,
      inputs: visibleInputs,
      earlyLogin: findMinute("提前登录"),
      lateLimit: findMinute("限制迟到"),
    };
  });
}

async function waitForStep(page, stepText) {
  await page.getByText(stepText, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
}

async function nextStep(page, targetStepText = "考试配置") {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await pause(300);

  const nextButton = page
    .getByRole("button", { name: /^下一步$/ })
    .filter({ hasText: "下一步" })
    .last();

  try {
    await nextButton.waitFor({ state: "visible", timeout: 5000 });
    await nextButton.scrollIntoViewIfNeeded();
    await nextButton.click({ timeout: 3000 });
  } catch (normalClickError) {
    try {
      await nextButton.click({ timeout: 3000, force: true });
    } catch (forceClickError) {
      const clicked = await page.evaluate(() => {
        const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        window.scrollTo(0, document.body.scrollHeight);
        const candidates = [...document.querySelectorAll("button, .ant-btn")]
          .filter((el) => visible(el) && norm(el.textContent) === "下一步")
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .sort((a, b) => {
            if (Math.abs(b.rect.bottom - a.rect.bottom) > 2) return b.rect.bottom - a.rect.bottom;
            return b.rect.right - a.rect.right;
          });
        const target = candidates[0]?.el;
        if (!target) return false;
        target.scrollIntoView({ block: "center", inline: "center" });
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
            }),
          );
        }
        return true;
      });
      if (!clicked) {
        throw new Error(`下一步按钮点击失败：${normalClickError.message || normalClickError}; ${forceClickError.message || forceClickError}`);
      }
    }
  }

  await waitForStep(page, targetStepText);
  if (targetStepText === "考试配置") {
    await page.getByText("考试承诺书", { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
  }
}

async function finishCreation(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await pause(300);
  try {
    const button = page.getByRole("button", { name: /^创建完成$/ }).last();
    await button.waitFor({ state: "visible", timeout: 5000 });
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 3000 });
  } catch {
    const clicked = await page.evaluate(() => {
      const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      window.scrollTo(0, document.body.scrollHeight);
      const target = [...document.querySelectorAll("button, .ant-btn")]
        .filter((el) => visible(el) && norm(el.textContent) === "创建完成")
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      }
      return true;
    });
    if (!clicked) throw new Error("未找到创建完成按钮");
  }

  await Promise.race([
    page.waitForURL(/\/manager\/schedule\/session\/(list|[0-9]+|$)/, { timeout: 20_000 }).catch(() => null),
    page.getByText(/创建成功|新建成功|保存成功|未开始|我的考试/, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => null),
  ]);
}

async function normalizeBrowserView(page, context) {
  await page.setViewportSize({ width: 1440, height: 1100 }).catch(() => {});
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
    document.body.style.zoom = "1";
    window.scrollTo(0, 0);
  }).catch(() => {});
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await cdp.detach();
  } catch {}
}

async function runBasicInfo(page, config, emit) {
  emit(event("stage", { stage: "基础信息", percent: 24, stepIndex: 1, caption: "正在填写考试名称、考试时间、提前登录和迟到限制" }));
  if (!(await waitForBasicInfoReady(page, 20_000))) {
    throw new Error("尚未进入新建考试基本信息页，已停止，避免把考试信息填到错误页面。");
  }
  emit(event("log", { level: "success", message: "已进入基本信息页，开始填写基础信息。" }));

  const timezoneText = await readBasicInfoTimezone(page);
  emit(event("log", { level: "success", message: `页面时区：${timezoneText || "未识别"}` }));

  await fillExamNameField(page, config.examName);
  emit(event("log", { level: "success", message: `已填写考试名称：${config.examName}` }));
  const examNameReadback = await readBasicInfoField(page, "考试名称");
  emit(event("log", { level: examNameReadback === config.examName ? "success" : "warn", message: `考试名称回读：${examNameReadback || "空"}` }));
  if (examNameReadback !== config.examName) {
    throw new Error(`考试名称回读不一致，期望“${config.examName}”，实际“${examNameReadback || "空"}”`);
  }

  await setDateTimeField(page, "开始时间", config.startTimeDisplay, timezoneText, emit);
  emit(event("log", { level: "success", message: `已确认开始时间：${config.startTimeDisplay}` }));
  const startReadback = await readBasicInfoField(page, "开始时间");
  emit(event("log", { level: startReadback ? "success" : "warn", message: `开始时间回读：${startReadback || "空"}` }));

  await setDateTimeField(page, "结束时间", config.endTimeDisplay, timezoneText, emit);
  emit(event("log", { level: "success", message: `已确认结束时间：${config.endTimeDisplay}` }));
  const endReadback = await readBasicInfoField(page, "结束时间");
  emit(event("log", { level: endReadback ? "success" : "warn", message: `结束时间回读：${endReadback || "空"}` }));
  await closeDateTimePanel(page);
  emit(event("log", { level: "success", message: "考试时间步骤结束，开始处理提前登录和限制迟到。" }));

  emit(event("log", { level: "success", message: `本次读取提前登录/限制迟到：${config.earlyLoginMinutes ?? "空"} / ${config.lateLimitMinutes ?? "空"} 分钟` }));

  if (config.earlyLoginMinutes != null) {
    emit(event("log", { level: "success", message: `开始填写提前登录：${config.earlyLoginMinutes} 分钟` }));
    await enableMinuteOption(page, "提前登录", config.earlyLoginMinutes, emit);
    emit(event("log", { level: "success", message: `已填写提前登录：${config.earlyLoginMinutes} 分钟` }));
  }
  if (config.earlyLoginMinutes != null && config.preLoginPrompt) {
    await fillPreLoginPrompt(page, config.preLoginPrompt);
    emit(event("log", { level: "success", message: "已通过源码编辑填写考前等待提示。" }));
  }
  if (config.lateLimitMinutes != null) {
    emit(event("log", { level: "success", message: `开始填写限制迟到：${config.lateLimitMinutes} 分钟` }));
    await enableMinuteOption(page, "限制迟到", config.lateLimitMinutes, emit);
    emit(event("log", { level: "success", message: `已填写限制迟到：${config.lateLimitMinutes} 分钟` }));
  }

  await selectRadioInGroup(page, "试卷扣时规则", config.timeRule || "迟到及离开扣时");
  await selectRadioInGroup(page, "场次类型", "考试");
  await selectRadioInGroup(page, "考试地址", "独立考试地址");
  await selectRadioInGroup(page, "交卷后跳转", "不跳转");

  if (config.welcomeText) {
    const examNameBeforeWelcome = await readBasicInfoField(page, "考试名称");
    const welcomeResult = await fillWelcomeText(page, config.welcomeText);
    emit(event("log", { level: "success", message: `已填写欢迎语：${welcomeResult?.value || "空"}；目标 ${welcomeResult?.tag || "未知"} ${welcomeResult?.className || ""}` }));
    const examNameAfterWelcome = await readBasicInfoField(page, "考试名称");
    if (examNameAfterWelcome !== examNameBeforeWelcome) {
      await fillExamNameField(page, config.examName);
      throw new Error(`欢迎语填写误改考试名称，已恢复考试名称。原值“${examNameBeforeWelcome || "空"}”，误写为“${examNameAfterWelcome || "空"}”`);
    }
  }

  const finalExamNameReadback = await readBasicInfoField(page, "考试名称");
  if (finalExamNameReadback !== config.examName) {
    throw new Error(`基础信息结束前考试名称被改写，期望“${config.examName}”，实际“${finalExamNameReadback || "空"}”`);
  }

  await expectBasicInfoReadyToSubmit(page, config, emit);
  await nextStep(page, "批量添加科目");
  emit(event("log", { level: "success", message: "基础信息填写完成，已进入选择试卷页。" }));
}

async function runSubjects(page, config, emit) {
  emit(event("stage", { stage: "选择试卷", percent: 46, stepIndex: 2, caption: "正在下载易考科目模板、填充并批量导入" }));

  if (config.subjects.length && config.subjectImportPath) {
    emit(event("log", { level: "success", message: `准备批量导入科目：${config.subjects.join("、")}` }));
    try {
      await fastImportSubjects(page, config);
      emit(event("log", { level: "success", message: "已下载后台科目模板，填充后完成上传。" }));
    } catch (error) {
      emit(event("log", { level: "warn", message: `科目批量导入未成功：${error.message}` }));
    }
  } else {
    emit(event("log", { level: "warn", message: "需求单未读取到科目，已跳过科目导入。" }));
  }

  await clickButton(page, "下一步");
  const confirmMissingPaper = page.getByText("当前未选择试卷或模板，是否继续操作？", { exact: false });
  if ((await confirmMissingPaper.count()) > 0) {
    await clickButton(page, "确 定");
  }

  await waitForStep(page, "已选信息");
  await waitForPersonalInfoCheckboxes(page);
  emit(event("log", { level: "success", message: "已进入个人信息页。" }));
}

async function fastImportSubjects(page, config) {
  await clickButton(page, "批量添加科目");
  const filePath = await prepareSubjectImportFile(page, config);

  const fileInput = page.locator("input[type='file']").last();
  try {
    await fileInput.waitFor({ state: "attached", timeout: 1500 });
    await fileInput.setInputFiles(filePath);
  } catch {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 3000 });
    const uploadButton = page.getByText("拖拽或点击上传文件", { exact: false }).last();
    await uploadButton.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);
  }

  await clickButton(page, "确 定");

  const errorText = page.getByText("未知异常", { exact: false });
  const successText = page.getByText(/导入成功|上传成功|添加成功/);
  await Promise.race([
    errorText.waitFor({ state: "visible", timeout: 2500 }).then(() => "error").catch(() => null),
    successText.waitFor({ state: "visible", timeout: 2500 }).then(() => "success").catch(() => null),
    page.waitForTimeout(1200).then(() => "timeout"),
  ]).then(async (result) => {
    if (result === "error") {
      const known = page.getByRole("button", { name: "我知道了" }).last();
      if ((await known.count()) > 0 && (await known.isVisible().catch(() => false))) {
        await known.click();
      }
      throw new Error("后台返回未知异常，请检查科目导入模板格式。");
    }
  });
}

async function prepareSubjectImportFile(page, config) {
  const workDir = path.dirname(config.subjectImportPath);
  await fs.mkdir(workDir, { recursive: true });

  try {
    const templatePath = path.join(workDir, "易考科目导入模板.xlsx");
    const outputPath = path.join(workDir, "易考科目导入_已填.xlsx");
    const templateLink = page.getByText("科目导入模板", { exact: false }).last();
    await templateLink.waitFor({ state: "visible", timeout: 5000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 5000 });
    await templateLink.click();
    const download = await downloadPromise;
    await download.saveAs(templatePath);
    await fillSubjectTemplate(templatePath, outputPath, config.subjects);
    return outputPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`未能下载并填充后台科目导入模板：${message}`);
  }
}

async function fillSubjectTemplate(templatePath, outputPath, subjects) {
  const child = spawn(pythonBin, [subjectTemplateScript, templatePath, outputPath, JSON.stringify(subjects)], {
    cwd: path.dirname(subjectTemplateScript),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "科目导入模板填充失败");
  }
}

async function runPersonalInfo(page, config, emit) {
  emit(event("stage", { stage: "个人信息", percent: 66, stepIndex: 3, caption: "正在保留姓名、身份证号并取消全部编辑/必填" }));

  const visibleSet = new Set(config.visibleFields || ["姓名", "身份证号"]);
  const personalResult = await configurePersonalInfoVisibility(page, visibleSet);
  emit(event("log", { level: "success", message: `个人信息勾选结果：${JSON.stringify(personalResult)}` }));
  const failed = personalResult.filter((row) => {
    const shouldVisible = visibleSet.has(row.name);
    return !row.ok || row.allowEdit !== false || row.candidateVisible !== shouldVisible || row.required !== false;
  });
  if (failed.length) {
    emit(event("log", { level: "warn", message: `个人信息配置读取校验未通过，页面已按行执行设置，继续点击下一步：${JSON.stringify(failed)}` }));
  }

  await nextStep(page, "考试配置");
  emit(event("log", { level: "success", message: "个人信息已调整为仅显示姓名和身份证号，且不允许编辑、不设必填。" }));
}

async function runExamConfig(page, config, emit) {
  emit(event("stage", { stage: "考试配置", percent: 88, stepIndex: 4, caption: "正在配置承诺书、视频监控、鹰眼、客户端和防复制项" }));

  if (String(config.pledgeContent || "").trim()) {
    await setMasterCheckboxByLabel(page, "考试承诺书", true);
    await fillPledgeContent(page, config.pledgeContent);
    emit(event("log", { level: "success", message: "已按需求单填写考试承诺书。" }));
  } else {
    await setMasterCheckboxByLabel(page, "考试承诺书", false);
    emit(event("log", { level: "success", message: "需求单未填写考试承诺书内容，已保持考试承诺书未勾选。" }));
  }

  if (config.videoMonitor) {
    await setMasterCheckboxByLabel(page, "视频监控", true);
    if (config.videoRecord) {
      await toggleSwitchByText(page, "视频录制", true);
    }
    const videoStatus = await configureVideoMonitorDefaults(page);
    await ensurePostPoliceVerifySelected(page);
    const failed = Object.entries(videoStatus || {})
      .filter(([, ok]) => !ok)
      .map(([key]) => key);
    emit(
      event("log", {
        level: failed.length ? "warn" : "success",
        message: failed.length
          ? `已执行视频监控默认项点击，页面继续下一步；读取校验未命中：${failed.join(", ")}`
          : "已配置视频监控默认项：登录验证、自动验证、考后公安验证、作弊侦测。",
      }),
    );
  }
  if (config.videoRecord && !config.videoMonitor) {
    await toggleSwitchByText(page, "视频录制", true);
  }
  if (config.hawkeye) {
    await setMasterCheckboxByLabel(page, "鹰眼监控", true);
  }
  if (config.clientExam) {
    await setMasterCheckboxByLabel(page, "锁定考试", true);
    await setStepValue(page, 0, config.clientLoginLimit || 5);
    await setCheckboxNearText(page, "客户端考试", true);
    emit(event("log", { level: "success", message: "已配置锁定考试：客户端考试；电脑端和独占网络由易考页面自动联动。" }));
  } else if (config.webExam) {
    await setMasterCheckboxByLabel(page, "锁定考试", true);
    await setCheckboxNearText(page, "网页考试", true);
    if (config.leaveLimit != null) {
      await setWebExamLeaveLimit(page, config.leaveLimit);
    } else {
      emit(event("log", { level: "warn", message: "需求单未填写允许离开次数，网页考试离开次数保持页面默认值。" }));
    }
    emit(event("log", { level: "success", message: `已配置锁定考试：网页考试，允许离开 ${config.leaveLimit ?? "空"} 次。` }));
  }
  if (config.watermark) {
    await setMasterCheckboxByLabel(page, "答题水印", true);
  }
  if (config.disableCopy) {
    await setMasterCheckboxByLabel(page, "禁止复制", true);
  }

  await nextStep(page, "完成");
  emit(event("log", { level: "success", message: "考试配置已按需求单写入，准备进入确认页。" }));
}

function buildMockExamConfig(config) {
  if (!config?.mockExamEnabled) {
    return null;
  }
  return {
    ...config,
    examName: config.mockExamName || `${config.examName || "考试"}-试考`,
    startTimeDisplay: config.mockStartTimeDisplay || "",
    endTimeDisplay: config.mockEndTimeDisplay || "",
    startTimeIso: config.mockStartTimeIso || "",
    endTimeIso: config.mockEndTimeIso || "",
    earlyLoginMinutes: null,
    lateLimitMinutes: null,
    preLoginPrompt: "",
    timeRule: "不扣时",
    videoRecord: false,
    clientLoginLimit: 10,
    subjects: [],
    subjectImportPath: "",
  };
}

async function createSingleExam(page, config, emit, options = {}) {
  const isMock = Boolean(options.isMock);
  const doneCaption = isMock ? "正在点击创建完成并等待试考返回" : "正在点击创建完成并等待后台返回";

  await runBasicInfo(page, config, emit);
  await runSubjects(page, config, emit);
  await runPersonalInfo(page, config, emit);
  await runExamConfig(page, config, emit);

  emit(event("stage", { stage: "创建完成", percent: 100, stepIndex: 5, caption: doneCaption }));
  await finishCreation(page);
}

export async function runEasyExamJob({ job, runtimeDir, emit }) {
  const profileDir = path.join(runtimeDir, "chrome-profiles", job.id);
  const shotsDir = path.join(runtimeDir, "shots", job.id);
  await ensureDir(profileDir);
  await ensureDir(shotsDir);

  let context;
  let page;
  let keepBrowserOpen = true;
  try {
    emit(event("stage", { stage: "读取需求单", percent: 8, stepIndex: 0, caption: "正在启动本地自动化引擎并载入需求单" }));
    emit(event("status", { status: "running", message: "正在启动 Chrome" }));
    emit(event("log", { level: "success", message: "正在启动本地 Chrome 自动化会话。" }));
    emit(event("log", { level: "success", message: `本次任务考试名称：${job.config.examName || "空"}` }));
    emit(event("log", { level: "success", message: `本次任务考试时间：${job.config.startTimeDisplay || "空"} - ${job.config.endTimeDisplay || "空"}` }));

    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1440, height: 1100 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: ["--window-size=1440,1100"],
    });

    page = context.pages()[0] ?? (await context.newPage());
    await normalizeBrowserView(page, context);
    emit(event("status", { status: "running", message: "正在连接易考后台" }));
    await page.goto(EZTEST_ADD_URL, { waitUntil: "domcontentloaded" });
    await normalizeBrowserView(page, context);
    await waitForLogin(page, emit, job.login);
    await normalizeBrowserView(page, context);

    await createSingleExam(page, job.config, emit);
    emit(event("log", { level: "success", message: `主考试已创建完成：${job.config.examName || "空"}` }));

    const mockConfig = buildMockExamConfig(job.config);
    if (mockConfig) {
      emit(event("status", { status: "running", message: "主考试完成，正在新建试考" }));
      emit(event("log", { level: "success", message: `开始创建试考：${mockConfig.examName}；时间 ${mockConfig.startTimeDisplay} - ${mockConfig.endTimeDisplay}` }));
      await page.goto(EZTEST_ADD_URL, { waitUntil: "domcontentloaded" });
      await normalizeBrowserView(page, context);
      if (!(await waitForBasicInfoReady(page, 20_000))) {
        throw new Error("主考试创建完成后，未能重新进入新建考试基本信息页，试考创建已停止。");
      }
      await createSingleExam(page, mockConfig, emit, { isMock: true });
      emit(event("log", { level: "success", message: `试考已创建完成：${mockConfig.examName}` }));
    }

    emit(event("status", { status: "completed", message: mockConfig ? "主考试和试考都已创建完成。" : "考试已创建完成。" }));
    emit(event("log", { level: "success", message: mockConfig ? "已完成主考试与试考两次创建流程。" : "已点击创建完成，考试创建流程结束。" }));
    emit(event("done", { result: "created" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (page) {
      try {
        const snapshot = await collectBasicInfoSnapshot(page);
        emit(event("log", {
          level: "warn",
          message: `失败现场字段快照：提前登录=${JSON.stringify(snapshot.earlyLogin)}，限制迟到=${JSON.stringify(snapshot.lateLimit)}，textarea=${JSON.stringify(snapshot.textareas)}`,
        }));
        const failureShot = await takeShot(page, shotsDir, job.id, "failure-current-page", "失败现场");
        emit(event("captures", { captures: [failureShot] }));
        emit(event("log", { level: "warn", message: "已截取失败现场，可在网页中点开查看。" }));
      } catch {}
    }
    if (message.includes("launchPersistentContext") && message.includes("Target page, context or browser has been closed")) {
      throw new Error("自动化浏览器启动失败。原因通常是上一次 Chrome 自动化会话没有正常退出；现在脚本已改为独立会话，请重新点击开始配置。");
    }
    throw error;
  } finally {
    if (context && !keepBrowserOpen) {
      await context.close();
    }
  }
}
