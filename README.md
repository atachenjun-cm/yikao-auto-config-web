# 易考 AI 自动化初版

本项目用于根据易考考试需求单，自动完成易考后台的考试与试考配置。

## 功能

- 导入 Excel 需求单并解析基础信息、个人信息、考试配置、科目信息。
- 通过本地网页展示导入结果、执行进度、执行日志。
- 使用 Playwright 接管浏览器，自动完成易考后台配置流程。
- 支持欢迎语、考前等待提示、考试承诺书的高级编辑器源代码写入。
- 支持主考试创建完成后自动创建试考。

## 运行环境

- Node.js 18+
- Python 3.10+
- 可访问易考后台的 Chrome 浏览器

## 快速开始

1. 克隆项目

```bash
git clone https://github.com/atachenjun-cm/yikao-auto-config-web.git
cd yikao-auto-config-web
```

2. 安装依赖

```bash
npm install
python3 -m pip install -r requirements.txt
```

3. 准备环境变量

```bash
cp .env.example .env
```

按需修改：

- `PORT`：本地服务端口，默认 `8765`
- `CODEX_PYTHON`：Python 3 可执行文件路径

4. 启动服务

```bash
npm start
```

5. 打开页面

```text
http://127.0.0.1:8765
```

## 使用方式

1. 在网页中填写易考后台登录地址、账号、密码。
2. 导入需求单 Excel。
3. 点击执行自动配置。
4. 查看执行日志和配置结果。

## 项目结构

```text
server/
  easy_exam_server.mjs      本地 Web 服务
  easy_exam_runner.mjs      Playwright 自动化主流程
  exam_request_parser.py    Excel 需求单解析
  fill_subject_template.py  科目导入模板填充
```

## 安全说明

- `.easy_exam_runtime/` 保存本地运行时登录配置、上传文件、截图，不会提交到 GitHub。
- `.env` 不提交到 GitHub，请只在本地使用。
- 请不要把账号密码、Cookie、Token 写入源码或提交到仓库。
