/**
 * scripts/test-ate-protocol.js
 * ATE 协议单元测试
 *
 * 测试内容：
 *   1. AteFrameCodec 编解码
 *   2. TestProtocol 寄存器解析
 *   3. TestCatalog 测试项目录
 *
 * 运行方法：
 *   node scripts/test-ate-protocol.js
 */

'use strict';

const path = require('path');
const AteFrameCodec = require('../backend/ate/AteFrameCodec');
const TestProtocol = require('../backend/ate/TestProtocol');
const TestCatalog = require('../backend/ate/TestCatalog');
const {
  ATE_FRAME,
  ATE_CMD,
  ATE_METHOD,
  TEST_CMD,
  TEST_STATUS,
  SINGLE_RESULT,
  ATE_MASK,
} = require('../shared/constants');

// ============================================================
// 测试工具
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}: expected ${expected}, got ${actual}`);
  }
}

// ============================================================
// 测试 AteFrameCodec
// ============================================================

console.log('\n=== 测试 AteFrameCodec ===');

function testFrameCodec() {
  const codec = new AteFrameCodec();

  // 测试编码
  console.log('\n1. 编码测试');

  const payload1 = { method: 'heartbeat', deviceId: 'test-001' };
  const frame1 = codec.encode(ATE_CMD.HEARTBEAT, payload1);
  assert(frame1 instanceof Buffer, '编码返回 Buffer');
  assertEqual(frame1.readUInt16BE(0), 0x55AA, 'Magic 为 0x55AA');
  assertEqual(frame1.readUInt16BE(2), ATE_CMD.HEARTBEAT, 'CmdType 正确');
  assertEqual(frame1.readUInt16BE(4), JSON.stringify(payload1).length, 'Length 正确');

  // 测试解码
  console.log('\n2. 解码测试');

  const frames = codec.feed(frame1);
  assertEqual(frames.length, 1, '解码出 1 帧');
  assertEqual(frames[0].cmdType, ATE_CMD.HEARTBEAT, 'CmdType 正确');
  assertEqual(frames[0].payload.method, 'heartbeat', 'Payload method 正确');
  assertEqual(frames[0].payload.deviceId, 'test-001', 'Payload deviceId 正确');

  // 测试半包处理
  console.log('\n3. 半包处理测试');

  const codec2 = new AteFrameCodec();
  const frame2 = codec2.encode(ATE_CMD.ACK, { messageId: 1, success: true });

  // 分两次喂入
  const part1 = frame2.subarray(0, 3);
  const part2 = frame2.subarray(3);

  const frames2a = codec2.feed(part1);
  assertEqual(frames2a.length, 0, '半包时无完整帧');

  const frames2b = codec2.feed(part2);
  assertEqual(frames2b.length, 1, '合并后解码出 1 帧');

  // 测试粘包处理
  console.log('\n4. 粘包处理测试');

  const codec3 = new AteFrameCodec();
  const frame3a = codec3.encode(ATE_CMD.ACK, { messageId: 1 });
  const frame3b = codec3.encode(ATE_CMD.ACK, { messageId: 2 });
  const combined = Buffer.concat([frame3a, frame3b]);

  const frames3 = codec3.feed(combined);
  assertEqual(frames3.length, 2, '粘包解码出 2 帧');

  // 测试坏 Magic 丢弃
  console.log('\n5. 坏 Magic 丢弃测试');

  const codec4 = new AteFrameCodec();
  // 构造坏数据 + 有效帧
  const goodFrame = codec4.encode(ATE_CMD.ACK, { test: true });
  const badData = Buffer.from([0x00, 0x00]);
  const combinedData = Buffer.concat([badData, goodFrame]);
  const frames4 = codec4.feed(combinedData);
  assertEqual(frames4.length, 1, '坏 Magic 后找到有效帧');
  assertEqual(codec4.getStats().badMagicDropped, 2, '丢弃 2 字节坏数据');

  // 测试 JSON 编码
  console.log('\n6. JSON 编码测试');

  const codec5 = new AteFrameCodec();
  const frame5 = codec5.encodeDownlink(ATE_METHOD.TEST_ENTER, { test: true }, 123);
  const frames5 = codec5.feed(frame5);
  assertEqual(frames5.length, 1, 'JSON 编码解码成功');
  assertEqual(frames5[0].payload.method, 'test.enter', 'method 正确');
  assertEqual(frames5[0].payload.params.test, true, 'params 正确');
  assertEqual(frames5[0].payload.messageId, 123, 'messageId 正确');
}

// ============================================================
// 测试 TestProtocol
// ============================================================

console.log('\n\n=== 测试 TestProtocol ===');

function testProtocol() {
  const protocol = new TestProtocol();

  // 测试解析测试状态
  console.log('\n1. 解析测试状态寄存器');

  const registers = new Array(40).fill(0);
  registers[0] = TEST_CMD.START;      // 0x8000
  registers[1] = 2;                    // 0x8001 通风等级
  registers[2] = 3;                    // 0x8002 当前项
  registers[3] = 50;                   // 0x8003 进度
  registers[4] = TEST_STATUS.RUNNING;  // 0x8004 整体状态
  registers[6] = 0x01FF;               // 0x8006 测试掩码

  // 单项结果
  registers[16] = SINGLE_RESULT.PASS;  // 0x8010
  registers[17] = SINGLE_RESULT.FAIL;  // 0x8011
  registers[18] = SINGLE_RESULT.TESTING; // 0x8012

  // 错误码
  registers[32] = 0;                   // 0x8020
  registers[33] = 0x0010;              // 0x8021

  const result = protocol.parseTestStatusBlock(registers);

  assertEqual(result.controlCommand.value, TEST_CMD.START, '控制命令正确');
  assertEqual(result.controlCommand.text, '启动', '控制命令文本正确');
  assertEqual(result.ventilationLevel, 2, '通风等级正确');
  assertEqual(result.currentItemId, 3, '当前项正确');
  assertEqual(result.progress, 50, '进度正确');
  assertEqual(result.overallStatus.value, TEST_STATUS.RUNNING, '整体状态正确');
  assertEqual(result.overallStatus.text, '测试中', '整体状态文本正确');
  assertEqual(result.overallStatus.isFinished, false, 'isFinished 正确');
  assertEqual(result.testMask, 0x01FF, '测试掩码正确');

  // 测试单项结果解析
  console.log('\n2. 解析单项结果');

  assertEqual(result.singleResults[0].value, SINGLE_RESULT.PASS, '项 1 状态为 PASS');
  assertEqual(result.singleResults[0].isPass, true, '项 1 isPass 正确');
  assertEqual(result.singleResults[1].value, SINGLE_RESULT.FAIL, '项 2 状态为 FAIL');
  assertEqual(result.singleResults[1].isFail, true, '项 2 isFail 正确');
  assertEqual(result.singleResults[2].value, SINGLE_RESULT.TESTING, '项 3 状态为 TESTING');
  assertEqual(result.singleResults[2].isTesting, true, '项 3 isTesting 正确');

  // 测试错误码解析
  console.log('\n3. 解析错误码');

  assertEqual(result.errorCodes[0].errorCode, 0, '项 1 无错误');
  assertEqual(result.errorCodes[0].hasError, false, '项 1 hasError 正确');
  assertEqual(result.errorCodes[1].errorCode, 0x0010, '项 2 错误码正确');
  assertEqual(result.errorCodes[1].hasError, true, '项 2 hasError 正确');
  assert(result.errorCodes[1].detail !== null, '项 2 有错误详情');

  // 测试构建方法
  console.log('\n4. 构建方法测试');

  assertEqual(protocol.buildControlCommand('start'), TEST_CMD.START, '构建启动命令');
  assertEqual(protocol.buildControlCommand('stop'), TEST_CMD.STOP, '构建停止命令');
  assertEqual(protocol.buildControlCommand('reset'), TEST_CMD.RESET, '构建复位命令');

  const mask = protocol.buildTestMask([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEqual(mask, 0x01FF, '构建全项掩码');

  assertEqual(protocol.buildDeviceModel('9200'), 0, '构建 9200 型号');
  assertEqual(protocol.buildDeviceModel('9250'), 1, '构建 9250 型号');
  assertEqual(protocol.buildDeviceModel('9300'), 1, '构建 9300 型号');

  // 测试辅助方法
  console.log('\n5. 辅助方法测试');

  assertEqual(protocol.isFinishedStatus(TEST_STATUS.PASS), true, 'PASS 为结束状态');
  assertEqual(protocol.isFinishedStatus(TEST_STATUS.FAIL), true, 'FAIL 为结束状态');
  assertEqual(protocol.isFinishedStatus(TEST_STATUS.RUNNING), false, 'RUNNING 非结束状态');

  assertEqual(protocol.getResultCssClass(SINGLE_RESULT.PASS), 'result-pass', 'PASS CSS 类');
  assertEqual(protocol.getResultCssClass(SINGLE_RESULT.FAIL), 'result-fail', 'FAIL CSS 类');

  assert(protocol.getErrorDescription(0x0010).includes('SPI Flash'), '错误描述包含 SPI Flash');
  assert(protocol.getTroubleshootingSuggestion(0x0010).length > 0, '排障建议非空');
}

// ============================================================
// 测试 TestCatalog
// ============================================================

console.log('\n\n=== 测试 TestCatalog ===');

function testCatalog() {
  const catalog = new TestCatalog();

  // 测试获取基础项目
  console.log('\n1. 获取基础硬件自检项目');

  const basicItems = catalog.getBasicItems();
  assertEqual(basicItems.length, 9, '有 9 项基础自检');
  assertEqual(basicItems[0].name, 'SPI Flash 自检', '第 1 项为 SPI Flash');
  assertEqual(basicItems[0].mask, ATE_MASK.SPI_FLASH, 'SPI Flash 掩码正确');

  // 测试掩码过滤
  console.log('\n2. 掩码过滤测试');

  const maskItems = catalog.getItemsByMask(0x0003); // bit0 + bit1
  assertEqual(maskItems.length, 2, '掩码 0x0003 对应 2 项');
  assertEqual(maskItems[0].id, 1, '第 1 项 ID 正确');
  assertEqual(maskItems[1].id, 2, '第 2 项 ID 正确');

  // 测试获取所有项目
  console.log('\n3. 获取所有项目');

  const allItems = catalog.getAllItems();
  assert(allItems.length >= 9, '所有项目数量 >= 9');

  // 测试根据 ID 获取
  console.log('\n4. 根据 ID 获取');

  const item1 = catalog.getItemById(1);
  assert(item1 !== null, '获取 ID=1 成功');
  assertEqual(item1.name, 'SPI Flash 自检', 'ID=1 名称正确');

  const item999 = catalog.getItemById(999);
  assertEqual(item999, null, 'ID=999 返回 null');

  // 测试项目树
  console.log('\n5. 项目树生成');

  const tree = catalog.getProjectTree();
  assertEqual(tree.length, 2, '项目树有 2 个分组');
  assertEqual(tree[0].id, 'basic', '第 1 组为 basic');
  assertEqual(tree[0].children.length, 9, 'basic 组有 9 个子项');

  // 测试掩码验证
  console.log('\n6. 掩码验证');

  assert(catalog.isValidMask(0x01FF), '0x01FF 有效');
  assert(catalog.isValidMask(0x0001), '0x0001 有效');
  assert(!catalog.isValidMask(0x0200), '0x0200 无效');
  assert(!catalog.isValidMask(0xFFFF), '0xFFFF 无效');

  const filteredMask = catalog.filterMask(0x02FF); // 包含未定义位
  assertEqual(filteredMask, 0x00FF, 'filterMask 移除未定义位');

  // 测试错误码详情
  console.log('\n7. 错误码详情');

  const errorDetail = catalog.getErrorDetail(0x0010);
  assert(errorDetail !== null, '0x0010 有错误详情');
  assertEqual(errorDetail.name, 'SPI Flash 初始化失败', '错误名称正确');
  assert(errorDetail.cause.length > 0, '原因非空');
  assert(errorDetail.suggestion.length > 0, '建议非空');
}

// ============================================================
// 运行所有测试
// ============================================================

console.log('\n========================================');
console.log('  ATE 协议单元测试');
console.log('========================================');

try {
  testFrameCodec();
  testProtocol();
  testCatalog();
} catch (err) {
  console.error('\n❌ 测试异常:', err.message);
  failed++;
}

console.log('\n========================================');
console.log(`  测试结果: ${passed} 通过, ${failed} 失败`);
console.log('========================================');

process.exit(failed > 0 ? 1 : 0);
