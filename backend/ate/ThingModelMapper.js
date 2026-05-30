/**
 * backend/ate/ThingModelMapper.js
 * 物模型 JSON 构造与字段映射
 *
 * 职责：
 *   1. 定义 P0 17.8 物模型字段字典（functionId、字段名、类型、范围、默认值）
 *   2. 构造 properties.get / config.write / control.force_io 的 JSON Payload
 *   3. 处理大包策略（普通包 4096 字节，Fanlogic 大表 16384 字节）
 *   4. 跳过未使用变量（-1、-99.0）
 *
 * 开发依据：
 *   - P0 方案第 17.8 节：物模型字段定义
 *   - P0 方案第 5 章：TCP+JSON 协议规范
 *   - shared/constants.js：ATE_METHOD
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，P0 17.8 物模型字典
 */

'use strict';

const { ATE_METHOD } = require('../../shared/constants');

/**
 * 物模型字段定义
 * @typedef {object} ThingModelProperty
 * @property {string} fieldId - 字段 ID（与固件一致）
 * @property {string} fieldName - 字段名称
 * @property {string} type - 数据类型：number/string/boolean/object
 * @property {number} [min] - 最小值
 * @property {number} [max] - 最大值
 * @property {*} defaultValue - 默认值
 * @property {string} unit - 单位
 * @property {string} description - 描述
 * @property {boolean} skipUnused - 是否跳过未使用（-1、-99.0）
 */

/**
 * 物模型映射器
 */
class ThingModelMapper {
  constructor() {
    /**
     * P0 17.8 物模型字段字典
     * 按功能分组：Pigsty、Ventilation、Fanlogic、风机、开口、水帘、喷淋、告警等
     */
    this._properties = {
      // ============================================================
      // 猪舍配置 (Pigsty)
      // ============================================================
      pigsty: {
        'pigsty.id': {
          fieldId: 'pigsty.id',
          fieldName: '猪舍 ID',
          type: 'number',
          min: 1,
          max: 255,
          defaultValue: 1,
          unit: '',
          description: '猪舍编号',
          skipUnused: false,
        },
        'pigsty.name': {
          fieldId: 'pigsty.name',
          fieldName: '猪舍名称',
          type: 'string',
          defaultValue: '默认猪舍',
          unit: '',
          description: '猪舍名称',
          skipUnused: false,
        },
        'pigsty.type': {
          fieldId: 'pigsty.type',
          fieldName: '猪舍类型',
          type: 'number',
          min: 0,
          max: 10,
          defaultValue: 0,
          unit: '',
          description: '0=育肥舍, 1=保育舍, 2=产房',
          skipUnused: false,
        },
      },

      // ============================================================
      // 通风控制 (Ventilation)
      // ============================================================
      ventilation: {
        'ventilation.mode': {
          fieldId: 'ventilation.mode',
          fieldName: '通风模式',
          type: 'number',
          min: 0,
          max: 2,
          defaultValue: 0,
          unit: '',
          description: '0=负压通风, 1=微正压通风, 2=混合通风',
          skipUnused: false,
        },
        'ventilation.targetTemp': {
          fieldId: 'ventilation.targetTemp',
          fieldName: '目标温度',
          type: 'number',
          min: 0,
          max: 50,
          defaultValue: 25.0,
          unit: '°C',
          description: '目标温度（×10 写入寄存器）',
          skipUnused: false,
        },
        'ventilation.targetHumi': {
          fieldId: 'ventilation.targetHumi',
          fieldName: '目标湿度',
          type: 'number',
          min: 0,
          max: 100,
          defaultValue: 60.0,
          unit: '%',
          description: '目标湿度（×10 写入寄存器）',
          skipUnused: false,
        },
        'ventilation.ventLevel': {
          fieldId: 'ventilation.ventLevel',
          fieldName: '通风等级',
          type: 'number',
          min: 0,
          max: 10,
          defaultValue: 0,
          unit: '级',
          description: '当前通风等级',
          skipUnused: false,
        },
      },

      // ============================================================
      // 风机逻辑 (Fanlogic)
      // ============================================================
      fanlogic: {
        'fanlogic.exhaustFan1Enable': {
          fieldId: 'fanlogic.exhaustFan1Enable',
          fieldName: '排风机组 1 使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '排风机组 1 使能开关',
          skipUnused: false,
        },
        'fanlogic.exhaustFan2Enable': {
          fieldId: 'fanlogic.exhaustFan2Enable',
          fieldName: '排风机组 2 使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '排风机组 2 使能开关',
          skipUnused: false,
        },
        'fanlogic.exhaustFan3Enable': {
          fieldId: 'fanlogic.exhaustFan3Enable',
          fieldName: '排风机组 3 使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '排风机组 3 使能开关',
          skipUnused: false,
        },
        'fanlogic.supplyFanEnable': {
          fieldId: 'fanlogic.supplyFanEnable',
          fieldName: '送风机使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '送风机使能开关',
          skipUnused: false,
        },
        'fanlogic.exhaustFan1Speed': {
          fieldId: 'fanlogic.exhaustFan1Speed',
          fieldName: '排风机组 1 速度',
          type: 'number',
          min: 0,
          max: 100,
          defaultValue: 100,
          unit: '%',
          description: '排风机组 1 变频速度',
          skipUnused: false,
        },
        'fanlogic.exhaustFan2Speed': {
          fieldId: 'fanlogic.exhaustFan2Speed',
          fieldName: '排风机组 2 速度',
          type: 'number',
          min: 0,
          max: 100,
          defaultValue: 100,
          unit: '%',
          description: '排风机组 2 变频速度',
          skipUnused: false,
        },
        'fanlogic.supplyFanSpeed': {
          fieldId: 'fanlogic.supplyFanSpeed',
          fieldName: '送风机速度',
          type: 'number',
          min: 0,
          max: 100,
          defaultValue: 100,
          unit: '%',
          description: '送风机变频速度',
          skipUnused: false,
        },
      },

      // ============================================================
      // 风机配置 (Fan)
      // ============================================================
      fan: {
        'fan.exhaustGroup1Relay': {
          fieldId: 'fan.exhaustGroup1Relay',
          fieldName: '排风机组 1 继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 0,
          unit: '',
          description: '排风机组 1 对应的继电器序号（0-based）',
          skipUnused: false,
        },
        'fan.exhaustGroup2Relay': {
          fieldId: 'fan.exhaustGroup2Relay',
          fieldName: '排风机组 2 继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 1,
          unit: '',
          description: '排风机组 2 对应的继电器序号（0-based）',
          skipUnused: false,
        },
        'fan.supplyFanRelay': {
          fieldId: 'fan.supplyFanRelay',
          fieldName: '送风机继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 2,
          unit: '',
          description: '送风机对应的继电器序号（0-based）',
          skipUnused: false,
        },
        'fan.exhaustFan1AO': {
          fieldId: 'fan.exhaustFan1AO',
          fieldName: '排风机组 1 AO',
          type: 'number',
          min: 0,
          max: 3,
          defaultValue: 0,
          unit: '',
          description: '排风机组 1 对应的 AO 通道',
          skipUnused: false,
        },
        'fan.supplyFanAO': {
          fieldId: 'fan.supplyFanAO',
          fieldName: '送风机 AO',
          type: 'number',
          min: 0,
          max: 3,
          defaultValue: 1,
          unit: '',
          description: '送风机对应的 AO 通道',
          skipUnused: false,
        },
      },

      // ============================================================
      // 开口控制 (Opening)
      // ============================================================
      opening: {
        'opening.inletEnable': {
          fieldId: 'opening.inletEnable',
          fieldName: '进气口使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '进气口使能开关',
          skipUnused: false,
        },
        'opening.outletEnable': {
          fieldId: 'opening.outletEnable',
          fieldName: '出气口使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '出气口使能开关',
          skipUnused: false,
        },
        'opening.inletRelay': {
          fieldId: 'opening.inletRelay',
          fieldName: '进气口继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 3,
          unit: '',
          description: '进气口对应的继电器序号',
          skipUnused: false,
        },
        'opening.outletRelay': {
          fieldId: 'opening.outletRelay',
          fieldName: '出气口继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 4,
          unit: '',
          description: '出气口对应的继电器序号',
          skipUnused: false,
        },
      },

      // ============================================================
      // 水帘控制 (WaterCurtain)
      // ============================================================
      waterCurtain: {
        'waterCurtain.enable': {
          fieldId: 'waterCurtain.enable',
          fieldName: '水帘使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '水帘使能开关',
          skipUnused: false,
        },
        'waterCurtain.relay': {
          fieldId: 'waterCurtain.relay',
          fieldName: '水帘继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 5,
          unit: '',
          description: '水帘对应的继电器序号',
          skipUnused: false,
        },
        'waterCurtain开启温度': {
          fieldId: 'waterCurtain开启温度',
          fieldName: '水帘开启温度',
          type: 'number',
          min: 0,
          max: 50,
          defaultValue: 30.0,
          unit: '°C',
          description: '高于此温度开启水帘',
          skipUnused: false,
        },
      },

      // ============================================================
      // 喷淋控制 (Spray)
      // ============================================================
      spray: {
        'spray.enable': {
          fieldId: 'spray.enable',
          fieldName: '喷淋使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '喷淋使能开关',
          skipUnused: false,
        },
        'spray.relay': {
          fieldId: 'spray.relay',
          fieldName: '喷淋继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 6,
          unit: '',
          description: '喷淋对应的继电器序号',
          skipUnused: false,
        },
        'spray开启温度': {
          fieldId: 'spray开启温度',
          fieldName: '喷淋开启温度',
          type: 'number',
          min: 0,
          max: 50,
          defaultValue: 35.0,
          unit: '°C',
          description: '高于此温度开启喷淋',
          skipUnused: false,
        },
        'spray定时开启': {
          fieldId: 'spray定时开启',
          fieldName: '喷淋定时开启',
          type: 'boolean',
          defaultValue: false,
          unit: '',
          description: '是否启用定时喷淋',
          skipUnused: false,
        },
        'spray定时开始时间': {
          fieldId: 'spray定时开始时间',
          fieldName: '喷淋定时开始时间',
          type: 'number',
          min: 0,
          max: 23,
          defaultValue: 6,
          unit: '时',
          description: '定时喷淋开始时间',
          skipUnused: false,
        },
        'spray定时结束时间': {
          fieldId: 'spray定时结束时间',
          fieldName: '喷淋定时结束时间',
          type: 'number',
          min: 0,
          max: 23,
          defaultValue: 18,
          unit: '时',
          description: '定时喷淋结束时间',
          skipUnused: false,
        },
      },

      // ============================================================
      // 加热控制 (Heater)
      // ============================================================
      heater: {
        'heater.enable': {
          fieldId: 'heater.enable',
          fieldName: '加热使能',
          type: 'boolean',
          defaultValue: true,
          unit: '',
          description: '加热使能开关',
          skipUnused: false,
        },
        'heater.relay': {
          fieldId: 'heater.relay',
          fieldName: '加热继电器',
          type: 'number',
          min: 0,
          max: 21,
          defaultValue: 7,
          unit: '',
          description: '加热对应的继电器序号',
          skipUnused: false,
        },
        'heater开启温度': {
          fieldId: 'heater开启温度',
          fieldName: '加热开启温度',
          type: 'number',
          min: 0,
          max: 50,
          defaultValue: 15.0,
          unit: '°C',
          description: '低于此温度开启加热',
          skipUnused: false,
        },
      },

      // ============================================================
      // 告警配置 (Alarm)
      // ============================================================
      alarm: {
        'alarm高温阈值': {
          fieldId: 'alarm高温阈值',
          fieldName: '高温告警阈值',
          type: 'number',
          min: 0,
          max: 60,
          defaultValue: 38.0,
          unit: '°C',
          description: '高于此温度触发高温告警',
          skipUnused: false,
        },
        'alarm低温阈值': {
          fieldId: 'alarm低温阈值',
          fieldName: '低温告警阈值',
          type: 'number',
          min: 0,
          max: 60,
          defaultValue: 5.0,
          unit: '°C',
          description: '低于此温度触发低温告警',
          skipUnused: false,
        },
        'alarm高湿阈值': {
          fieldId: 'alarm高湿阈值',
          fieldName: '高湿告警阈值',
          type: 'number',
          min: 0,
          max: 100,
          defaultValue: 85.0,
          unit: '%',
          description: '高于此湿度触发高湿告警',
          skipUnused: false,
        },
        'alarm低湿阈值': {
          fieldId: 'alarm低湿阈值',
          fieldName: '低湿告警阈值',
          type: 'number',
          min: 0,
          max: 100,
          defaultValue: 30.0,
          unit: '%',
          description: '低于此湿度触发低湿告警',
          skipUnused: false,
        },
      },
    };

    /**
     * 大包阈值：普通包 4096 字节，Fanlogic 大表 16384 字节
     */
    this._maxPacketSize = 4096;
    this._maxLargePacketSize = 16384;
    this._largePacketGroups = ['fanlogic'];
  }

  // ============================================================
  // 公共方法
  // ============================================================

  /**
   * 获取所有属性定义
   * @returns {object}
   */
  getAllProperties() {
    return { ...this._properties };
  }

  /**
   * 获取指定分组的属性定义
   * @param {string} group - 分组名
   * @returns {object|null}
   */
  getPropertiesByGroup(group) {
    return this._properties[group] || null;
  }

  /**
   * 获取单个属性定义
   * @param {string} fieldId - 字段 ID
   * @returns {ThingModelProperty|null}
   */
  getProperty(fieldId) {
    for (const group of Object.values(this._properties)) {
      if (group[fieldId]) {
        return group[fieldId];
      }
    }
    return null;
  }

  /**
   * 构造 properties.get 请求
   * @param {string[]} fieldIds - 字段 ID 列表
   * @returns {object} { method, params: { properties: [...] } }
   */
  buildPropertiesGet(fieldIds) {
    return {
      method: ATE_METHOD.PROPERTIES_GET,
      params: {
        properties: fieldIds,
      },
    };
  }

  /**
   * 构造 config.write 请求
   * @param {object} values - 字段值映射 { fieldId: value }
   * @returns {object} { method, params: { config: {...} } }
   */
  buildConfigWrite(values) {
    const config = {};

    for (const [fieldId, value] of Object.entries(values)) {
      const prop = this.getProperty(fieldId);
      if (!prop) {
        console.warn(`[ThingModelMapper] Unknown field: ${fieldId}`);
        continue;
      }

      // 跳过未使用变量（-1、-99.0）
      if (prop.skipUnused && (value === -1 || value === -99.0)) {
        continue;
      }

      // 类型转换和范围检查
      let validValue = value;
      if (prop.type === 'number') {
        validValue = Number(value);
        if (isNaN(validValue)) {
          console.warn(`[ThingModelMapper] Invalid number value for ${fieldId}: ${value}`);
          continue;
        }
        if (prop.min !== undefined && validValue < prop.min) {
          validValue = prop.min;
        }
        if (prop.max !== undefined && validValue > prop.max) {
          validValue = prop.max;
        }
      } else if (prop.type === 'boolean') {
        validValue = Boolean(value);
      } else if (prop.type === 'string') {
        validValue = String(value);
      }

      config[fieldId] = validValue;
    }

    return {
      method: ATE_METHOD.CONFIG_WRITE,
      params: {
        config,
      },
    };
  }

  /**
   * 构造 control.force_io 请求
   * @param {object} outputs - 输出配置 { channel: value }
   * @param {number} [timeoutMs] - 超时时间
   * @returns {object} { method, params: { outputs, timeoutMs } }
   */
  buildForceIo(outputs, timeoutMs = 5000) {
    return {
      method: ATE_METHOD.CONTROL_FORCE_IO,
      params: {
        outputs,
        timeoutMs,
      },
    };
  }

  /**
   * 检查是否需要大包策略
   * @param {string} group - 分组名
   * @returns {boolean}
   */
  needsLargePacket(group) {
    return this._largePacketGroups.includes(group);
  }

  /**
   * 获取最大包大小
   * @param {string} group - 分组名
   * @returns {number}
   */
  getMaxPacketSize(group) {
    return this.needsLargePacket(group) ? this._maxLargePacketSize : this._maxPacketSize;
  }

  /**
   * 分包处理
   * 将大 JSON 拆分为多个小包
   * @param {object} data - 要发送的数据
   * @param {string} group - 分组名
   * @returns {Array<object>} 分包后的数据列表
   */
  splitPacket(data, group) {
    const max_size = this.getMaxPacketSize(group);
    const jsonStr = JSON.stringify(data);

    if (jsonStr.length <= max_size) {
      return [data];
    }

    // 按字段分组拆分
    const packets = [];
    const entries = Object.entries(data);
    let currentPacket = {};
    let currentSize = 2; // {}

    for (const [key, value] of entries) {
      const entrySize = JSON.stringify({ [key]: value }).length + 1; // +1 for comma

      if (currentSize + entrySize > max_size && Object.keys(currentPacket).length > 0) {
        packets.push(currentPacket);
        currentPacket = {};
        currentSize = 2;
      }

      currentPacket[key] = value;
      currentSize += entrySize;
    }

    if (Object.keys(currentPacket).length > 0) {
      packets.push(currentPacket);
    }

    return packets;
  }

  /**
   * 验证字段值
   * @param {string} fieldId - 字段 ID
   * @param {*} value - 值
   * @returns {object} { valid: boolean, error?: string }
   */
  validateFieldValue(fieldId, value) {
    const prop = this.getProperty(fieldId);
    if (!prop) {
      return { valid: false, error: `未知字段: ${fieldId}` };
    }

    if (prop.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        return { valid: false, error: `字段 ${fieldId} 需要数字类型` };
      }
      if (prop.min !== undefined && num < prop.min) {
        return { valid: false, error: `字段 ${fieldId} 最小值为 ${prop.min}` };
      }
      if (prop.max !== undefined && num > prop.max) {
        return { valid: false, error: `字段 ${fieldId} 最大值为 ${prop.max}` };
      }
    }

    return { valid: true };
  }

  /**
   * 生成默认配置
   * @returns {object} 默认配置
   */
  generateDefaultConfig() {
    const config = {};
    for (const group of Object.values(this._properties)) {
      for (const [fieldId, prop] of Object.entries(group)) {
        config[fieldId] = prop.defaultValue;
      }
    }
    return config;
  }
}

module.exports = ThingModelMapper;
