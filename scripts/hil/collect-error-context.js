#!/usr/bin/env node
/**
 * HIL-P1-008 失败上下文归集
 * 从 ATE 测试结果、串口日志、Modbus 交易日志中归集失败上下文
 * 输出 logs/last_test_error.json 供 AI 智能体分析
 *
 * Usage: node scripts/hil/collect-error-context.js [--config path/to/hil.config.json] --session <sessionId>
 */

const fs = require('fs');
const path = require('path');

// ── 配置加载 ──────────────────────────────────────────────
function loadConfig() {
  const configArg = process.argv.find(a => a.startsWith('--config='));
  const configPath = configArg
    ? configArg.split('=')[1]
    : path.join(__dirname, '../../config/hil.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[Collect] 配置文件不存在: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ── 读取串口日志最后 N 行 ─────────────────────────────────
function readLogTail(filePath, lines = 50) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n').filter(Boolean);
  return allLines.slice(-lines);
}

// ── 读取串口日志中某时间点前后的内容 ──────────────────────
function readLogAroundTime(filePath, targetTime, windowSec = 5) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n').filter(Boolean);

  const target = new Date(targetTime).getTime();
  const windowMs = windowSec * 1000;

  return allLines.filter(line => {
    // 提取时间戳 [2026-06-16T10:04:55.000Z]
    const match = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
    if (!match) return false;
    const lineTime = new Date(match[1]).getTime();
    return Math.abs(lineTime - target) <= windowMs;
  });
}

// ── 主流程 ────────────────────────────────────────────────
function main() {
  const config = loadConfig();

  // 解析命令行参数
  const sessionArg = process.argv.find(a => a.startsWith('--session='));
  const caseIdArg = process.argv.find(a => a.startsWith('--case='));
  const failedAtArg = process.argv.find(a => a.startsWith('--failedAt='));
  const summaryArg = process.argv.find(a => a.startsWith('--summary='));
  const expectedArg = process.argv.find(a => a.startsWith('--expected='));
  const actualArg = process.argv.find(a => a.startsWith('--actual='));

  const sessionId = sessionArg ? sessionArg.split('=')[1] : `hil-${Date.now()}`;
  const caseId = caseIdArg ? caseIdArg.split('=')[1] : 'UNKNOWN';
  const failedAt = failedAtArg ? failedAtArg.split('=')[1] : new Date().toISOString();
  const summary = summaryArg ? summaryArg.split('=')[1] : 'Test case failed';
  const expected = expectedArg ? JSON.parse(expectedArg.split('=')[1]) : {};
  const actual = actualArg ? JSON.parse(actualArg.split('=')[1]) : {};

  console.log(`[Collect] 归集失败上下文...`);
  console.log(`[Collect] Session: ${sessionId}`);
  console.log(`[Collect] Case: ${caseId}`);

  // 读取各类日志
  const logFile = path.resolve(__dirname, '../..', config.serial?.logFile || 'logs/firmware_runtime.log');
  const modbusTraceFile = path.resolve(__dirname, '../../logs/modbus_trace.log');

  const firmwareLogExcerpt = readLogAroundTime(logFile, failedAt, 5);
  const recentLog = readLogTail(logFile, 20);

  // 构建失败上下文 JSON
  const errorContext = {
    sessionId,
    failedAt,
    caseId,
    stage: 'unknown',
    summary,
    expected,
    actual,
    simulator: {
      normalStageValue: expected,
      abnormalMode: 'unknown',
      lastRequestHex: null,
      lastResponseHex: null
    },
    controller: {
      ip: config.controller?.ip || 'unknown',
      registers: actual
    },
    logs: {
      firmwareLogFile: logFile,
      firmwareLogExcerpt: firmwareLogExcerpt.length > 0 ? firmwareLogExcerpt : recentLog,
      modbusTraceFile: modbusTraceFile
    },
    artifacts: {
      reportFile: `reports/${sessionId}.json`,
      configFile: 'config/hil.config.json'
    },
    suggestedFocus: []
  };

  // 输出目录
  const outputDir = path.resolve(__dirname, '../../logs');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 写入 last_test_error.json
  const outputPath = path.join(outputDir, 'last_test_error.json');
  fs.writeFileSync(outputPath, JSON.stringify(errorContext, null, 2), 'utf-8');
  console.log(`[Collect] 已生成失败上下文: ${outputPath}`);

  // 同时写入带时间戳的归档副本
  const archivePath = path.join(outputDir, `last_test_error_${sessionId}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(errorContext, null, 2), 'utf-8');
  console.log(`[Collect] 已归档: ${archivePath}`);

  // 输出结果 JSON
  const result = {
    success: true,
    outputPath,
    archivePath,
    sessionId,
    caseId,
    firmwareLogLines: firmwareLogExcerpt.length,
    timestamp: new Date().toISOString()
  };
  console.log(`[Collect] RESULT_JSON:${JSON.stringify(result)}`);
}

main();
