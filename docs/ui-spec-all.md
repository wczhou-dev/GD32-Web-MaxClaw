# 前端 UI 开发总规约 (UI Spec)

## 1. 核心映射逻辑 (Data Mapping)
前端所有数据必须来自 `deviceStore.js`，严禁组件内直接请求。
数据来源为 WebSocket `sensor_data` 帧中的 `data` 字段（格式见 modbus-tcp-dev-spec.md 第7节）。

### 1.1 传感器数据映射
| 模块          | WS字段                    | 取值方式              | 换算    | 示例变量             |
| :------------ | :------------------------ | :-------------------- | :------ | :------------------- |
| 室内温度 N#   | `data.temp[N-1]`          | 数组取索引（0-based） | 已换算  | `temp[0]`=1#温       |
| 室内湿度 N#   | `data.humi[N-1]`          | 数组取索引（0-based） | 已换算  | `humi[0]`=1#湿       |
| 室内CO2 N#    | `data.co2[N-1]`           | 数组取索引（0-based） | 原值    | `co2[0]`=1#CO2       |
| 室内氨气 N#   | `data.nh3[N-1]`           | 数组取索引（0-based） | 原值    | `nh3[0]`=1#NH3       |
| 室内风速 N#   | `data.wind[N-1]`          | 数组取索引（0-based） | 已换算  | `wind[0]`=1#风       |
| 继电器状态 RN | `data.relays[N-1]`        | 数组取索引（0-based） | boolean | `relays[0]`=R1       |
| DI输入 N#     | `data.digitalInputs[N-1]` | 数组取索引（0-based） | boolean | `di[0]`=DI1          |
| 舍外温度      | `data.outdoorTemp`        | 直接使用              | 已换算  | —                    |
| 舍外湿度      | `data.outdoorHumi`        | 直接使用              | 已换算  | —                    |
| 室内压差 N#   | `data.pressure[N-1]`      | 数组取索引（0-based） | 原值Pa  | `pressure[0]`=1#压差 |

### 1.2 配置参数映射（寄存器直读）
| 模块     | 寄存器地址 | 变量名        | 换算逻辑                  |
| :------- | :--------- | :------------ | :------------------------ |
| 目标温度 | `0x7001`   | `target_temp` | 读：val/10；写：前端值×10 |
| 目标湿度 | `0x7002`   | `target_humi` | 读：val/10；写：前端值×10 |

### 1.3 OTA状态映射
| 模块    | WS字段     | 变量名       | 枚举值（完整）                                              |
| :------ | :--------- | :----------- | :---------------------------------------------------------- |
| OTA进度 | `progress` | `ota_prog`   | 原值 0-100                                                  |
| OTA状态 | `status`   | `ota_status` | 0=空闲/灰, 1=下载中/蓝, 2=校验中/橙, 3=成功/绿, 255=失败/红 |

## 2. 界面功能模块清单

### 2.1 环境仪表盘 (Monitor)
- **布局**：`el-row` 下放置 3-4 个 `el-col`。
- **组件**：`el-card` 包裹 `DataCard` 组件，每张卡片显示传感器编号、数值、单位。
- **逻辑**：数据每1s更新，读取超时时卡片边缘显示红色警告框。
- **展示字段**：温度（1#-16#）、湿度（1#-16#）、CO2（1#-8#）、氨气（1#-4#）、风速（1#-12#）、压差（1#-4#）、舍外温湿度。

### 2.2 继电器控制与反馈表 (Relay Manager)
- **布局**：`el-table`（22行，对应R1-R22）。
- **列定义**：
  - 列1：继电器编号（R1-R22，显示时 index+1）。
  - 列2：物理反馈状态（`StatusLight` 组件，数据来自 `data.relays[i]`）。
  - 列3：操作列（`el-switch`，写入时发送 `relay_control` 帧，`relayIndex=i`，0-based）。
- **写入规则**：
  - 点击开关 → 发送 WebSocket 下行帧 `relay_control`，`relayIndex` 为 0-based 索引。
  - 后端负责读-改-写位图，前端无需处理位运算。
  - 必须有 `el-popconfirm` 二次确认弹窗。

### 2.3 OTA 升级中心 (OTA Center)
- **布局**：单独 `el-card`，标题"远程升级控制"。
- **内容**：
  - `el-input`：输入目标版本号（整数，如201）。
  - `el-upload`：限制上传 `.rbl` 文件，调用 `POST /api/ota/upload`。
  - `el-progress`：绑定 `ota_prog`（0-100）。
  - `el-alert`：根据 `ota_status` 枚举动态显示：
    - 0：灰色，"待机"
    - 1：蓝色，"下载中..."
    - 2：橙色，"校验中..."
    - 3：绿色，"升级成功"
    - 255：红色，"升级失败，请重试"
  - 升级按钮必须有 `el-popconfirm` 二次确认。

## 3. 原子组件规范

| 组件名            | 必须接收的 Props            | 说明                                |
| :---------------- | :-------------------------- | :---------------------------------- |
| `StatusLight.vue` | `status` (boolean), `label` | 亮绿=true/ON，暗灰=false/OFF        |
| `DataCard.vue`    | `value`, `unit`, `label`    | 自动保留1位小数，单位显示在数值右侧 |
| `RelayButton.vue` | `index` (0-based), `status` | 内置popconfirm，点击emit事件        |

## 4. 页面开发约束

1. **全局状态**：严禁在 Vue 组件中使用 `axios` 或直接操作 WebSocket。所有数据由 `deviceStore.js` 统一管理并导出为响应式 `ref`。
2. **离线联动**：当 `deviceStore.modbusConnection === false` 时，页面覆盖灰色蒙层显示"设备离线"，禁用所有操作按钮。
3. **交互确认**：所有继电器控制和OTA触发操作必须有 `el-popconfirm` 二次确认。
4. **索引统一**：前端展示用1-based（R1、1#传感器），内部数组操作和WebSocket传参一律0-based，转换在 `deviceStore.js` 中统一处理。