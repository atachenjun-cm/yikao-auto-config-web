import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runEasyExamJob } from "./easy_exam_runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const webFile = path.join(rootDir, "outputs", "web_prototype", "easy_exam_automation.html");
const runtimeDir = path.join(rootDir, ".easy_exam_runtime");
const uploadsDir = path.join(runtimeDir, "uploads");
const settingsPath = path.join(runtimeDir, "settings.json");
const parserScript = path.join(__dirname, "exam_request_parser.py");
const pythonBin =
  process.env.CODEX_PYTHON ||
  "/Users/chen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const state = {
  imports: new Map(),
  jobs: new Map(),
  settings: {
    login: {
      url: "",
      username: "",
      password: "",
    },
  },
};

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function ensureRuntime() {
  await fs.mkdir(uploadsDir, { recursive: true });
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    state.settings = {
      ...state.settings,
      ...parsed,
      login: {
        ...state.settings.login,
        ...(parsed.login || {}),
      },
    };
  } catch {}
}

function parseJsonSafe(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function decodeName(raw = "") {
  return decodeURIComponent(raw).replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
}

async function parseWorkbook(uploadPath) {
  const child = spawn(pythonBin, [parserScript, uploadPath], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Excel 解析失败");
  }
  return JSON.parse(stdout);
}

function createJob(importRecord, login) {
  const job = {
    id: randomUUID(),
    importId: importRecord.id,
    config: importRecord.parsed.config,
    login,
    status: "queued",
    progress: 0,
    stage: "等待开始",
    logs: [],
    captures: [],
    events: [],
    listeners: new Set(),
    createdAt: new Date().toISOString(),
  };
  state.jobs.set(job.id, job);
  return job;
}

function pushEvent(job, evt) {
  job.events.push(evt);
  if (evt.type === "log") {
    job.logs.unshift({
      level: evt.level || "",
      message: evt.message,
      ts: evt.ts,
    });
  }
  if (evt.type === "stage") {
    job.stage = evt.stage;
    job.progress = evt.percent;
  }
  if (evt.type === "status") {
    job.status = evt.status;
    job.statusMessage = evt.message;
  }
  if (evt.type === "captures") {
    job.captures = [...job.captures, ...(evt.captures || [])];
  }
  if (evt.type === "done") {
    job.status = "done";
  }
  if (evt.type === "error") {
    job.status = "error";
    job.statusMessage = evt.message;
    job.logs.unshift({
      level: "warn",
      message: evt.message,
      ts: evt.ts,
    });
  }

  for (const send of job.listeners) {
    send(evt);
  }
}

async function handleImport(req, res) {
  const filename = decodeName(new URL(req.url, "http://localhost").searchParams.get("filename") || "需求单.xlsx");
  const body = await readBody(req);
  if (!body.length) {
    return badRequest(res, "未收到文件内容");
  }

  const importId = randomUUID();
  const uploadPath = path.join(uploadsDir, `${importId}-${filename}`);
  await fs.writeFile(uploadPath, body);
  const parsed = await parseWorkbook(uploadPath);
  const record = { id: importId, filename, uploadPath, parsed, createdAt: new Date().toISOString() };
  state.imports.set(importId, record);
  json(res, 200, { uploadId: importId, ...parsed, filename });
}

async function handleCreateJob(req, res) {
  const payload = parseJsonSafe(await readBody(req));
  if (!payload?.uploadId) {
    return badRequest(res, "缺少 uploadId");
  }
  const importRecord = state.imports.get(payload.uploadId);
  if (!importRecord) {
    return badRequest(res, "需求单记录不存在，请重新导入。");
  }
  const config = importRecord.parsed?.config || {};
  if (!config.examName || !config.startTimeDisplay || !config.endTimeDisplay) {
    return badRequest(res, "需求单缺少考试名称或考试时间，请重新导入并检查表格。");
  }

  const login = {
    ...state.settings.login,
    ...(payload.login || {}),
  };
  if (!login.url || !login.username || !login.password) {
    return badRequest(res, "请先填写并保存后台登录配置。");
  }

  const job = createJob(importRecord, login);
  pushEvent(job, { type: "status", status: "queued", message: "任务已创建", ts: new Date().toISOString() });

  runEasyExamJob({
    job,
    runtimeDir,
    emit(evt) {
      pushEvent(job, evt);
    },
  }).catch((error) => {
    pushEvent(job, {
      type: "error",
      ts: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
  });

  json(res, 200, { jobId: job.id });
}

async function handleGetSettings(_req, res) {
  json(res, 200, state.settings);
}

async function handleSaveSettings(req, res) {
  const payload = parseJsonSafe(await readBody(req));
  const nextSettings = {
    ...state.settings,
    login: {
      ...state.settings.login,
      ...(payload?.login || {}),
    },
  };
  state.settings = nextSettings;
  await fs.writeFile(settingsPath, JSON.stringify(nextSettings, null, 2), "utf8");
  json(res, 200, { ok: true, settings: state.settings });
}

function handleJobState(job, res) {
  json(res, 200, {
    id: job.id,
    status: job.status,
    statusMessage: job.statusMessage || "",
    progress: job.progress,
    stage: job.stage,
    logs: job.logs,
    captures: job.captures,
  });
}

function handleEvents(job, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("\n");

  const send = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  job.events.forEach(send);
  job.listeners.add(send);

  req.on("close", () => {
    job.listeners.delete(send);
  });
}

async function handleArtifact(urlPath, res) {
  const [, , jobId, fileName] = urlPath.split("/");
  const filePath = path.join(runtimeDir, "shots", jobId, fileName);
  try {
    await fs.access(filePath);
  } catch {
    return notFound(res);
  }
  res.writeHead(200, { "Content-Type": "image/png" });
  createReadStream(filePath).pipe(res);
}

async function buildHtml() {
  const html = await fs.readFile(webFile, "utf8");
  return html.replace(
    "</body>",
    `\n<script>window.EASY_EXAM_RUNTIME={apiBase:"",appVersion:"1.0.0"};</script>\n</body>`,
  );
}

async function requestHandler(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/easy_exam_automation.html")) {
      return sendHtml(res, await buildHtml());
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      return await handleGetSettings(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      return await handleSaveSettings(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      return await handleImport(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      return await handleCreateJob(req, res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/events")) {
      const jobId = url.pathname.split("/")[3];
      const job = state.jobs.get(jobId);
      return job ? handleEvents(job, req, res) : notFound(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const jobId = url.pathname.split("/")[3];
      const job = state.jobs.get(jobId);
      return job ? handleJobState(job, res) : notFound(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      return await handleArtifact(url.pathname, res);
    }
    notFound(res);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

await ensureRuntime();

const port = Number(process.env.PORT || 8765);
const server = http.createServer(requestHandler);
server.listen(port, "127.0.0.1", () => {
  console.log(`Easy Exam server running at http://127.0.0.1:${port}`);
});
