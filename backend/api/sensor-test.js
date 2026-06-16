/**
 * backend/api/sensor-test.js
 * P1 传感器自动测试 API
 *
 * 职责：
 *   1. 提供传感器测试场景列表
 *   2. 提供传感器测试执行接口
 *   3. 提供传感器测试报告查询和下载
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const express = require('express');
const router = express.Router();
const TestScenarioCatalog = require('../ate/TestScenarioCatalog');
const { resolveScenarioId } = require('../ate/TestScenarioCatalog');
const SensorReportService = require('../ate/SensorReportService');

const scenarioCatalog = new TestScenarioCatalog();
const reportService = new SensorReportService();

/**
 * GET /api/sensor-test/scenarios
 * 获取全部传感器测试场景列表
 */
router.get('/scenarios', (req, res) => {
  try {
    const scenarios = scenarioCatalog.getAllScenarios().map(s => ({
      id: s.id,
      testId: s.testId || s.id,
      scenarioId: s.scenarioId || s.id,
      parentTestId: s.parentTestId || null,
      name: s.name,
      type: s.type,
      category: s.category,
      group: s.group || s.category,
      priority: s.priority,
      isP1Required: s.isP1Required || false,
      estimatedSeconds: s.estimatedSeconds || 0,
      dependencies: s.dependencies || [],
      timeoutMs: s.timeoutMs,
      description: s.description,
    }));
    res.json({ success: true, scenarios });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sensor-test/scenarios/:id
 * 获取单个场景详情
 */
router.get('/scenarios/:id', (req, res) => {
  try {
    const scenario = scenarioCatalog.loadScenario(req.params.id);
    if (!scenario) {
      return res.status(404).json({ success: false, error: '场景未找到' });
    }
    res.json({ success: true, scenario });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sensor-test/tasks/:taskId
 * 查询任务状态（支持前端刷新/兜底轮询）
 */
router.get('/tasks/:taskId', (req, res) => {
  try {
    const testManager = req.app.get('testManager');
    if (!testManager) {
      return res.status(500).json({ success: false, error: 'TestManager 未初始化' });
    }
    const taskState = testManager.getSensorTaskState(req.params.taskId);
    if (!taskState) {
      return res.status(404).json({ success: false, error: '任务未找到' });
    }
    res.json({ success: true, task: taskState });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sensor-test/run
 * 执行传感器测试
 * Body: { scenarioIds: string[], deviceKey: string, fieldType?: string }
 */
router.post('/run', async (req, res) => {
  try {
    const { scenarioIds, deviceKey, fieldType = 'A' } = req.body;
    if (!scenarioIds || !Array.isArray(scenarioIds) || scenarioIds.length === 0) {
      return res.status(400).json({ success: false, error: '请指定场景 ID 列表' });
    }
    if (!deviceKey) {
      return res.status(400).json({ success: false, error: '请指定设备地址' });
    }

    // 通过全局 TestManager 执行
    const testManager = req.app.get('testManager');
    if (!testManager) {
      return res.status(500).json({ success: false, error: 'TestManager 未初始化' });
    }

    // 解析显示 ID → 真实场景 ID
    const resolvedIds = scenarioIds.map(id => resolveScenarioId(id));

    // 异步执行，返回任务 ID
    const taskId = `sensor-${Date.now()}`;
    const wsManager = req.app.get('wsManager');

    // 初始化任务状态
    testManager.setSensorTaskState(taskId, {
      taskId,
      status: 'running',
      scenarioIds: resolvedIds,
      currentIndex: 0,
      currentScenarioId: null,
      results: [],
      startTime: Date.now(),
      log: [],
    });

    res.json({ success: true, taskId, message: '测试已启动' });

    // 广播开始事件
    if (wsManager) {
      wsManager.broadcast({
        type: 'sensor_test_started',
        taskId,
        scenarioIds: resolvedIds,
        total: resolvedIds.length,
      });
    }

    // 后台执行
    setImmediate(async () => {
      // BE-SENSOR-012: 测试期间暂停该设备的普通轮询
      const pollingEngine = req.app.get('pollingEngine') || req.app.locals?.pollingEngine;
      if (pollingEngine && pollingEngine.markDeviceUnderTest) {
        pollingEngine.markDeviceUnderTest(deviceKey);
      }

      try {
        const result = await testManager.runSensorBatch({
          scenarioIds: resolvedIds,
          deviceKey,
          fieldType,
          taskId,
          onProgress: (progress) => {
            // 更新任务状态
            testManager.updateSensorTaskState(taskId, {
              currentIndex: progress.index,
              currentScenarioId: progress.scenarioId,
            });
            // 广播进度
            if (wsManager) {
              wsManager.broadcast({
                type: 'sensor_test_progress',
                taskId,
                ...progress,
              });
            }
          },
          onScenarioFinished: (scenarioResult) => {
            // 广播单项完成
            if (wsManager) {
              wsManager.broadcast({
                type: 'sensor_test_scenario_finished',
                taskId,
                scenarioId: scenarioResult.scenarioId,
                status: scenarioResult.status,
                assertions: scenarioResult.assertions,
              });
            }
          },
        });

        // 生成报告
        const report = await reportService.generateBatchReport(result);

        // 更新任务状态
        testManager.updateSensorTaskState(taskId, {
          status: result.failed > 0 ? 'fail' : 'pass',
          results: result.results,
          endTime: Date.now(),
          reportFile: report.fileName,
        });

        // 广播完成事件
        if (wsManager) {
          wsManager.broadcast({
            type: 'sensor_test_finished',
            taskId,
            result: {
              total: result.total,
              passed: result.passed,
              failed: result.failed,
              reportFile: report.fileName,
            },
          });
        }
      } catch (err) {
        console.error(`[SensorTest] 执行异常: ${err.message}`);
        testManager.updateSensorTaskState(taskId, {
          status: 'error',
          error: err.message,
          endTime: Date.now(),
        });
        if (wsManager) {
          wsManager.broadcast({
            type: 'sensor_test_error',
            taskId,
            error: err.message,
          });
        }
      } finally {
        // BE-SENSOR-012: 测试结束后恢复普通轮询
        if (pollingEngine && pollingEngine.unmarkDeviceUnderTest) {
          pollingEngine.unmarkDeviceUnderTest(deviceKey);
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sensor-test/stop
 * 停止正在运行的测试任务
 */
router.post('/stop', async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) {
      return res.status(400).json({ success: false, error: '请指定 taskId' });
    }
    const testManager = req.app.get('testManager');
    if (!testManager) {
      return res.status(500).json({ success: false, error: 'TestManager 未初始化' });
    }
    const stopped = testManager.stopSensorTask(taskId);
    if (stopped) {
      testManager.updateSensorTaskState(taskId, { status: 'stopped', endTime: Date.now() });
      const wsManager = req.app.get('wsManager');
      if (wsManager) {
        wsManager.broadcast({ type: 'sensor_test_finished', taskId, result: { stopped: true } });
      }
      res.json({ success: true, message: '已停止' });
    } else {
      res.status(404).json({ success: false, error: '任务未找到或已结束' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sensor-test/reports
 * 获取传感器测试报告列表
 */
router.get('/reports', (req, res) => {
  try {
    const reports = reportService.getReportList();
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sensor-test/reports/:filename
 * 下载传感器测试报告
 */
router.get('/reports/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (filename.endsWith('.json')) {
      const report = reportService.getReport(filename);
      if (!report) {
        return res.status(404).json({ success: false, error: '报告未找到' });
      }
      res.json(report);
    } else if (filename.endsWith('.html')) {
      const htmlPath = require('path').join(
        require('../ate/SensorReportService').prototype._reportDir || '',
        filename
      );
      res.sendFile(htmlPath);
    } else {
      res.status(400).json({ success: false, error: '不支持的文件格式' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
