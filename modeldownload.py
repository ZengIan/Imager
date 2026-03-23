#!/usr/bin/env python3
"""
ModelScope 模型下载脚本
使用 Python SDK 下载模型，支持断点续传和取消
"""

import sys
import os
import json
import signal

# 禁用彩色输出
os.environ['NO_COLOR'] = '1'
os.environ['TERM'] = 'dumb'

CANCEL_DIR = '/tmp/modelscope_cancel'

def get_cancel_file(task_id):
    return os.path.join(CANCEL_DIR, f'{task_id}.cancel')

def create_cancel_marker(task_id):
    """创建取消标记文件"""
    os.makedirs(CANCEL_DIR, exist_ok=True)
    with open(get_cancel_file(task_id), 'w') as f:
        f.write(str(os.getpid()))

def check_cancel(task_id):
    """检查是否需要取消"""
    return os.path.exists(get_cancel_file(task_id))

def remove_cancel_marker(task_id):
    """删除取消标记"""
    cancel_file = get_cancel_file(task_id)
    if os.path.exists(cancel_file):
        os.remove(cancel_file)

def cancel_download(task_id):
    """取消下载"""
    cancel_file = get_cancel_file(task_id)
    if os.path.exists(cancel_file):
        try:
            with open(cancel_file, 'r') as f:
                pid = int(f.read().strip())
            try:
                os.kill(pid, 9)  # SIGKILL
            except ProcessLookupError:
                pass
            os.remove(cancel_file)
            print(json.dumps({"status": "cancelled", "message": f"任务已取消"}))
        except:
            os.remove(cancel_file)
            print(json.dumps({"status": "cancelled", "message": f"任务已取消"}))
    else:
        print(json.dumps({"status": "not_found", "message": f"任务不存在或已结束"}))

try:
    from modelscope.hub.snapshot_download import snapshot_download
    from modelscope.hub.file_download import model_file_download
except ImportError:
    print(json.dumps({"error": "modelscope 未安装，请执行: pip install modelscope"}))
    sys.exit(1)

def download_model(model_id, local_dir, task_id=None, file_path=None):
    """
    下载模型

    Args:
        model_id: 模型ID
        local_dir: 本地保存目录
        task_id: 任务ID（用于取消）
        file_path: 单个文件路径（可选）
    """
    try:
        # 创建取消标记
        if task_id:
            create_cancel_marker(task_id)

        # 确保目录存在
        os.makedirs(local_dir, exist_ok=True)

        if file_path:
            # 下载单个文件
            local_path = model_file_download(
                model_id=model_id,
                file_path=file_path,
                local_dir=local_dir
            )
            print(json.dumps({"status": "completed", "message": f"文件下载完成: {file_path}"}))
        else:
            # 下载完整模型
            model_dir = snapshot_download(
                model_id,
                local_dir=local_dir
            )
            print(json.dumps({"status": "completed", "message": f"模型下载完成: {model_id}"}))

        # 完成后删除取消标记
        if task_id:
            remove_cancel_marker(task_id)

        sys.stdout.flush()

    except KeyboardInterrupt:
        if task_id:
            remove_cancel_marker(task_id)
        print(json.dumps({"status": "cancelled", "message": "下载已取消"}))
        sys.exit(130)
    except Exception as e:
        if task_id:
            remove_cancel_marker(task_id)
        error_msg = str(e)
        if 'Killed' in error_msg or 'Signal' in error_msg:
            print(json.dumps({"status": "cancelled", "message": "下载已取消"}))
            sys.exit(130)
        print(json.dumps({"error": error_msg}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "参数不足"}))
        sys.exit(1)

    if sys.argv[1] == '--cancel':
        # 取消下载
        if len(sys.argv) < 3:
            print(json.dumps({"error": "需要任务ID"}))
            sys.exit(1)
        cancel_download(sys.argv[2])
    else:
        # 下载模型: task_id model_id local_dir [file_path]
        if len(sys.argv) < 4:
            print(json.dumps({"error": "参数不足，需要: task_id model_id local_dir [file_path]"}))
            sys.exit(1)

        task_id = sys.argv[1]
        model_id = sys.argv[2]
        local_dir = sys.argv[3]
        file_path = sys.argv[4] if len(sys.argv) > 4 else None

        download_model(model_id, local_dir, task_id=task_id, file_path=file_path)