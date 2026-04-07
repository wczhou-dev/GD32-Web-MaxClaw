/**
 * DataParser.js - 数据解析器
 * 
 * 类比嵌入式：
 * - Modbus返回的是原始字节数据，需要解析
 * - 就像UART接收到的数据帧需要按协议解析一样
 * - 这里负责把寄存器值转换为实际的物理量
 */

// ==================== 寄存器地址定义 ====================

const REG = {
    // 系统区
    HEARTBEAT: 0x0000,
    CONTROL_MODE: 0x0001,
    
    // OTA区
    OTA_TRIGGER: 0x0100,
    OTA_VERSION: 0x0101,
    OTA_PROGRESS: 0x0150,
    OTA_STATUS: 0x0151,
    
    // 环境传感器区（16路温湿度）
    TEMP_START: 0x1001,      // 1#温度
    HUMI_START: 0x1002,      // 1#湿度
    CO2_START: 0x1021,        // 1#CO2
    NH3_START: 0x1029,        // 1#氨气
    WIND_START: 0x102D,      // 1#风速
    
    // 室外/气象
    OUTDOOR_TEMP: 0x1039,
    OUTDOOR_HUMI: 0x103A,
    PRESSURE_START: 0x1042,   // 1#压差
    
    // 硬件区
    RELAY_STATUS: 0x4001,    // 继电器状态（uint32，bit0=R1）
    RELAY_CMD: 0x5001,       // 继电器指令（写入用）
    AO1_FEEDBACK: 0x4003,
    AO2_FEEDBACK: 0x4004,
    DI_STATUS: 0x4007,       // 数字输入状态
    AI1: 0x4008,
    AI2: 0x4009,
    AI3: 0x400A,
    AI4: 0x400B,
    
    // 配置区
    TARGET_TEMP: 0x7001,
    TARGET_HUMI: 0x7002,
    PIG_COUNT: 0x7003,
    BUILDING_NO: 0x7004,
    UNIT_NO: 0x7005,
    PIG_AGE: 0x7006,
    PIG_WEIGHT: 0x7007,
    HEALTH_STATUS: 0x7008,
    BUILDING_TYPE: 0x7009
};

// ==================== 数据块定义 ====================

/**
 * 定义Modbus轮询的数据块
 * 类比：就像定义不同类型的数据包结构体
 */
const BLOCKS = {
    BLOCK_SYS: { start: 0x0000, end: 0x0018, name: '系统信息' },
    BLOCK_OTA: { start: 0x0100, end: 0x0101, name: 'OTA控制' },
    BLOCK_OTA_S: { start: 0x0150, end: 0x0151, name: 'OTA状态' },
    // 【关键修复】将原先一次性读取 72 个寄存器拆分为两次读取，减轻网络层压力
    BLOCK_ENV_1: { start: 0x1001, end: 0x1028, name: '环境传感器(温湿度/CO2)' },
    BLOCK_ENV_2: { start: 0x1029, end: 0x1048, name: '环境传感器(氨气/风速/外围等)' },
    BLOCK_HW: { start: 0x4001, end: 0x400B, name: '硬件状态' },
    BLOCK_CFG: { start: 0x7001, end: 0x7009, name: '配置参数' }
};

// ==================== 解析器类 ====================

class DataParser {
    constructor() {
        this.REG = REG;
        this.BLOCKS = BLOCKS;
    }

    /**
     * 解析温度值
     * @param {number} raw - 原始寄存器值
     * @returns {number} - 摄氏温度（保留1位小数）
     * 
     * 类比：就像ADC原始值转换为物理量
     * 例：282 -> 28.2℃
     */
    parseTemp(raw) {
        // int16，需要处理符号
        const signed = Int16Array.of(raw)[0];
        return (signed / 10).toFixed(1);
    }

    /**
     * 解析湿度值
     * @param {number} raw - 原始寄存器值
     * @returns {number} - 湿度百分比
     * 
     * 例：650 -> 65.0%
     */
    parseHumi(raw) {
        return (raw / 10).toFixed(1);
    }

    /**
     * 解析风速
     * @param {number} raw - 原始寄存器值
     * @returns {number} - 风速 m/s
     * 
     * 例：12 -> 1.2 m/s
     */
    parseWind(raw) {
        return (raw / 10).toFixed(1);
    }

    /**
     * 解析CO2（原值）
     * @param {number} raw - ppm
     */
    parseCO2(raw) {
        return raw;
    }

    /**
     * 解析氨气（原值）
     * @param {number} raw - ppm
     */
    parseNH3(raw) {
        return raw;
    }

    /**
     * 解析压差（原值，单位Pa）
     * @param {number} raw - Pa
     */
    parsePressure(raw) {
        return raw;
    }

    /**
     * 解析继电器状态位图
     * @param {number} uint32Val - uint32值
     * @param {number} count - 继电器数量（默认22）
     * @returns {boolean[]} - 继电器状态数组
     * 
     * 类比：就像解析GPIO端口的位状态
     * bit0 = R1ON, bit1 = R2ON, ...
     */
    parseRelayStatus(uint32Val, count = 22) {
        const result = [];
        for (let i = 0; i < count; i++) {
            result.push(Boolean((uint32Val >> i) & 1));
        }
        return result;
    }

    /**
     * 解析DI数字输入状态
     * @param {number} uint16Val - DI端口值
     * @param {number} count - DI数量（默认10）
     * @returns {boolean[]} - DI状态数组
     */
    parseDIStatus(uint16Val, count = 10) {
        const result = [];
        for (let i = 0; i < count; i++) {
            result.push(Boolean((uint16Val >> i) & 1));
        }
        return result;
    }

    /**
     * 解析AO反馈值
     * @param {number} raw - 原始值
     * @returns {number} - 转速等
     */
    parseAO(raw) {
        return raw;
    }

    /**
     * 解析整条传感器数据
     * @param {Object} blocks - 各数据块的内容
     * @returns {Object} - 解析后的传感器数据
     * 
     * 类比：就像完整解析一帧传感器数据
     */
    parseSensorData(blocks) {
        const result = {
            timestamp: Date.now()
        };

        // 解析16路温湿度
        result.temp = [];
        result.humi = [];
        
        if (blocks.env) {
            // 温湿度从0x1001开始，交替排列：温度、湿度、温度、湿度...
            // 寄存器索引对应：0x1001=1#温度, 0x1002=1#湿度, ...
            for (let i = 0; i < 16; i++) {
                const tempIdx = i * 2;      // 温度索引
                const humiIdx = i * 2 + 1;  // 湿度索引
                
                if (tempIdx < blocks.env.length) {
                    result.temp.push(this.parseTemp(blocks.env[tempIdx]));
                } else {
                    result.temp.push(null);
                }
                
                if (humiIdx < blocks.env.length) {
                    result.humi.push(this.parseHumi(blocks.env[humiIdx]));
                } else {
                    result.humi.push(null);
                }
            }

            // 解析8路CO2 (0x1021 - 0x1028)
            result.co2 = [];
            const co2StartIdx = 0x1021 - 0x1001;  // = 0x20 = 32
            for (let i = 0; i < 8; i++) {
                const idx = co2StartIdx + i;
                if (idx < blocks.env.length) {
                    result.co2.push(this.parseCO2(blocks.env[idx]));
                } else {
                    result.co2.push(null);
                }
            }

            // 解析4路氨气 (0x1029 - 0x102C)
            result.nh3 = [];
            const nh3StartIdx = 0x1029 - 0x1001;  // = 0x28 = 40
            for (let i = 0; i < 4; i++) {
                const idx = nh3StartIdx + i;
                if (idx < blocks.env.length) {
                    result.nh3.push(this.parseNH3(blocks.env[idx]));
                } else {
                    result.nh3.push(null);
                }
            }

            // 解析12路风速 (0x102D - 0x1038)
            result.wind = [];
            const windStartIdx = 0x102D - 0x1001;  // = 0x2C = 44
            for (let i = 0; i < 12; i++) {
                const idx = windStartIdx + i;
                if (idx < blocks.env.length) {
                    result.wind.push(this.parseWind(blocks.env[idx]));
                } else {
                    result.wind.push(null);
                }
            }

            // 解析室外温湿度 (0x1039, 0x103A)
            const outdoorTempIdx = 0x1039 - 0x1001;  // = 0x38 = 56
            const outdoorHumiIdx = 0x103A - 0x1001; // = 0x39 = 57
            
            if (outdoorTempIdx < blocks.env.length) {
                result.outdoorTemp = this.parseTemp(blocks.env[outdoorTempIdx]);
            }
            if (outdoorHumiIdx < blocks.env.length) {
                result.outdoorHumi = this.parseHumi(blocks.env[outdoorHumiIdx]);
            }

            // 解析4路压差 (0x1042 - 0x1045)
            result.pressure = [];
            const pressureStartIdx = 0x1042 - 0x1001;  // = 0x41 = 65
            for (let i = 0; i < 4; i++) {
                const idx = pressureStartIdx + i;
                if (idx < blocks.env.length) {
                    result.pressure.push(this.parsePressure(blocks.env[idx]));
                } else {
                    result.pressure.push(null);
                }
            }
        }

        // 解析硬件状态
        if (blocks.hw) {
            // 继电器状态 (0x4001, 0x4002) - uint32
            if (blocks.hw.length >= 2) {
                const relayVal = (blocks.hw[0] << 16) | blocks.hw[1];
                result.relays = this.parseRelayStatus(relayVal, 22);
            } else {
                result.relays = new Array(22).fill(false);
            }

            // DI状态 (0x4007)
            if (blocks.hw.length >= 7) {
                const diVal = blocks.hw[6];  // 0x4007 - 0x4001 = 6
                result.digitalInputs = this.parseDIStatus(diVal, 10);
            } else {
                result.digitalInputs = new Array(10).fill(false);
            }

            // AO反馈 (0x4003, 0x4004)
            result.ao = [];
            if (blocks.hw.length >= 4) {
                result.ao.push(this.parseAO(blocks.hw[2]));  // 0x4003
                result.ao.push(this.parseAO(blocks.hw[3]));  // 0x4004
            } else {
                result.ao = [0, 0];
            }
        } else {
            result.relays = new Array(22).fill(false);
            result.digitalInputs = new Array(10).fill(false);
            result.ao = [0, 0];
        }

        return result;
    }

    /**
     * 生成继电器控制位图
     * @param {number} currentValue - 当前寄存器值
     * @param {number} relayIndex - 继电器索引（0-based, 0=R1）
     * @param {boolean} value - true=ON, false=OFF
     * @returns {number} - 新的寄存器值
     * 
     * 类比：就像修改GPIO端口的特定位
     */
    generateRelayControl(currentValue, relayIndex, value) {
        if (value) {
            // 置位该位（ON）
            return currentValue | (1 << relayIndex);
        } else {
            // 清零该位（OFF）
            return currentValue & ~(1 << relayIndex);
        }
    }
}

module.exports = DataParser;
