import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("/Users/chen/Desktop/ai 易考/outputs/exam_request/易考新建考试需求单.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);

const blank = await workbook.inspect({
  kind: "table",
  range: "业务需求单!A1:F18",
  include: "values",
  tableMaxRows: 20,
  tableMaxCols: 6,
});
console.log(blank.ndjson);

const example = await workbook.inspect({
  kind: "table",
  range: "填写示例!A1:D17",
  include: "values",
  tableMaxRows: 20,
  tableMaxCols: 4,
});
console.log(example.ndjson);

await workbook.render({ sheetName: "业务需求单", range: "A1:F18", scale: 1 });
await workbook.render({ sheetName: "填写示例", range: "A1:D17", scale: 1 });
