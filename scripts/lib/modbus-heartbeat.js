/**
 * scripts/lib/modbus-heartbeat.js
 *
 * Modbus TCP keep-alive / heartbeat utilities.
 *
 * During long waits (e.g. waiting for heating state machine to settle),
 * the TCP connection may be silently dropped by firewalls or NAT devices.
 * Periodically reading a register keeps the connection alive.
 *
 * API:
 *   keepAlive(dp, key, intervalMs, stopCondition)
 *     - Reads 3 registers at 0x7088 every intervalMs (default 30s).
 *     - Returns a stop() function; call it to cancel, or pass stopCondition
 *       returning true to auto-stop.
 *
 *   waitForStateChangeWithHeartbeat(dp, key, readFn, expectedValue,
 *                                    timeoutMs, heartbeatIntervalMs)
 *     - Polls readFn() every ~1000ms.
 *     - Sends heartbeat read every heartbeatIntervalMs (default 30s).
 *     - Returns { changed, elapsedMs, value }.
 */

'use strict';

const HEATING_STATE_ADDR = 0x7088;
const HEATING_STATE_REGS = 3;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000; // 30s
const DEFAULT_POLL_INTERVAL_MS = 1_000;       // 1s
const DEFAULT_TIMEOUT_MS = 120_000;           // 2 min

/**
 * Periodically read the heating-state register block (0x7088, 3 regs) to
 * keep the Modbus TCP session alive.
 *
 * @param {object} dp            DevicePool instance
 * @param {string} key           Device key (e.g. "192.168.10.233:1502/1")
 * @param {number} intervalMs    Read interval in ms (default 30 000)
 * @param {Function} [stopCondition]  Called every tick; return truthy to stop
 * @returns {Function} stop      Call to cancel the keep-alive loop
 */
function keepAlive(dp, key, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, stopCondition) {
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await dp.readHoldingRegisters(key, HEATING_STATE_ADDR, HEATING_STATE_REGS);
    } catch (err) {
      console.warn(`[heartbeat] read failed: ${err.message}`);
    }
    if (stopped) return;
    if (typeof stopCondition === 'function') {
      try {
        if (stopCondition()) {
          stop();
          return;
        }
      } catch (_) {
        // stopCondition itself threw -- ignore, keep alive
      }
    }
    timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return stop;
}

/**
 * Poll readFn() for an expected value while sending periodic heartbeat reads
 * to prevent TCP idle disconnects.
 *
 * @param {object}   dp                    DevicePool instance
 * @param {string}   key                   Device key
 * @param {Function} readFn                async () => currentValue
 * @param {*}        expectedValue         Value to match (loose equality)
 * @param {number}   [timeoutMs]           Max wait (default 120 000 ms)
 * @param {number}   [heartbeatIntervalMs] Heartbeat interval (default 30 000 ms)
 * @returns {Promise<{changed: boolean, elapsedMs: number, value: *}>}
 */
async function waitForStateChangeWithHeartbeat(
  dp,
  key,
  readFn,
  expectedValue,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = undefined;
  let changed = false;

  // Start heartbeat timer
  const stopHeartbeat = keepAlive(dp, key, heartbeatIntervalMs);

  try {
    while (Date.now() < deadline) {
      try {
        const value = await readFn();
        lastValue = value;
        if (value === expectedValue || String(value) === String(expectedValue)) {
          changed = true;
          break;
        }
      } catch (err) {
        console.warn(`[heartbeat] poll readFn failed: ${err.message}`);
      }
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    stopHeartbeat();
  }

  return {
    changed,
    elapsedMs: Date.now() - (deadline - timeoutMs),
    value: lastValue,
  };
}

/** Simple promise-based sleep. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { keepAlive, waitForStateChangeWithHeartbeat };
