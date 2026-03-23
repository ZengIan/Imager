#!/usr/bin/env python3
"""
ModelScope 模型下载脚本
使用 Python SDK 下载模型，支持断点续传
"""

import sys
import os
import json
import re

# 禁用彩色输出
os.environ['NO_COLOR'] = '1'
os.environ['TERM'] = 'dumb'

def strip_ansi(text):
    """移除 ANSI 转义码"""
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

try:
    from modelscope.hub.snapshot_download import snapshot_download
    from modelscope.hub.api import HubApi
except ImportError:
    print(json.dumps({"error": "modelscope 未安装，请执行: pip install modelscope"}))
    sys.exit(1)

def download_model(model_id, local_dir, file_path=None):
    """
    下载模型
    
    Args:
        model_id: 模型ID，如 'Qwen/Qwen3.5-27B'
        local_dir: 本地保存目录
        file_path: 单个文件路径（可选）
    """
    try:
        # 输出开始信息
        print(json.dumps({"status": "starting", "message": f"开始下载模型: {model_id}"}))
        sys.stdout.flush()
        
        # 确保目录存在
        os.makedirs(local_dir, exist_ok=True)
        
        if file_path:
            # 下载单个文件
            print(json.dumps({"status": "downloading", "message": f"下载文件: {file_path}"}))
            sys.stdout.flush()
            
            api = HubApi()
            # 获取文件列表
            files = api.list_model_files(model_id)
            
            if file_path not in files:
                print(json.dumps({"error": f"文件不存在: {file_path}"}))
                sys.exit(1)
            
            # 下载单个文件
            from modelscope.hub.file_download import model_file_download
            local_path = model_file_download(
                model_id=model_id,
                file_path=file_path,
                local_dir=local_dir
            )
            print(json.dumps({"status": "file_completed", "file": file_path, "size": "-"}))
            print(json.dumps({"status": "completed", "message": f"文件下载完成: {local_path}"}))
        else:
            # 下载完整模型
            print(json.dumps({"status": "downloading", "message": "下载完整模型..."}))
            sys.stdout.flush()
            
            # 使用自定义钩子来跟踪文件下载完成
            downloaded_files = []
            
            def download_hook(file_name, file_size):
                """文件下载完成回调"""
                downloaded_files.append(file_name)
                print(json.dumps({"status": "file_completed", "file": file_name, "size": file_size}))
                sys.stdout.flush()
            
            # snapshot_download 本身不支持回调，我们使用另一种方式
            # 先获取文件列表，然后逐个下载
            api = HubApi()
            files = api.list_model_files(model_id)
            
            print(json.dumps({"status": "info", "message": f"共 {len(files)} 个文件"}))
            sys.stdout.flush()
            
            # 下载完整模型
            model_dir = snapshot_download(
                model_id,
                local_dir=local_dir
            )
            print(json.dumps({"status": "completed", "message": f"模型下载完成: {model_dir}"}))
        
        sys.stdout.flush()
        
    except KeyboardInterrupt:
        print(json.dumps({"status": "cancelled", "message": "下载已取消"}))
        sys.exit(130)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "参数不足，需要: model_id local_dir [file_path]"}))
        sys.exit(1)
    
    model_id = sys.argv[1]
    local_dir = sys.argv[2]
    file_path = sys.argv[3] if len(sys.argv) > 3 else None
    
    download_model(model_id, local_dir, file_path)