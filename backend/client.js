// client.js
// 功能：作为 Modbus-TCP 主站（Master）连接本机 127.0.0.1:1502，
//       每隔 1 秒读取一次保持寄存器地址 0x01（读 1 个寄存器）。
//
// === 硬核/嵌入式视角类比（重要）===
// - connectTCP()          -> 初始化以太网 + 建立 TCP 连接（像 lwIP 的 connect）
// - readHoldingRegisters  -> 主站发起 Request（构造/发送 Modbus ADU）
// - Promise await         -> 等待“从机 ACK + 应答帧”返回（像阻塞等待/事件等待）
// - then/await 后的处理    -> “中断回调/事件回调”里解析应答并更新状态机
// - try/catch             -> Error_Handler/HardFault：任何异常都要抓住并进入重连流程

const ModbusRTU = require("modbus-serial");

const HOST = process.env.MB_HOST || "127.0.0.1";
const PORT = Number(process.env.MB_PORT || 1502);
const UNIT_ID = Number(process.env.MB_UNIT_ID || 1);

const READ_ADDR = 0x01; // 你要求读保持寄存器 0x01
const READ_LEN = 1;
const PERIOD_MS = 1000;
const RECONNECT_MS = 1000;
const TIMEOUT_MS = 1000;

const client = new ModbusRTU();
client.setTimeout(TIMEOUT_MS);

let pollTimer = null;
let reconnectTimer = null;
let connecting = false;

function stopTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  // === 嵌入式视角：链路掉线/超时 -> 置错误标志位，退回“重连状态”，延时后再尝试 ===
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectAndStartPolling();
  }, RECONNECT_MS);
}

async function connectAndStartPolling() {
  if (connecting) return;
  connecting = true;

  stopTimers();

  try {
    // === 嵌入式视角：主站上电初始化阶段 ===
    // 1) 建立 TCP 连接（相当于：准备好“发送请求”的物理链路）
    await client.connectTCP(HOST, { port: PORT });

    // 2) 设置从站地址（Unit ID）
    //    嵌入式类比：多从站挂在同一总线时，主站要在帧里带上从站地址
    client.setID(UNIT_ID);

    console.log(`[MB] Connected to ${HOST}:${PORT}, unitId=${UNIT_ID}`);

    // === 嵌入式视角：进入主循环 while(1) 的“周期任务” ===
    // 周期 1s：发起一次读请求 -> 等待应答 -> 在回调/事件里处理结果
    pollTimer = setInterval(async () => {
      try {
        // === 主站发起 Request ===
        // 发送：Function Code 0x03（Read Holding Registers）
        const resp = await client.readHoldingRegisters(READ_ADDR, READ_LEN);

        // === 等待从机 ACK / 应答完成后，进入“回调处理” ===
        // 在 Node 里不是硬件 ISR，而是事件循环把“收包完成”这个事件派发到这里执行。
        const value = resp?.data?.[0];
        console.log(
          `[MB] HR[0x${READ_ADDR.toString(16).padStart(2, "0")}] = 0x${Number(
            value
          )
            .toString(16)
            .padStart(4, "0")} (${value})`
        );
      } catch (err) {
        // === Error_Handler：一次请求失败 ===
        // 典型原因：超时、连接断开、对端复位、地址非法等
        console.error(`[MB] Read failed: ${err?.message || err}`);

        // 主动关闭连接，回到“重连状态机”
        try {
          client.close(() => {});
        } catch (_) {}
        stopTimers();
        scheduleReconnect();
      }
    }, PERIOD_MS);
  } catch (err) {
    // === Error_Handler：连接阶段失败 ===
    console.error(`[MB] Connect failed: ${err?.message || err}`);
    try {
      client.close(() => {});
    } catch (_) {}
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

// === 嵌入式视角：主程序入口，相当于 main() ===
// Node 的事件循环 ≈ while(1) 主循环 + 事件队列/状态机
void connectAndStartPolling();

process.on("SIGINT", () => {
  console.log("\n[MB] SIGINT, closing.");
  stopTimers();
  try {
    client.close(() => {});
  } catch (_) {}
  process.exit(0);
});

