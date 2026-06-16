/**
 * backend/ate/fieldConfigs/fieldTypeC.js
 * 大王场区（配置类型 C）传感器地址表
 *
 * 数据来源：《传感器地址汇总.pdf》第7页起
 * 与配置 B 的差异：仅室外 TH 地址不同（0x24 vs 0x04）
 */

'use strict';

module.exports = {
  fieldType: 'C',
  fieldCode: 3,
  name: '大王场区',

  tempHumi: {
    indoor: [
      { index: 1,  key: 'temp_1',  slaveAddr: 0x01 },
      { index: 2,  key: 'temp_2',  slaveAddr: 0x02 },
      { index: 3,  key: 'temp_3',  slaveAddr: 0x03 },
      { index: 4,  key: 'temp_4',  slaveAddr: 0x07 },
      { index: 5,  key: 'temp_5',  slaveAddr: 0x08 },
      { index: 6,  key: 'temp_6',  slaveAddr: 0x09 },
      { index: 7,  key: 'temp_7',  slaveAddr: 0x19 },
      { index: 8,  key: 'temp_8',  slaveAddr: 0x1A },
      { index: 9,  key: 'temp_9',  slaveAddr: 0x1B },
      { index: 10, key: 'temp_10', slaveAddr: 0x1C },
      { index: 11, key: 'temp_11', slaveAddr: 0x1D },
      { index: 12, key: 'temp_12', slaveAddr: 0x1E },
      { index: 13, key: 'temp_13', slaveAddr: 0x1F },
      { index: 14, key: 'temp_14', slaveAddr: 0x20 },
      { index: 15, key: 'temp_15', slaveAddr: 0x21 },
      { index: 16, key: 'temp_16', slaveAddr: 0x22 },
    ],
    outdoor: [
      { key: 'outdoor_th', slaveAddr: 0x24 },            // B: 0x04, A: 0x18
    ],
    waterCurtain: [
      { index: 1, key: 'water_1', slaveAddr: 0x13 },
      { index: 2, key: 'water_2', slaveAddr: 0x12 },
      { index: 3, key: 'water_3', slaveAddr: 0x43 },
      { index: 4, key: 'water_4', slaveAddr: 0x44 },
    ],
    highPosition: [
      { index: 1, key: 'high_h1', slaveAddr: 0x33 },
      { index: 2, key: 'high_h2', slaveAddr: 0x34 },
    ],
  },

  co2: [
    { index: 1, key: 'co2_1', slaveAddr: 0x05 },
    { index: 2, key: 'co2_2', slaveAddr: 0x10 },
    { index: 3, key: 'co2_3', slaveAddr: 0x11 },
    { index: 4, key: 'co2_4', slaveAddr: 0x14 },
    { index: 5, key: 'co2_5', slaveAddr: 0x15 },
    { index: 6, key: 'co2_6', slaveAddr: 0x16 },
    { index: 7, key: 'co2_7', slaveAddr: 0x17 },
    { index: 8, key: 'co2_8', slaveAddr: 0x18 },
  ],

  pressure: {
    indoor: [
      { index: 1, key: 'press_1', slaveAddr: 0x0B },
      { index: 2, key: 'press_2', slaveAddr: 0x28 },
      { index: 3, key: 'press_3', slaveAddr: 0x29 },
      { index: 4, key: 'press_4', slaveAddr: 0x2A },
    ],
    outdoor: [
      { key: 'press_outdoor', slaveAddr: 0x35 },
    ],
  },

  nh3: [
    { index: 1, key: 'nh3_1', slaveAddr: 0x06 },
    { index: 2, key: 'nh3_2', slaveAddr: 0x37 },
    { index: 3, key: 'nh3_3', slaveAddr: 0x38 },
    { index: 4, key: 'nh3_4', slaveAddr: 0x39 },
  ],

  serial: {
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
  },
};
