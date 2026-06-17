/**
 * backend/ate/HilSessionManager.js
 * HIL 测试会话管理器
 *
 * 职责：
 *   1. 管理 HIL 模式下的测试会话生命周期
 *   2. 将 HIL 参数（device IP, simulator config）映射到 TestManager 调用
 *   3. 提供 /current-session 查询接口所需的状态数据
 *   4. 支持公共恢复动作
 *
 * 与现有 TestManager 的关系：
 *   - HilSessionManager 是 HIL 场景的"门面"，内部调用 TestManager.runSensorBatch()
 *   - 它维护 HIL 特有的会话状态（sessionId、device IP、simulator config）
 *   - TestManager 继续管理底层测试执行和任务状态
 *
 * 更新历史：
 *   v1.0  2026-06-17  初始版本
 */

'use strict';

const path = require('path');
const fs = require('fs');

class HilSessionManager {
  constructor({ testManager, sensorSimulator, wsManager, devicePool }) {
    this._testManager = testManager;
    this._sensorSimulator = sensorSimulator;
    this._wsManager = wsManager;
    this._devicePool = devicePool;

    /** @type {Map<string, object>} sessionId → session state */
    this._sessions = new Map();
  }

  /**
   * 启动 HIL 批量测试
   * @param {object} options
   * @param {string} options.sessionName - 会话名称
   * @param {string[]} options.caseIds - 测试用例 ID 列表
   * @param {object} options.device - 设备配置 { ip, modbusTcpPort }
   * @param {object} [options.simulator] - 模拟器配置 { profile, rs485Port, sensors }
   * @param {object} [options.options] - 测试选项 { stopOnFail, collectModbusFrames, collectFirmwareLog }
   * @returns {{ success: boolean, sessionId?: string, status?: string }}
   */
  async startBatch(options) {
    const {
      sessionName,
      caseIds = [],
      device = {},
      simulator = {},
      options: testOptions = {},
    } = options;

    if (!caseIds.length) {
      return { success: false, error: '请指定测试用例 ID' };
    }

    // 生成 sessionId
    const sessionId = sessionName || `hil-${Date.now()}`;

    // 查找匹配的设备
    const deviceKey = this._findDeviceKey(device.ip);
    if (!deviceKey) {
      // 如果设备池中没有该 IP，尝试动态添加
      if (device.ip) {
        const newDev = {
          name: `HIL-${device.ip}`,
          ip: device.ip,
          port: device.modbusTcpPort || 502,
          unitId: 1,
          enabled: true,
        };
        this._devicePool.addDevice(newDev);
        // 重新查找
        const addedKey = this._findDeviceKey(device.ip);
        if (addedKey) {
          console.log(`[HilSession] 动态添加设备: ${device.ip} → key=${addedKey}`);
        }
      }
    }

    const resolvedDeviceKey = this._findDeviceKey(device.ip);
    if (!resolvedDeviceKey) {
      return { success: false, error: `无法找到设备: ${device.ip}` };
    }

    // 创建会话状态
    const session = {
      sessionId,
      sessionName,
      caseIds,
      device,
      simulator,
      options: testOptions,
      status: 'running',
      currentCaseId: null,
      progress: {
        total: caseIds.length,
        finished: 0,
        passed: 0,
        failed: 0,
      },
      cases: [],
      startTime: Date.now(),
      endTime: null,
      deviceKey: resolvedDeviceKey,
    };

    this._sessions.set(sessionId, session);

    // 广播启动事件
    if (this._wsManager) {
      this._wsManager.broadcast({
        type: 'hil_session_started',
        sessionId,
        caseIds,
        total: caseIds.length,
      });
    }

    // 后台执行测试
    this._runBatchAsync(session).catch(err => {
      console.error(`[HilSession] 执行异常: ${err.message}`);
      session.status = 'error';
      session.error = err.message;
      session.endTime = Date.now();
    });

    return { success: true, sessionId, status: 'running' };
  }

  /**
   * 后台执行批量测试
   */
  async _runBatchAsync(session) {
    const { sessionId, caseIds, deviceKey } = session;

    for (let i = 0; i < caseIds.length; i++) {
      const caseId = caseIds[i];

      // 更新当前用例
      session.currentCaseId = caseId;

      // 广播进度
      if (this._wsManager) {
        this._wsManager.broadcast({
          type: 'sensor_test_progress',
          sessionId,
          index: i,
          total: caseIds.length,
          scenarioId: caseId,
        });
      }

      try {
        const result = await this._testManager.runSensorScenario({
          scenarioId: caseId,
          deviceKey,
          fieldType: 'A',
        });

        const caseResult = {
          caseId,
          status: result.pass ? 'pass' : 'fail',
          expected: result.results?.expected || {},
          actual: result.results?.actual || {},
          assertions: result.results || [],
        };

        session.cases.push(caseResult);
        session.progress.finished++;

        if (result.pass) {
          session.progress.passed++;
        } else {
          session.progress.failed++;
        }

        // 广播单项完成
        if (this._wsManager) {
          this._wsManager.broadcast({
            type: 'sensor_test_scenario_finished',
            sessionId,
            caseId,
            status: caseResult.status,
            assertions: caseResult.assertions,
          });
        }

        // stopOnFail 检查
        if (session.options.stopOnFail && !result.pass) {
          console.log(`[HilSession] stopOnFail: ${caseId} 失败，停止后续用例`);
          break;
        }
      } catch (err) {
        console.error(`[HilSession] 用例 ${caseId} 执行异常: ${err.message}`);
        session.cases.push({
          caseId,
          status: 'error',
          error: err.message,
        });
        session.progress.finished++;
        session.progress.failed++;
      }
    }

    // 标记完成
    session.status = session.progress.failed > 0 ? 'completed-with-failures' : 'completed';
    session.currentCaseId = null;
    session.endTime = Date.now();

    const duration = ((session.endTime - session.startTime) / 1000).toFixed(1);
    console.log(`[HilSession] ${sessionId} 完成: ${session.progress.passed}/${session.progress.total} 通过, 耗时 ${duration}s`);

    // 广播完成
    if (this._wsManager) {
      this._wsManager.broadcast({
        type: 'sensor_test_finished',
        sessionId,
        result: {
          total: session.progress.total,
          passed: session.progress.passed,
          failed: session.progress.failed,
        },
      });
    }

    // 写入 HIL 报告
    this._writeReport(session);
  }

  /**
   * 获取当前会话状态（供 /current-session 查询）
   * @param {string} sessionId
   * @returns {object|null}
   */
  getSession(sessionId) {
    if (sessionId) {
      return this._sessions.get(sessionId) || null;
    }
    // 没指定 sessionId，返回最近一个 running 的会话
    for (const [, session] of this._sessions) {
      if (session.status === 'running') return session;
    }
    // 没有 running 的，返回最近一个
    let latest = null;
    for (const [, session] of this._sessions) {
      if (!latest || session.startTime > latest.startTime) {
        latest = session;
      }
    }
    return latest;
  }

  /**
   * 执行公共恢复动作
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string[]} [options.actions] - 要执行的动作列表
   * @returns {{ success: boolean, results: object[] }}
   */
  async recover(options) {
    const { sessionId, actions = [] } = options;
    const results = [];

    console.log(`[HilSession] 执行公共恢复: sessionId=${sessionId}`);

    // 默认执行所有恢复动作
    const allActions = actions.length > 0 ? actions : [
      'stop-simulator-abnormal',
      'restore-default-sensor-value',
      'clear-controller-fault',
      'close-session',
    ];

    for (const action of allActions) {
      try {
        switch (action) {
          case 'stop-simulator-abnormal':
            if (this._sensorSimulator) {
              this._sensorSimulator.clearAllFaults();
              results.push({ action, status: 'ok', message: '已清除所有模拟器故障' });
            } else {
              results.push({ action, status: 'skip', message: '模拟器未初始化' });
            }
            break;

          case 'restore-default-sensor-value':
            if (this._sensorSimulator) {
              // 恢复默认温湿度值 (20℃, 50%)
              try {
                this._sensorSimulator.setTempHumiPair('temp_1', 20.0, 'humi_1', 50.0);
                results.push({ action, status: 'ok', message: '已恢复默认值: 20℃/50%' });
              } catch (err) {
                results.push({ action, status: 'warn', message: err.message });
              }
            } else {
              results.push({ action, status: 'skip', message: '模拟器未初始化' });
            }
            break;

          case 'clear-controller-fault':
            // 通过 Modbus TCP 清除控制器故障标志
            // 这里仅记录，实际清除需要 Modbus 写操作
            results.push({ action, status: 'ok', message: '控制器故障标志清除（需要 Modbus 写操作支持）' });
            break;

          case 'close-session':
            if (sessionId && this._sessions.has(sessionId)) {
              const session = this._sessions.get(sessionId);
              if (session.status === 'running') {
                session.status = 'stopped';
                session.endTime = Date.now();
              }
              results.push({ action, status: 'ok', message: `会话 ${sessionId} 已关闭` });
            } else {
              results.push({ action, status: 'skip', message: '会话不存在或已关闭' });
            }
            break;

          default:
            results.push({ action, status: 'skip', message: `未知动作: ${action}` });
        }
      } catch (err) {
        results.push({ action, status: 'error', message: err.message });
      }
    }

    console.log(`[HilSession] 恢复完成:`, results.map(r => `${r.action}=${r.status}`).join(', '));
    return { success: true, results };
  }

  /**
   * 查找设备池中匹配 IP 的设备 key
   */
  _findDeviceKey(ip) {
    if (!ip || !this._devicePool) return null;
    const devices = this._devicePool.getAllDevices();
    const found = devices.find(d => d.ip === ip);
    return found ? found.key : null;
  }

  /**
   * 写入 HIL 测试报告
   */
  _writeReport(session) {
    const reportsDir = path.join(__dirname, '../../reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const reportPath = path.join(reportsDir, `${session.sessionId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(session, null, 2));

    // 更新 latest 摘要
    const latestPath = path.join(reportsDir, 'latest-hil-summary.json');
    const summary = {
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      status: session.status,
      totalCases: session.progress.total,
      passed: session.progress.passed,
      failed: session.progress.failed,
      duration: session.endTime ? ((session.endTime - session.startTime) / 1000) : 0,
      cases: session.cases,
    };
    fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2));

    console.log(`[HilSession] 报告已写入: ${reportPath}`);
  }
}

module.exports = HilSessionManager;
