import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "/Users/chen/Desktop/ai 易考/outputs/exam_request";
const outputPath = `${outputDir}/易考新建考试需求单.xlsx`;

const headers = ["序号", "业务确认项", "是否必填", "填写内容", "填写示例", "说明"];
const rows = [
  [1, "考试名称", "是", "", "一级综合能力测试一（会计学与财务分析基础+Python语言基础+大数据技术原理及应用）", "后台展示的考试名称"],
  [2, "考试开始时间", "是", "", "2026-07-18 09:00", "按北京时间填写，格式：YYYY-MM-DD HH:mm"],
  [3, "考试结束时间", "是", "", "2026-07-18 11:30", "按北京时间填写，必须晚于开始时间"],
  [4, "提前登录时间", "是", "", "开考前 30 分钟", "考生可提前进入系统确认信息、拍照等"],
  [5, "限制迟到时间", "是", "", "开考后 30 分钟", "超过该时间后不允许考生入场"],
  [6, "交卷限制", "否", "", "不限制", "如需限制，请填写“开考后 X 分钟至 Y 分钟不允许手动交卷”"],
  [7, "试卷名称", "是", "", "20260718_01CGFT一级（综合一）会计学与财务分析基础+Python语言基础+大数据技术", "用于脚本搜索并绑定试卷"],
  [8, "考生来源", "是", "", "绑定报名项目", "可填：绑定报名项目 / 导入考生名单 / 暂不绑定"],
  [9, "报名项目或名单文件", "按考生来源填写", "", "2026年7月CGFT一级考试报名", "选择“绑定报名项目”时填报名项目名称；选择“导入考生名单”时提供名单文件"],
  [10, "是否交卷后显示成绩", "是", "", "否", "可填：是 / 否"],
  [11, "是否交卷后显示答案解析", "是", "", "否", "可填：是 / 否"],
  [12, "是否沿用同类考试防作弊配置", "是", "", "是", "如填“否”，需另行说明摄像头、人脸识别、切屏限制、全屏考试等要求"],
  [13, "特殊配置说明", "否", "", "沿用 2026/04/18 一级综合一考试配置", "没有特殊要求可填“无”"],
  [14, "是否允许脚本最终创建考试", "是", "", "否，先停在确认页", "可填：是，直接创建 / 否，停在确认页人工检查"],
];

const exampleRows = rows.map((row) => [row[0], row[1], row[4], row[5]]);

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("业务需求单");
const exampleSheet = workbook.worksheets.add("填写示例");

sheet.getRange("A1:F1").values = [["易考新建考试需求单", null, null, null, null, null]];
sheet.getRange("A2:F2").values = [["业务方只需填写或确认下表内容。未列出的后台配置项默认沿用历史同类考试配置或系统默认配置。", null, null, null, null, null]];
sheet.getRange("A4:F4").values = [headers];
sheet.getRange(`A5:F${4 + rows.length}`).values = rows;

exampleSheet.getRange("A1:D1").values = [["易考新建考试需求单 - 填写示例", null, null, null]];
exampleSheet.getRange("A3:D3").values = [["序号", "业务确认项", "填写内容", "说明"]];
exampleSheet.getRange(`A4:D${3 + exampleRows.length}`).values = exampleRows;

function styleTemplate(ws, lastCol, lastRow) {
  const title = ws.getRange(`A1:${lastCol}1`);
  title.merge();
  title.format.font = { bold: true, size: 16, color: "#1F2937" };
  title.format.fill = "#EAF2FF";
  title.format.horizontalAlignment = "center";
  title.format.verticalAlignment = "middle";

  const header = ws.getRange(`A3:${lastCol}3`);
  header.format.font = { bold: true, color: "#FFFFFF" };
  header.format.fill = "#2563EB";
  header.format.horizontalAlignment = "center";
  header.format.verticalAlignment = "middle";
  header.format.wrapText = true;

  const body = ws.getRange(`A4:${lastCol}${lastRow}`);
  body.format.verticalAlignment = "top";
  body.format.wrapText = true;
  body.format.borders = { preset: "all", style: "thin", color: "#D1D5DB" };
}

styleTemplate(sheet, "F", 4 + rows.length);
sheet.getRange("A2:F2").merge();
sheet.getRange("A2:F2").format.fill = "#F9FAFB";
sheet.getRange("A2:F2").format.font = { color: "#4B5563" };
sheet.getRange("A2:F2").format.wrapText = true;
sheet.getRange("D5:D18").format.fill = "#FFF7ED";
sheet.getRange("D5:D18").format.verticalAlignment = "top";
sheet.getRange("D5:D18").format.wrapText = true;

styleTemplate(exampleSheet, "D", 3 + exampleRows.length);
sheet.getRange("A:A").format.columnWidthPx = 58;
sheet.getRange("B:B").format.columnWidthPx = 210;
sheet.getRange("C:C").format.columnWidthPx = 140;
sheet.getRange("D:D").format.columnWidthPx = 240;
sheet.getRange("E:E").format.columnWidthPx = 360;
sheet.getRange("F:F").format.columnWidthPx = 420;
sheet.getRange("1:18").format.rowHeightPx = 38;
sheet.getRange("1:1").format.rowHeightPx = 44;
sheet.getRange("2:2").format.rowHeightPx = 40;

exampleSheet.getRange("A:A").format.columnWidthPx = 58;
exampleSheet.getRange("B:B").format.columnWidthPx = 220;
exampleSheet.getRange("C:C").format.columnWidthPx = 430;
exampleSheet.getRange("D:D").format.columnWidthPx = 460;
exampleSheet.getRange("1:17").format.rowHeightPx = 38;
exampleSheet.getRange("1:1").format.rowHeightPx = 44;

await fs.mkdir(outputDir, { recursive: true });
const file = await SpreadsheetFile.exportXlsx(workbook);
await file.save(outputPath);
console.log(outputPath);
