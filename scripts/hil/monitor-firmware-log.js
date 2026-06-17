#!/usr/bin/env node
/**
 * HIL-P1-004 固件串口日志监听
 * 监听调试串口并归档运行日志，检测关键错误事件
 *
 * Usage: node scripts/hil/monitor-firmware-log.js [--config path/to/hil.config.json] [--duration 30]
 *
 * --duration: 监听时长（秒），默认持续监听直到手动停止或检测到严重错误
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const fs = require('fs');
const path = require('path');

// ── 配置加载 ──────────────────────────────────────────────
function loadConfig() {
  const configArg = process.argv.find(a => a.startsWith('--config='));
  const configPath = configArg
    ? configArg.split('=')[1]
    : path.join(__dirname, '../../config/hil.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[Monitor] 配置文件不存在: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ── 主流程 ────────────────────────────────────────────────
function main() {
  const config = loadConfig();
  const { serial } = config;

  const portPath = serial.firmwareLogPort;
  const baudRate = serial.baudRate || 115200;
  const logFilePath = path.resolve(__dirname, '../..', serial.logFile || 'logs/firmware_runtime.log');
  const logKeywords = serial.logKeywords || ['[Assert]', 'HardFault', 'stack overflow', 'sensor_acquire timeout'];

  // 解析命令行参数
  const durationArg = process.argv.find(a => a.startsWith('--duration='));
  const durationSec = durationArg ? parseInt(durationArg.split('=')[1]) : null;

  // 确保日志目录存在
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  console.log(`[Monitor] 启动串口日志监听...`);
  console.log(`[Monitor] 串口: ${portPath} @ ${baudRate} bps`);
  console.log(`[Monitor] 日志文件: ${logFilePath}`);
  console.log(`[Monitor] 关键字: ${logKeywords.join(', ')}`);
  if (durationSec) {
    console.log(`[Monitor] 监听时长: ${durationSec} 秒`);
  }

  // 初始化日志输出流（追加写入模式）
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  let port;
  let errorCount = 0;
  let lineCount = 0;
  let criticalError = null;

  try {
    port = new SerialPort({
      path: portPath,
      baudRate: baudRate,
      autoOpen: false
    });

    port.open((err) => {
      if (err) {
        console.error(`[Monitor] 无法打开串口 ${portPath}: ${err.message}`);
        console.error('[Monitor] 提示: 请确认串口未被其他程序占用（如 SSCOM, Xshell）');
        const result = {
          success: false,
          error: err.message,
          port: portPath,
          timestamp: new Date().toISOString()
        };
        console.log(`[Monitor] RESULT_JSON:${JSON.stringify(result)}`);
        process.exit(1);
      }

      console.log(`[Monitor] 串口已打开，开始监听...`);

      // 构建按行解析器管道
      const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      parser.on('data', (line) => {
        lineCount++;
        const timestamp = new Date().toISOString();
        const formattedLine = `[${timestamp}] [MCU] ${line}\n`;

        // 实时持久化日志文件
        logStream.write(formattedLine);

        // 控制台淡灰色输出
        process.stdout.write(`\x1b[90m[MCU Log] ${line}\x1b[0m\n`);

        // 关键事件检测
        const lowerLine = line.toLowerCase();
        for (const keyword of logKeywords) {
          if (lowerLine.includes(keyword.toLowerCase())) {
            errorCount++;
            console.error(`🚨 [Monitor] 检测到关键字 "${keyword}": ${line}`);

            // 检测严重错误
            if (lowerLine.includes('hardfault') || lowerLine.includes('hard fault') ||
                lowerLine.includes('assert failed') || lowerLine.includes('stack overflow')) {
              criticalError = { keyword, line, timestamp };
              console.error(`🚨 [Monitor] 严重错误! 终止监听。`);
              cleanup(2); // 退出码 2 表示检测到严重错误
              return;
            }
          }
        }

        // 每 100 行输出一次统计
        if (lineCount % 100 === 0) {
          console.log(`[Monitor] 已接收 ${lineCount} 行日志, 检测到 ${errorCount} 个关键字匹配`);
        }
      });

      port.on('error', (err) => {
        console.error(`[Monitor] 串口异常: ${err.message}`);
      });

      port.on('close', () => {
        console.log(`[Monitor] 串口已关闭`);
      });
    });

  } catch (err) {
    console.error(`[Monitor] 初始化失败: ${err.message}`);
    cleanup(1);
    return;
  }

  // 定时器：如果指定了 duration，则到时自动停止
  let timer = null;
  if (durationSec) {
    timer = setTimeout(() => {
      console.log(`[Monitor] 监听时间到 (${durationSec}s)，正常停止`);
      cleanup(0);
    }, durationSec * 1000);
  }

  // 优雅退出处理
  function cleanup(exitCode) {
    if (timer) clearTimeout(timer);

    const result = {
      success: exitCode === 0,
      port: portPath,
      totalLines: lineCount,
      errorCount,
      criticalError,
      timestamp: new Date().toISOString()
    };
    console.log(`[Monitor] RESULT_JSON:${JSON.stringify(result)}`);

    logStream.end();
    if (port && port.isOpen) {
      port.close(() => process.exit(exitCode));
    } else {
      process.exit(exitCode);
    }
  }

  // SIGINT 处理
  process.on('SIGINT', () => {
    console.log('\n[Monitor] 收到 SIGINT，正在停止...');
    cleanup(0);
  });
}

main();
