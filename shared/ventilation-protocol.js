/**
 * shared/ventilation-protocol.js
 * 通风逻辑表 TCP 传输协议定义
 *
 * 职责：
 *   1. 定义通风逻辑表传输的协议常量、命令字、帧格式
 *   2. 提供 CRC16-Modbus 校验计算
 *   3. 提供数据包构建与解析工具函数
 *
 * 开发依据：
 *   - 通风逻辑表 TCP 传输协议规范
 *   - vt_t 结构体字段定义（环控器固件）
 *
 * 更新历史：
 *   v1.0  2026-06-22  初始版本，覆盖协议常量、vt_t 字段映射、CRC 校验、帧构建
 */

'use strict';

// ============================================================
// 1. 协议常量
// ============================================================

/**
 * 协议帧头魔数
 */
const MAGIC = 0xAA55;

/**
 * 通风逻辑表 TCP 传输默认端口
 */
const PORT = 1503;

/**
 * 命令字定义
 * 方向：上位机→固件（WRITE/READ）、固件→上位机（RESPONSE/ACK/NAK）
 */
const CMD = {
  WRITE_LOGIC_TABLE:    0x01,  // 上位机→固件：下发逻辑表
  READ_LOGIC_TABLE:     0x02,  // 上位机→固件：请求读取
  RESPONSE_LOGIC_TABLE: 0x03,  // 固件→上位机：返回数据
  ACK:                  0x04,  // 固件→上位机：确认
  NAK:                  0x05,  // 固件→上位机：否定确认
};

// ============================================================
// 2. vt_t 结构体字段定义
// ============================================================

/**
 * vt_t 结构体字段定义（通风逻辑表单条记录，44 字节）
 * 字段布局与固件 database.h 保持一致（#pragma pack(1)），用于序列化/反序列化
 */
const VT_T_FIELDS = [
  { name: 'TargetTemp',      size: 4,  type: 'float'   },  // 目标温度
  { name: 'TargetTemp_Bak',  size: 4,  type: 'float'   },  // 目标温度备份
  { name: 'fc_workMode',     size: 1,  type: 'uint8'   },  // 变频1工作模式
  { name: 'fc_workMode2',    size: 1,  type: 'uint8'   },  // 变频2工作模式
  { name: 'cs_workMode',     size: 10, type: 'uint8[]' },  // 定速风机1~10工作模式
  { name: 'vq',              size: 4,  type: 'uint32'  },  // 通风量
  { name: 'fc_runFreq',      size: 2,  type: 'uint8[]' },  // 变频风机组1频率
  { name: 'fc_runFreq2',     size: 2,  type: 'uint8[]' },  // 变频风机组2频率
  { name: 'opTime',          size: 2,  type: 'uint16'  },  // 风机开启时间
  { name: 'clTime',          size: 2,  type: 'uint16'  },  // 风机关闭时间
  { name: 'sw_opa',          size: 1,  type: 'uint8'   },  // 小窗开启角度
  { name: 'windIn_opa',      size: 1,  type: 'uint8'   },  // 进风幕帘开启角度
  { name: 'windOut_opa',     size: 1,  type: 'uint8'   },  // 出风幕帘开启角度
  { name: 'Slid_window_opa', size: 1,  type: 'uint8'   },  // 滑窗开启角度
  { name: 'wc_clHumi',       size: 4,  type: 'float'   },  // 水帘关闭湿度
  { name: 'wc_opTime',       size: 2,  type: 'uint16'  },  // 水帘开启时间
  { name: 'wc_clTime',       size: 2,  type: 'uint16'  },  // 水帘关闭时间
];

/**
 * vt_t 结构体总字节数（44 字节，#pragma pack(1)）
 * 4+4+1+1+10+4+2+2+2+2+1+1+1+1+4+2+2 = 44
 */
const VT_T_SIZE = VT_T_FIELDS.reduce((sum, f) => sum + f.size, 0);

/**
 * 最大通风等级数
 */
const MAX_LEVELS = 30;

// ============================================================
// 3. CRC16-Modbus 计算
// ============================================================

/**
 * CRC16-Modbus 查找表（预计算，提高性能）
 */
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    if (crc & 0x0001) {
      crc = (crc >>> 1) ^ 0xA001;
    } else {
      crc = crc >>> 1;
    }
  }
  CRC16_TABLE[i] = crc;
}

/**
 * CRC16-Modbus 校验计算
 * 多项式：0xA001（CRC-16/Modbus）
 * 初始值：0xFFFF
 *
 * @param {Buffer|Uint8Array} buffer - 待校验数据
 * @returns {number} 16 位 CRC 校验值
 */
function crc16(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ buffer[i]) & 0x00FF];
  }
  return crc;
}

// ============================================================
// 4. 数据包构建与解析
// ============================================================

/**
 * 帧头大小：Magic(2) + Cmd(1) + Length(2) = 5 字节
 */
const HEADER_SIZE = 5;

/**
 * CRC 校验域大小：2 字节
 */
const CRC_SIZE = 2;

/**
 * 构建协议数据包
 *
 * 帧格式：
 *   Magic(2B, LE) + Cmd(1B) + Length(2B, LE) + Data(N) + CRC16(2B, LE)
 *
 * CRC 计算范围：Cmd + Length + Data
 *
 * @param {number} cmd - 命令字
 * @param {Buffer} [data] - 数据负载
 * @returns {Buffer} 完整数据包
 */
function buildPacket(cmd, data) {
  if (!Buffer.isBuffer(data)) {
    data = Buffer.alloc(0);
  }

  // 构建帧头 + 数据（大端序，与固件一致）
  const packet = Buffer.alloc(HEADER_SIZE + data.length + CRC_SIZE);
  let offset = 0;

  // Magic (2 bytes, big-endian): 0xAA 0x55
  packet[offset] = (MAGIC >> 8) & 0xFF;
  packet[offset + 1] = MAGIC & 0xFF;
  offset += 2;

  // Cmd (1 byte)
  packet[offset] = cmd;
  offset += 1;

  // Length (2 bytes, big-endian) - 数据负载长度
  packet[offset] = (data.length >> 8) & 0xFF;
  packet[offset + 1] = data.length & 0xFF;
  offset += 2;

  // Data
  if (data.length > 0) {
    data.copy(packet, offset);
    offset += data.length;
  }

  // CRC16-Modbus 计算范围：Magic + Cmd + Length + Data
  const crcPayload = packet.subarray(0, offset);
  const crcValue = crc16(crcPayload);

  // CRC (2 bytes, big-endian)
  packet[offset] = (crcValue >> 8) & 0xFF;
  packet[offset + 1] = crcValue & 0xFF;

  return packet;
}

/**
 * 解析协议数据包
 *
 * 验证帧头魔数和 CRC 校验，返回解析后的对象
 *
 * @param {Buffer} buffer - 原始数据包
 * @returns {object|null} 解析结果 { cmd, data, crcValid } 或 null（解析失败）
 */
function parsePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_SIZE + CRC_SIZE) {
    return null;
  }

  // 校验帧头魔数（大端序，与固件一致）
  const magic = (buffer[0] << 8) | buffer[1];
  if (magic !== MAGIC) {
    return null;
  }

  // 解析命令字
  const cmd = buffer[2];

  // 解析数据长度（大端序）
  const dataLength = (buffer[3] << 8) | buffer[4];

  // 检查缓冲区是否包含完整数据包
  if (buffer.length < HEADER_SIZE + dataLength + CRC_SIZE) {
    return null;
  }

  // 提取数据负载
  const data = buffer.subarray(HEADER_SIZE, HEADER_SIZE + dataLength);

  // 校验 CRC16（CRC 范围：Magic + Cmd + Length + Data）
  const crcPayload = buffer.subarray(0, HEADER_SIZE + dataLength);
  const expectedCrc = (buffer[HEADER_SIZE + dataLength] << 8) | buffer[HEADER_SIZE + dataLength + 1];
  const actualCrc = crc16(crcPayload);

  if (actualCrc !== expectedCrc) {
    return null;
  }

  return { cmd, data, crcValid: true };
}

// ============================================================
// 5. 导出
// ============================================================

module.exports = {
  // 协议常量
  MAGIC,
  PORT,
  CMD,

  // 结构体定义
  VT_T_FIELDS,
  VT_T_SIZE,
  MAX_LEVELS,

  // 帧结构
  HEADER_SIZE,
  CRC_SIZE,

  // 工具函数
  crc16,
  buildPacket,
  parsePacket,
};
