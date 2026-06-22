/**
 * scripts/test-ventilation-data.js
 * 通风逻辑表 TCP 传输自测脚本
 *
 * 测试内容：
 *   1. 协议常量与帧构建/解析验证
 *   2. CRC16-Modbus 计算验证
 *   3. 连接环控器 TCP 服务并读取逻辑表
 *
 * 运行方式：
 *   node scripts/test-ventilation-data.js
 *   node scripts/test-ventilation-data.js --host 192.168.10.233 --port 1503
 */

'use strict';

const path = require('path');
const {
  MAGIC,
  PORT,
  CMD,
  VT_T_FIELDS,
  VT_T_SIZE,
  MAX_LEVELS,
  HEADER_SIZE,
  CRC_SIZE,
  crc16,
  buildPacket,
  parsePacket,
} = require('../shared/ventilation-protocol');

const VentilationDataClient = require('../backend/ventilation-data-client');

// ============================================================
// 测试工具
// ============================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(msg) {
  console.log(`  ${msg}`);
}

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS  ${testName}`);
  } else {
    failedTests++;
    console.error(`  FAIL  ${testName}`);
  }
}

// ============================================================
// 参数解析
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { host: '192.168.10.233', port: PORT, level: 0, mode: 'all' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        result.host = args[++i];
        break;
      case '--port':
        result.port = Number(args[++i]);
        break;
      case '--level':
        result.level = Number(args[++i]);
        result.mode = 'single';
        break;
      case '--help':
        console.log('Usage: node scripts/test-ventilation-data.js [options]');
        console.log('  --host <ip>    设备 IP (默认 192.168.10.233)');
        console.log('  --port <port>  TCP 端口 (默认 1503)');
        console.log('  --level <n>    读取指定等级 (0-29)，不指定则读取全部');
        process.exit(0);
        break;
    }
  }

  return result;
}

// ============================================================
// 协议单元测试（无硬件依赖）
// ============================================================

function testCrc16() {
  console.log('\n=== 1. CRC16-Modbus 计算验证 ===');

  // 已知测试向量：空数据的 CRC = 0xFFFF
  const emptyCrc = crc16(Buffer.alloc(0));
  assert(emptyCrc === 0xFFFF, '空数据 CRC = 0xFFFF');

  // 已知测试向量：单字节 0x01 的 CRC
  const singleByteCrc = crc16(Buffer.from([0x01]));
  assert(typeof singleByteCrc === 'number', '单字节 CRC 返回数值');
  assert(singleByteCrc !== 0xFFFF, '单字节 CRC 非 0xFFFF');

  // 已知测试向量："123456789" 的 CRC-16/Modbus = 0x4B37
  const strCrc = crc16(Buffer.from('123456789'));
  assert(strCrc === 0x4B37, `"123456789" CRC = 0x${strCrc.toString(16).toUpperCase()} (期望 0x4B37)`);

  // 一致性：相同数据计算两次结果相同
  const data = Buffer.from([0xAA, 0x55, 0x01, 0x00, 0x02]);
  const crc1 = crc16(data);
  const crc2 = crc16(data);
  assert(crc1 === crc2, '相同数据 CRC 一致性');
}

function testBuildPacket() {
  console.log('\n=== 2. 数据包构建验证 ===');

  // 空数据包
  const empty = buildPacket(CMD.ACK);
  assert(empty.length === HEADER_SIZE + CRC_SIZE, `空数据包长度 = ${empty.length} (期望 ${HEADER_SIZE + CRC_SIZE})`);

  // 魔数
  const magic = empty.readUInt16LE(0);
  assert(magic === MAGIC, `帧头魔数 = 0x${magic.toString(16).toUpperCase()} (期望 0x${MAGIC.toString(16).toUpperCase()})`);

  // 命令字
  const cmd = empty.readUInt8(2);
  assert(cmd === CMD.ACK, `命令字 = 0x${cmd.toString(16).toUpperCase()} (期望 0x${CMD.ACK.toString(16).toUpperCase()})`);

  // 数据长度
  const dataLen = empty.readUInt16LE(3);
  assert(dataLen === 0, `数据长度 = ${dataLen} (期望 0)`);

  // 带数据的包
  const payload = Buffer.from([0xFF, 0x01, 0x02]);
  const withData = buildPacket(CMD.WRITE_LOGIC_TABLE, payload);
  const expectedLen = HEADER_SIZE + payload.length + CRC_SIZE;
  assert(withData.length === expectedLen, `带数据包长度 = ${withData.length} (期望 ${expectedLen})`);

  // 数据长度字段正确
  const withDataLen = withData.readUInt16LE(3);
  assert(withDataLen === payload.length, `数据长度字段 = ${withDataLen} (期望 ${payload.length})`);
}

function testParsePacket() {
  console.log('\n=== 3. 数据包解析验证 ===');

  // 构建并解析空数据包
  const emptyBuilt = buildPacket(CMD.ACK);
  const emptyParsed = parsePacket(emptyBuilt);
  assert(emptyParsed !== null, '空数据包解析成功');
  assert(emptyParsed.cmd === CMD.ACK, `空数据包命令字 = 0x${emptyParsed.cmd.toString(16).toUpperCase()}`);
  assert(emptyParsed.crcValid === true, '空数据包 CRC 校验通过');

  // 构建并解析带数据的包
  const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const dataBuilt = buildPacket(CMD.RESPONSE_LOGIC_TABLE, payload);
  const dataParsed = parsePacket(dataBuilt);
  assert(dataParsed !== null, '带数据包解析成功');
  assert(dataParsed.cmd === CMD.RESPONSE_LOGIC_TABLE, '命令字正确');
  assert(Buffer.compare(dataParsed.data, payload) === 0, '数据负载一致');
  assert(dataParsed.crcValid === true, '带数据包 CRC 校验通过');

  // CRC 篡改检测
  const tampered = Buffer.from(dataBuilt);
  tampered[tampered.length - 1] ^= 0xFF;  // 篡改 CRC 低字节
  const tamperedParsed = parsePacket(tampered);
  assert(tamperedParsed === null, 'CRC 篡改后解析失败');

  // 魔数错误检测
  const badMagic = Buffer.from(dataBuilt);
  badMagic[0] = 0x00;
  badMagic[1] = 0x00;
  const badMagicParsed = parsePacket(badMagic);
  assert(badMagicParsed === null, '魔数错误后解析失败');

  // 数据不足检测
  const tooShort = Buffer.alloc(3);
  const tooShortParsed = parsePacket(tooShort);
  assert(tooShortParsed === null, '数据不足时解析返回 null');
}

function testVtTFields() {
  console.log('\n=== 4. vt_t 字段定义验证 ===');

  assert(VT_T_SIZE === 35, `vt_t 总大小 = ${VT_T_SIZE} 字节 (期望 35)`);
  assert(VT_T_FIELDS.length === 14, `字段数量 = ${VT_T_FIELDS.length} (期望 14)`);
  assert(MAX_LEVELS === 30, `最大等级数 = ${MAX_LEVELS} (期望 30)`);

  // 验证字段名唯一性
  const names = VT_T_FIELDS.map(f => f.name);
  const uniqueNames = new Set(names);
  assert(uniqueNames.size === names.length, '字段名唯一');

  // 验证字段大小累加
  const totalSize = VT_T_FIELDS.reduce((sum, f) => sum + f.size, 0);
  assert(totalSize === VT_T_SIZE, `字段大小累加 = ${totalSize} = VT_T_SIZE`);
}

function testSerializeDeserialize() {
  console.log('\n=== 5. vt_t 序列化/反序列化验证 ===');

  const client = new VentilationDataClient();

  // 测试数据
  const testVt = {
    vf_workMode: 1,
    cs_workMode: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    vq: 100,
    fc_runFreq: [50, 60],
    fc_runFreq2: [40, 55],
    opTime: 30,
    clTime: 20,
    sw_opa: 80,
    windIn_opa: 60,
    windOut_opa: 70,
    Slid_window_opa: 50,
    wc_clHumi: 65.5,
    wc_opTime: 15,
    wc_clTime: 10,
  };

  // 序列化
  const buf = client._serializeVtT(testVt);
  assert(Buffer.isBuffer(buf), '序列化返回 Buffer');
  assert(buf.length === VT_T_SIZE, `序列化长度 = ${buf.length} (期望 ${VT_T_SIZE})`);

  // 反序列化
  const deserialized = client._deserializeVtT(buf);
  assert(deserialized.vf_workMode === testVt.vf_workMode, 'vf_workMode 一致');
  assert(deserialized.cs_workMode[0] === 1, 'cs_workMode[0] = 1');
  assert(deserialized.cs_workMode[9] === 10, 'cs_workMode[9] = 10');
  assert(deserialized.vq === testVt.vq, 'vq 一致');
  assert(deserialized.fc_runFreq[0] === 50, 'fc_runFreq[0] = 50');
  assert(deserialized.fc_runFreq2[1] === 55, 'fc_runFreq2[1] = 55');
  assert(deserialized.opTime === testVt.opTime, 'opTime 一致');
  assert(deserialized.clTime === testVt.clTime, 'clTime 一致');
  assert(deserialized.sw_opa === testVt.sw_opa, 'sw_opa 一致');
  assert(deserialized.windIn_opa === testVt.windIn_opa, 'windIn_opa 一致');
  assert(deserialized.windOut_opa === testVt.windOut_opa, 'windOut_opa 一致');
  assert(deserialized.Slid_window_opa === testVt.Slid_window_opa, 'Slid_window_opa 一致');
  assert(Math.abs(deserialized.wc_clHumi - testVt.wc_clHumi) < 0.01, 'wc_clHumi 一致');
  assert(deserialized.wc_opTime === testVt.wc_opTime, 'wc_opTime 一致');
  assert(deserialized.wc_clTime === testVt.wc_clTime, 'wc_clTime 一致');
}

// ============================================================
// TCP 集成测试（需要硬件）
// ============================================================

async function testTcpConnection(config) {
  console.log('\n=== 6. TCP 连接与逻辑表读取 ===');

  const client = new VentilationDataClient({
    host: config.host,
    port: config.port,
    timeout: 5000,
  });

  try {
    // 连接
    log(`连接 ${config.host}:${config.port} ...`);
    await client.connect();
    assert(client.isConnected(), 'TCP 连接成功');

    // 读取逻辑表
    if (config.mode === 'single') {
      log(`读取等级 ${config.level} ...`);
      const levels = await client.readLogicTable(config.level);
      assert(levels.length > 0, `读取到 ${levels.length} 条逻辑表`);

      for (const level of levels) {
        log(`等级 ${level.index}: vf_workMode=${level.data.vf_workMode}, vq=${level.data.vq}`);
        assert(level.index >= 0 && level.index < MAX_LEVELS, `等级索引有效: ${level.index}`);
      }
    } else {
      log('读取全部等级 ...');
      const levels = await client.readLogicTable(0xFF);
      assert(levels.length > 0, `读取到 ${levels.length} 条逻辑表`);

      for (const level of levels) {
        log(`等级 ${level.index}: vf_workMode=${level.data.vf_workMode}, vq=${level.data.vq}, opTime=${level.data.opTime}`);
        assert(level.index >= 0 && level.index < MAX_LEVELS, `等级索引有效: ${level.index}`);
      }
    }

    // 断开
    client.disconnect();
    assert(!client.isConnected(), '断开连接成功');

  } catch (err) {
    console.error(`\n  TCP 测试失败: ${err.message}`);
    console.log('  提示: 请确认设备在线且固件支持通风逻辑表 TCP 端口 1503');
    client.disconnect();
  }
}

// ============================================================
// 主测试流程
// ============================================================

async function main() {
  const config = parseArgs();

  console.log('==========================================');
  console.log('  通风逻辑表 TCP 传输测试');
  console.log('==========================================');
  console.log(`运行时间: ${new Date().toISOString()}`);
  console.log(`目标设备: ${config.host}:${config.port}`);

  // 协议单元测试（无硬件依赖）
  testCrc16();
  testBuildPacket();
  testParsePacket();
  testVtTFields();
  testSerializeDeserialize();

  // TCP 集成测试（需要硬件）
  await testTcpConnection(config);

  // 汇总
  console.log('\n==========================================');
  console.log('  测试结果汇总');
  console.log('==========================================');
  console.log(`  总计: ${totalTests}`);
  console.log(`  通过: ${passedTests}`);
  console.log(`  失败: ${failedTests}`);
  console.log(`  结论: ${failedTests === 0 ? '全部通过' : '存在失败'}`);

  if (failedTests > 0) {
    process.exit(1);
  }
}

main();
