// server.js
// 目标：模拟 Modbus-TCP Server，给你的 Web Tester / modbus master 连接测试用。

const ModbusRTU = require("modbus-serial");

const HOLDING_SIZE = 200;
const holding = new Uint16Array(HOLDING_SIZE);

// === 嵌入式视角：这块就像“寄存器映射表” ===
holding[0] = 0x1234; // 例子：随便放个初值，方便你读出来验证链路

const vector = {
  // === 嵌入式视角：读保持寄存器 == 读 4xxxx 映射区（类似读取一段内存/寄存器窗口）===
  getHoldingRegister: (addr) => {
    if (addr < 0 || addr >= HOLDING_SIZE) {
      // 嵌入式视角：越界就像触发 BusFault/参数错误，必须立刻拒绝
      throw new Error(`Illegal data address: ${addr}`);
    }
    return holding[addr];
  },

  // === 嵌入式视角：写保持寄存器 == 写 4xxxx 映射区（类似写某个寄存器）===
  setRegister: (addr, value) => {
    if (addr < 0 || addr >= HOLDING_SIZE) {
      throw new Error(`Illegal data address: ${addr}`);
    }
    holding[addr] = value & 0xffff;
    return;
  },
};

// 502 为 Modbus-TCP 标准端口；建议先用 1502 测试，通了再切 502
const PORT = Number(process.env.PORT || 1502);
const HOST = "0.0.0.0";

// === 嵌入式视角：这里相当于“初始化以太网 + 打开监听端口 + 注册协议处理回调”===
// 在 Node 里，连接/收包不是“中断回调”，而是事件循环分发的事件（见下方解释）
new ModbusRTU.ServerTCP(vector, { host: HOST, port: PORT, debug: true });

console.log(`Modbus-TCP server listening on ${HOST}:${PORT}`);
console.log(`Try connect from your client to ${HOST}:${PORT}`);