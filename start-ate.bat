@echo off
chcp 65001 >nul
echo ========================================
echo   GD32 ATE 自动化测试系统启动中...
echo ========================================
echo.

REM 切换到脚本所在目录
cd /d %~dp0

REM 检查 Node.js 是否安装
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)

REM 显示 Node.js 版本
echo [信息] Node.js 版本：
node -v
echo.

REM 检查后端依赖是否安装
if not exist "backend\node_modules" (
    echo [信息] 正在安装后端依赖...
    cd backend
    call npm install
    cd ..
    echo.
)

REM 检查前端依赖是否安装
if not exist "frontend\node_modules" (
    echo [信息] 正在安装前端依赖...
    cd frontend
    call npm install
    cd ..
    echo.
)

REM 检查前端是否已构建
if not exist "frontend\dist" (
    echo [信息] 正在构建前端...
    cd frontend
    call npm run build
    cd ..
    echo.
)

echo ========================================
echo   启动后端服务...
echo ========================================
echo.

REM 启动后端服务（新窗口）
cd backend
start "ATE Backend" cmd /c "node server.js && pause"
cd ..

REM 等待服务启动
echo [信息] 等待服务启动...
timeout /t 3 /nobreak > nul

REM 打开浏览器
echo [信息] 正在打开浏览器...
start http://localhost:3000

echo.
echo ========================================
echo   ✅ ATE 系统启动成功！
echo ========================================
echo.
echo 📍 访问地址: http://localhost:3000
echo.
echo 提示：
echo   - 后端服务在新窗口中运行
echo   - 关闭后端窗口可停止服务
echo   - 按任意键关闭此窗口...
echo.
pause > nul
