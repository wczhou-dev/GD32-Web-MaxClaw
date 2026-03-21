import time
import os
import sys
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from datetime import datetime

class CursorAgentMonitor(FileSystemEventHandler):
    
    IGNORE_DIRS = {'.git', 'node_modules', '__pycache__', '.vscode'}
    TRACK_EXTENSIONS = {'.js', '.vue', '.json', '.md', '.env'}
    
    def __init__(self):
        self.change_log = []
    
    def should_ignore(self, path):
        parts = path.replace('\\', '/').split('/')
        return any(d in self.IGNORE_DIRS for d in parts)
    
    def on_created(self, event):
        if event.is_directory or self.should_ignore(event.src_path):
            return
        ext = os.path.splitext(event.src_path)[1]
        if ext in self.TRACK_EXTENSIONS:
            self._log('🆕 新建', event.src_path)

    def on_modified(self, event):
        if event.is_directory or self.should_ignore(event.src_path):
            return
        ext = os.path.splitext(event.src_path)[1]
        if ext in self.TRACK_EXTENSIONS:
            self._log('✏️  修改', event.src_path)

    def on_deleted(self, event):
        if event.is_directory or self.should_ignore(event.src_path):
            return
        self._log('🗑️  删除', event.src_path)

    def _log(self, action, path):
        timestamp = datetime.now().strftime('%H:%M:%S')
        rel_path = os.path.relpath(path)
        entry = f"[{timestamp}] {action} {rel_path}"
        self.change_log.append(entry)
        print(entry)
        self._check_risk(action, rel_path)
    
    def _check_risk(self, action, path):
        risks = {
            '.env':         '⚠️  警告：Agent 正在修改环境变量文件！',
            'package.json': '⚠️  警告：Agent 正在修改依赖配置！',
            '.cursorrules': '🚨 高危：Agent 正在修改自身规则文件！',
        }
        filename = os.path.basename(path)
        if filename in risks:
            print(risks[filename])
        
        recent_deletes = [x for x in self.change_log[-10:] if '删除' in x]
        if len(recent_deletes) >= 3:
            print('🚨 高危：Agent 短时间内删除多个文件，请立即检查！')

if __name__ == "__main__":
    watch_path = sys.argv[1] if len(sys.argv) > 1 else "."
    
    monitor = CursorAgentMonitor()
    observer = Observer()
    observer.schedule(monitor, watch_path, recursive=True)
    observer.start()
    
    print(f"🕵️  Cursor Agent 文件监控已启动")
    print(f"📂 监控路径: {os.path.abspath(watch_path)}")
    print(f"📋 追踪类型: .js .vue .json .md .env")
    print(f"─────────────────────────────────────")
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print(f"\n📊 本次会话共追踪到 {len(monitor.change_log)} 次文件变动")
        with open('agent-session.log', 'w', encoding='utf-8') as f:
            f.write('\n'.join(monitor.change_log))
        print("💾 日志已保存至 agent-session.log")
    
    observer.join()

