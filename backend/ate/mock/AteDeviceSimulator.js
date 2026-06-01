/**
 * backend/ate/mock/AteDeviceSimulator.js
 * ATE 设备模拟器
 *
 * 职责：
 *   1. 模拟环控器固件的 ATE TCP 服务 (端口 9001)
 *   2. 模拟 Modbus TCP 寄存器响应
 *   3. 用于无真机环境下的上位机功能验证
 *
 * 使用方法：
 *   node AteDeviceSimulator.js
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本
 */

'use strict';

const net = require('net');
const ModbusRTU = require('modbus-serial');

// ============================================================
// 配置
// ============================================================

const ATE_TCP_PORT = 9001;
const MODBUS_TCP_PORT = 502;

// ============================================================
// ATE TCP 模拟器
// ============================================================

/**
 * ATE TCP 帧编解码
 */
function decodeFrame(buffer) {
  if (buffer.length < 6) return null;
  const magic = buffer.readUInt16BE(0);
  if (magic !== 0x55AA) return null;
  const cmdType = buffer.readUInt16BE(2);
  const jsonLength = buffer.readUInt16BE(4);
  if (buffer.length < 6 + jsonLength) return null;
  const jsonStr = buffer.subarray(6, 6 + jsonLength).toString('utf8');
  try {
    const payload = JSON.parse(jsonStr);
    return { cmdType, payload };
  } catch {
    return null;
  }
}

function encodeFrame(cmdType, payload) {
  const jsonStr = JSON.stringify(payload);
  const jsonBuffer = Buffer.from(jsonStr, 'utf8');
  const frame = Buffer.alloc(6 + jsonBuffer.length);
  frame.writeUInt16BE(0x55AA, 0);
  frame.writeUInt16BE(cmdType, 2);
  frame.writeUInt16BE(jsonBuffer.length, 4);
  jsonBuffer.copy(frame, 6);
  return frame;
}

/**
 * 模拟测试状态寄存器
 */
const testRegisters = {
  control: 0,        // 0x8000
  ventLevel: 0,      // 0x8001
  currentItem: 0,    // 0x8002
  progress: 0,       // 0x8003
  overallStatus: 0,  // 0x8004
  sessionId: 0,      // 0x8005-0x8006
  testMask: 0,       // 0x8007
  failedItem: 0,     // 0x8008
  singleResults: [0, 0, 0, 0, 0, 0, 0, 0],  // 0x8010-0x8017
  errorCodes: [0, 0, 0, 0, 0, 0, 0, 0],     // 0x8020-0x8027
};

let testRunning = false;
let testTimer = null;

/**
 * 模拟测试执行
 */
function simulateTest(mask) {
  if (testRunning) return;
  testRunning = true;

  const testItems = [];
  for (let i = 0; i < 9; i++) {
    if (mask & (1 << i)) {
      testItems.push(i + 1);
    }
  }

  console.log(`[Simulator] Starting test with mask: 0x${mask.toString(16)}, items: ${testItems.length}`);

  testRegisters.control = 1; // start
  testRegisters.overallStatus = 1; // running
  testRegisters.sessionId = Date.now();

  let itemIndex = 0;
  const totalItems = testItems.length;

  function runNextItem() {
    if (itemIndex >= totalItems) {
      // 测试完成
      testRegisters.overallStatus = 2; // pass
      testRegisters.progress = 100;
      testRunning = false;
      console.log('[Simulator] Test completed: PASS');
      return;
    }

    const itemId = testItems[itemIndex];
    testRegisters.currentItem = itemId;
    testRegisters.progress = Math.round(((itemIndex) / totalItems) * 100);

    // 标记当前项为 testing
    testRegisters.singleResults[itemId - 1] = 1; // testing

    console.log(`[Simulator] Testing item ${itemId} (${itemIndex + 1}/${totalItems})`);

    // 模拟测试耗时
    testTimer = setTimeout(() => {
      // 90% 概率通过
      if (Math.random() < 0.9) {
        testRegisters.singleResults[itemId - 1] = 2; // pass
        console.log(`[Simulator] Item ${itemId}: PASS`);
      } else {
        testRegisters.singleResults[itemId - 1] = 3; // fail
        testRegisters.errorCodes[itemId - 1] = 0x0010 + itemId;
        testRegisters.failedItem = itemId;
        testRegisters.overallStatus = 3; // fail
        testRunning = false;
        console.log(`[Simulator] Item ${itemId}: FAIL`);
        return;
      }

      itemIndex++;
      runNextItem();
    }, 500 + Math.random() * 1000);
  }

  runNextItem();
}

/**
 * ATE TCP 服务器
 */
const ateServer = net.createServer((socket) => {
  console.log('[ATE TCP] Client connected:', socket.remoteAddress);

  let buffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 6) {
      const magic = buffer.readUInt16BE(0);
      if (magic !== 0x55AA) {
        buffer = buffer.subarray(1);
        continue;
      }

      const jsonLength = buffer.readUInt16BE(4);
      const totalLength = 6 + jsonLength;

      if (buffer.length < totalLength) break;

      const frame = buffer.subarray(0, totalLength);
      buffer = buffer.subarray(totalLength);

      const decoded = decodeFrame(frame);
      if (!decoded) continue;

      const { cmdType, payload } = decoded;
      console.log('[ATE TCP] Received:', payload.method || 'unknown');

      // 处理请求
      let response = null;

      if (payload.method === 'heartbeat') {
        response = { method: 'heartbeat', status: 'ok' };
      } else if (payload.method === 'test.enter') {
        response = { method: 'test.enter', success: true };
      } else if (payload.method === 'test.exit') {
        response = { method: 'test.exit', success: true };
        if (testTimer) clearTimeout(testTimer);
        testRunning = false;
        testRegisters.control = 0;
        testRegisters.overallStatus = 0;
        testRegisters.singleResults = [0, 0, 0, 0, 0, 0, 0, 0];
        testRegisters.errorCodes = [0, 0, 0, 0, 0, 0, 0, 0];
      } else if (payload.method === 'test.start') {
        const mask = payload.params?.testMask || 0x01FF;
        testRegisters.testMask = mask;
        simulateTest(mask);
        response = { method: 'test.start', success: true };
      } else if (payload.method === 'test.stop') {
        if (testTimer) clearTimeout(testTimer);
        testRunning = false;
        testRegisters.control = 2; // stop
        testRegisters.overallStatus = 4; // aborted
        response = { method: 'test.stop', success: true };
      } else if (payload.method === 'test.reset') {
        if (testTimer) clearTimeout(testTimer);
        testRunning = false;
        testRegisters.control = 0;
        testRegisters.overallStatus = 0;
        testRegisters.progress = 0;
        testRegisters.currentItem = 0;
        testRegisters.singleResults = [0, 0, 0, 0, 0, 0, 0, 0];
        testRegisters.errorCodes = [0, 0, 0, 0, 0, 0, 0, 0];
        response = { method: 'test.reset', success: true };
      } else if (payload.method === 'properties.get') {
        response = {
          method: 'properties.get',
          success: true,
          data: {
            'ventilation.targetTemp': 25.0,
            'ventilation.targetHumi': 60.0,
          }
        };
      } else if (payload.method === 'config.write') {
        response = { method: 'config.write', success: true };
      } else if (payload.method === 'control.force_io') {
        response = { method: 'control.force_io', success: true };
      } else {
        response = { method: payload.method, success: true };
      }

      // 发送 ACK
      if (payload.messageId) {
        response.messageId = payload.messageId;
      }
      const ackFrame = encodeFrame(0x0003, response); // ACK
      socket.write(ackFrame);
    }
  });

  socket.on('close', () => {
    console.log('[ATE TCP] Client disconnected');
  });

  socket.on('error', (err) => {
    console.error('[ATE TCP] Error:', err.message);
  });
});

// ============================================================
// Modbus TCP 模拟器（简化版，仅支持基本读写）
// ============================================================

const modbusRegisters = new Array(65536).fill(0);

// 初始化一些默认值
modbusRegisters[0x0000] = 0;  // 心跳
modbusRegisters[0x0001] = 0;  // 控制模式
modbusRegisters[0x8000] = 0;  // ATE 控制
modbusRegisters[0x8004] = 0;  // ATE 整体状态

// ============================================================
// 启动服务
// ============================================================

function start() {
  console.log('========================================');
  console.log('  ATE 设备模拟器');
  console.log('========================================');

  // 启动 ATE TCP 服务器
  ateServer.listen(ATE_TCP_PORT, () => {
    console.log(`[ATE TCP] Server listening on port ${ATE_TCP_PORT}`);
  });

  console.log('\n📍 模拟器地址:');
  console.log(`   ATE TCP: 0.0.0.0:${ATE_TCP_PORT}`);
  console.log('\n⏳ 等待上位机连接...\n');
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[Simulator] Shutting down...');
  if (testTimer) clearTimeout(testTimer);
  ateServer.close();
  process.exit(0);
});

// 启动
start();
