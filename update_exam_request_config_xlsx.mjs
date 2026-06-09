import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "/Users/chen/Desktop/ai 易考/outputs/exam_request";
const outputPath = `${outputDir}/易考新建考试需求单.xlsx`;

const input = await FileBlob.load(outputPath);
const existingWorkbook = await SpreadsheetFile.importXlsx(input);
const current = await existingWorkbook.inspect({
  kind: "table",
  range: "业务需求单!A1:F80",
  include: "values",
  tableMaxRows: 100,
  tableMaxCols: 7,
});

const rowsJson = current.ndjson
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((item) => item.kind === "table");

const valueByItem = new Map();
for (const row of rowsJson.values ?? []) {
  const item = row?.[1];
  if (item) valueByItem.set(String(item).trim(), row[3] ?? "");
}

const get = (name, fallback = "") => valueByItem.get(name) ?? fallback;

const headers = ["阶段", "序号", "配置项", "需业务确认", "填写内容", "可选值/填写示例", "脚本配置说明"];
const rows = [
  ["基本信息", 1, "考试名称", "是", get("考试名称"), "测试", "后台考试名称"],
  ["基本信息", 2, "考试开始时间", "是", get("考试开始时间"), "2026-06-01 09:00", "按易考系统时区 UTC+08:00 填写"],
  ["基本信息", 3, "考试结束时间", "是", get("考试结束时间"), "2026-06-02 10:00", "必须晚于开始时间"],
  ["基本信息", 4, "提前登录时间", "是", get("提前登录时间"), "30", "单位：分钟；开考前允许登录"],
  ["基本信息", 5, "限制迟到时间", "是", get("限制迟到时间"), "30", "单位：分钟；开考后超过该时间不允许入场"],
  ["基本信息", 6, "交卷限制", "否", get("交卷限制"), "不限制 / 开考后 X 分钟至 Y 分钟", "为空或“不限制”时不勾选"],
  ["基本信息", 7, "试卷扣时规则", "是", get("试卷扣时规则", get("试卷扣时规则 ")), "不扣时 / 迟到扣时 / 迟到及离开扣时", "对应基本信息页的试卷扣时规则"],
  ["基本信息", 8, "场次类型", "是", get("场次类型"), "考试 / 面试 / 测评 / 自定义", "如自定义需在备注写名称"],
  ["基本信息", 9, "考试地址", "否", get("考试地址", get("考试地址 ")), "独立考试地址 / 统一考试地址", "默认独立考试地址"],
  ["基本信息", 10, "交卷后跳转", "否", get("交卷后跳转"), "不跳转 / 返回登录首页 / 自定义URL", "自定义 URL 需另填跳转地址"],
  ["基本信息", 11, "欢迎语", "否", get("欢迎语"), "考生你好", "展示给考生的欢迎语"],
  ["选择试卷", 12, "是否跳过试卷设置", "是", "是", "是 / 否", "是：继续无试卷创建流程；否：需填写试卷名称"],
  ["选择试卷", 13, "试卷名称", "按是否跳过填写", "", "20260718_01CGFT...", "不跳过时用于脚本搜索并绑定试卷"],
  ["个人信息", 14, "允许编辑字段", "是", "无", "无 / 姓名,邮箱,手机号码...", "本次已按要求全部取消"],
  ["个人信息", 15, "考生可见字段", "是", "姓名,身份证号", "姓名,身份证号,准考证号", "准考证号为系统字段，不支持作为自定义字段重复添加"],
  ["个人信息", 16, "必填字段", "是", "无", "无 / 姓名,身份证号...", "本次已按要求全部取消"],
  ["个人信息", 17, "新增个人信息字段", "否", "不新增", "字段名；字段类型", "准考证号为系统字段，页面提示“系统字段不可添加”"],
  ["考试配置-开考前", 18, "即报即考", "是", "否", "是 / 否", "允许考生自主注册报名后马上开始考试"],
  ["考试配置-开考前", 19, "注册验证", "按即报即考填写", "否", "是 / 否", "即报即考开启时可验证手机号或邮箱唯一性"],
  ["考试配置-开考前", 20, "限定登录位置", "否", "否", "是 / 否", "按 IP 限制考生登录位置"],
  ["考试配置-开考前", 21, "允许登录 IP 地址", "按限定登录位置填写", "", "58.246.11.82, x.x.x.x", "多个 IP 用英文逗号分隔，最多 5 个"],
  ["考试配置-开考前", 22, "练习模式", "是", "否", "是 / 否", "开启后考生每题作答后可看答案和解析"],
  ["考试配置-开考前", 23, "考试承诺书", "否", "是", "是 / 否", "考生登录后需同意承诺书方可进入考试"],
  ["考试配置-开考前", 24, "考试承诺书内容", "按考试承诺书填写", "测试考试", "为保证考试的公平性和严肃性...", "开启考试承诺书时填写"],
  ["考试配置-开考前", 25, "资料审核", "否", "否", "是 / 否", "考生登录后拍摄上传资料，审核通过后开始考试"],
  ["考试配置-开考前", 26, "证件照审核", "按资料审核填写", "否", "是 / 否", "默认正反面两张；需资料审核开启"],
  ["考试配置-开考前", 27, "证件照拍摄说明", "按证件照审核填写", "", "请按要求拍摄证件照", "考生可见说明"],
  ["考试配置-开考前", 28, "环境照审核", "按资料审核填写", "否", "是 / 否", "默认正反面两张；需资料审核开启"],
  ["考试配置-开考前", 29, "环境照拍摄说明", "按环境照审核填写", "", "请按要求拍摄考试环境", "考生可见说明"],
  ["考试配置-考试中", 30, "视频监控", "是", "是", "是 / 否", "实时监控考试视频并随机抓拍"],
  ["考试配置-考试中", 31, "视频录制", "按视频监控填写", "是", "是 / 否", "视频监控开启后可配置录制"],
  ["考试配置-考试中", 32, "登录验证", "按视频监控填写", "否", "是 / 否", "登录考试时校验面部特征"],
  ["考试配置-考试中", 33, "作弊侦测", "按视频监控填写", "否", "是 / 否", "考试过程中侦测异常行为"],
  ["考试配置-考试中", 34, "视线追踪", "按视频监控填写", "否", "是 / 否", "考试过程中检测视线方向"],
  ["考试配置-考试中", 35, "鹰眼监控", "是", "是", "是 / 否", "使用手机等外设监控考生视频"],
  ["考试配置-考试中", 36, "无干扰模式", "按鹰眼监控填写", "否", "是 / 否", "鹰眼监控开启后可配置"],
  ["考试配置-考试中", 37, "辅鹰眼监控", "按鹰眼监控填写", "否", "是 / 否", "开启后需使用 2 个设备进行监控"],
  ["考试配置-考试中", 38, "主鹰眼监考要求", "按鹰眼监控填写", "", "手机放置于侧后方距离 1.5 米以上...", "考生可见监考要求"],
  ["考试配置-考试中", 39, "辅鹰眼监考要求", "按辅鹰眼填写", "", "手机放置于正侧方 1.5 米...", "考生可见监考要求"],
  ["考试配置-考试中", 40, "桌面监控", "是", "否", "是 / 否", "实时监控考生答题设备画面"],
  ["考试配置-考试中", 41, "桌面监控视频录制", "按桌面监控填写", "否", "是 / 否", "桌面监控开启后可配置录制"],
  ["考试配置-考试中", 42, "锁定考试-限制登录次数", "否", "是", "是 / 否", "记录登录考试次数并限制登录"],
  ["考试配置-考试中", 43, "允许登录次数", "按锁定考试填写", "5", "1", "开启限制登录次数时填写"],
  ["考试配置-考试中", 44, "网页考试离开限制", "否", "否", "是 / 否", "记录离开考试页面次数"],
  ["考试配置-考试中", 45, "离开页面计时秒数", "按网页考试填写", "", "10", "离开超过 X 秒计为离开一次"],
  ["考试配置-考试中", 46, "允许离开次数", "按网页考试填写", "", "3", "超过次数系统终止考试并交卷"],
  ["考试配置-考试中", 47, "客户端考试", "否", "是", "是 / 否", "允许考生使用客户端考试"],
  ["考试配置-考试中", 48, "允许客户端版本", "按客户端考试填写", "电脑端", "电脑端;移动端", "可填：电脑端 / 移动端 / 电脑端;移动端"],
  ["考试配置-考试中", 49, "独占网络", "按客户端考试填写", "是", "是 / 否", "考试时关闭除客户端外其他用网软件"],
  ["考试配置-考试中", 50, "禁用蓝牙", "按客户端考试填写", "否", "是 / 否", "禁止连接蓝牙设备"],
  ["考试配置-考试中", 51, "禁用智能输入法", "按客户端考试填写", "否", "是 / 否", "开启智能输入法将强制退出考试"],
  ["考试配置-考试中", 52, "答题水印", "否", "是", "是 / 否", "作答页面用场次唯一编号和准考证号作为背景水印"],
  ["考试配置-考试中", 53, "禁止复制", "否", "是", "是 / 否", "禁止复制试卷内容"],
  ["考试配置-考试中", 54, "显示分值", "否", "否", "是 / 否", "试题分值是否向考生可见"],
  ["考试配置-考试后", 55, "查看成绩", "是", "否", "是 / 否", "允许考生答题结束后查看考试结果"],
  ["考试配置-考试后", 56, "查看试卷解析", "按查看成绩填写", "否", "是 / 否", "需开启查看成绩"],
  ["考试配置-考试后", 57, "强收禁查", "按查看成绩填写", "否", "是 / 否", "人工强制收卷后禁止查看成绩"],
  ["考试配置-考试后", 58, "不满意重做", "否", "否", "是 / 否", "允许考生重新答题"],
  ["考试配置-考试后", 59, "最多重复答题次数", "按不满意重做填写", "", "1", "开启重做时填写"],
  ["考试配置-考试后", 60, "保留最高分", "按不满意重做填写", "否", "是 / 否", "多次答题取最高分"],
  ["考试配置-考试后", 61, "保留答案", "按不满意重做填写", "否", "是 / 否", "重新答题时保留上次答案"],
  ["考试配置-考试后", 62, "错题练习", "按不满意重做填写", "否", "是 / 否", "对最近一次提交答卷中的错题作答"],
  ["考试配置-考试后", 63, "强收禁止重做", "按不满意重做填写", "否", "是 / 否", "被强制收卷后禁止重新答题"],
  ["考试配置-考试后", 64, "分数线", "否", "否", "是 / 否", "开启后配置通过分数"],
  ["考试配置-考试后", 65, "通过分数", "按分数线填写", "", "60", "成绩超过该分数算通过"],
  ["考试配置-考试后", 66, "人工判分", "否", "否", "是 / 否", "主观题需要人工判分时开启"],
  ["考试配置-考试后", 67, "成绩通知", "否", "否", "是 / 否", "考生完成考试后发送成绩通知邮件"],
  ["考试配置-考试后", 68, "成绩通知邮箱", "按成绩通知填写", "", "a@example.com;b@example.com", "多人用英文分号分隔"],
  ["完成", 69, "是否允许脚本最终创建考试", "是", "否，停在确认页人工检查", "是，直接创建 / 否，停在确认页人工检查", "防止未经确认直接创建考试"],
  ["完成", 70, "特殊配置说明", "否", "", "无 / 沿用某场历史考试配置", "业务方可补充未覆盖的特殊要求"],
];

const exampleRows = rows.map(([stage, seq, item, required, , example, note]) => [
  stage,
  seq,
  item,
  required,
  example,
  note,
]);

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("业务需求单");
const exampleSheet = workbook.worksheets.add("填写示例");
const notesSheet = workbook.worksheets.add("脚本读取说明");

sheet.getRange("A1:G1").values = [["易考新建考试需求单", null, null, null, null, null, null]];
sheet.getRange("A2:G2").values = [[
  "业务方只需填写“填写内容”列。第 4 步考试配置项已补全；未填写项脚本按“否/系统默认”处理，除非说明列要求按条件填写。",
  null,
  null,
  null,
  null,
  null,
  null,
]];
sheet.getRange("A4:G4").values = [headers];
sheet.getRange(`A5:G${4 + rows.length}`).values = rows;

exampleSheet.getRange("A1:F1").values = [["易考新建考试需求单 - 填写示例", null, null, null, null, null]];
exampleSheet.getRange("A3:F3").values = [["阶段", "序号", "配置项", "需业务确认", "填写示例", "说明"]];
exampleSheet.getRange(`A4:F${3 + exampleRows.length}`).values = exampleRows;

notesSheet.getRange("A1:D1").values = [["脚本读取说明", null, null, null]];
notesSheet.getRange("A3:D3").values = [["规则", "说明", "示例", "处理方式"]];
notesSheet.getRange("A4:D10").values = [
  ["时间", "按易考系统时区 UTC+08:00 解析", "2026-06-01 09:00", "脚本写入日期时间控件"],
  ["布尔值", "是/否、开启/关闭均可识别", "否", "脚本勾选或取消对应开关"],
  ["条件项", "“按某项填写”的字段仅在前置开关为是时生效", "允许登录次数", "前置开关为否时忽略"],
  ["空值", "非必填项为空时按系统默认或否处理", "", "不主动开启该配置"],
  ["个人信息", "允许编辑字段、必填字段可填无或逗号分隔字段名", "姓名,身份证号", "脚本逐项勾选"],
  ["准考证号", "易考提示为系统字段，不支持自定义重复添加", "准考证号", "如页面出现内置项再勾选可见"],
  ["最终创建", "默认停在确认页，避免误创建", "否，停在确认页人工检查", "需明确允许才提交创建"],
];

function styleHeader(ws, lastCol) {
  const title = ws.getRange(`A1:${lastCol}1`);
  title.merge();
  title.format.font = { bold: true, size: 16, color: "#1F2937" };
  title.format.fill = "#EAF2FF";
  title.format.horizontalAlignment = "center";
  title.format.verticalAlignment = "middle";
  ws.getRange(`A2:${lastCol}2`).merge();
  ws.getRange(`A2:${lastCol}2`).format.fill = "#F9FAFB";
  ws.getRange(`A2:${lastCol}2`).format.font = { color: "#4B5563" };
  ws.getRange(`A2:${lastCol}2`).format.wrapText = true;
}

function styleTable(ws, headerRange, bodyRange) {
  const header = ws.getRange(headerRange);
  header.format.font = { bold: true, color: "#FFFFFF" };
  header.format.fill = "#2563EB";
  header.format.horizontalAlignment = "center";
  header.format.verticalAlignment = "middle";
  header.format.wrapText = true;

  const body = ws.getRange(bodyRange);
  body.format.verticalAlignment = "top";
  body.format.wrapText = true;
  body.format.borders = { preset: "all", style: "thin", color: "#D1D5DB" };
}

styleHeader(sheet, "G");
styleTable(sheet, "A4:G4", `A5:G${4 + rows.length}`);
sheet.getRange(`E5:E${4 + rows.length}`).format.fill = "#FFF7ED";
sheet.getRange(`E5:E${4 + rows.length}`).format.wrapText = true;
sheet.getRange("A:A").format.columnWidthPx = 140;
sheet.getRange("B:B").format.columnWidthPx = 58;
sheet.getRange("C:C").format.columnWidthPx = 220;
sheet.getRange("D:D").format.columnWidthPx = 120;
sheet.getRange("E:E").format.columnWidthPx = 260;
sheet.getRange("F:F").format.columnWidthPx = 280;
sheet.getRange("G:G").format.columnWidthPx = 360;
sheet.getRange(`1:${4 + rows.length}`).format.rowHeightPx = 34;
sheet.getRange("1:1").format.rowHeightPx = 44;
sheet.getRange("2:2").format.rowHeightPx = 48;
sheet.getRange("4:4").format.rowHeightPx = 38;

styleHeader(exampleSheet, "F");
styleTable(exampleSheet, "A3:F3", `A4:F${3 + exampleRows.length}`);
exampleSheet.getRange("A:A").format.columnWidthPx = 140;
exampleSheet.getRange("B:B").format.columnWidthPx = 58;
exampleSheet.getRange("C:C").format.columnWidthPx = 220;
exampleSheet.getRange("D:D").format.columnWidthPx = 120;
exampleSheet.getRange("E:E").format.columnWidthPx = 260;
exampleSheet.getRange("F:F").format.columnWidthPx = 360;
exampleSheet.getRange(`1:${3 + exampleRows.length}`).format.rowHeightPx = 34;
exampleSheet.getRange("1:1").format.rowHeightPx = 44;

styleHeader(notesSheet, "D");
styleTable(notesSheet, "A3:D3", "A4:D10");
notesSheet.getRange("A:A").format.columnWidthPx = 130;
notesSheet.getRange("B:B").format.columnWidthPx = 360;
notesSheet.getRange("C:C").format.columnWidthPx = 240;
notesSheet.getRange("D:D").format.columnWidthPx = 340;
notesSheet.getRange("1:10").format.rowHeightPx = 40;
notesSheet.getRange("1:1").format.rowHeightPx = 44;

await workbook.render({ sheetName: "业务需求单", range: "A1:G30", scale: 1 });
await workbook.render({ sheetName: "填写示例", range: "A1:F30", scale: 1 });
await workbook.render({ sheetName: "脚本读取说明", range: "A1:D10", scale: 1 });

await fs.mkdir(outputDir, { recursive: true });
const file = await SpreadsheetFile.exportXlsx(workbook);
await file.save(outputPath);
console.log(outputPath);
