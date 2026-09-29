# 办公室 Windows 测试服务器连接

推荐通过 Tailscale 私有网络连接 Windows OpenSSH。不需要公网 IP；不需要把远程桌面或 SSH 暴露到公网。当前尚未配置或登录办公室服务器。

## 先确认环境

在办公室服务器的 PowerShell 执行以下只读命令，把输出发回当前对话：

```powershell
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber
Get-Service sshd -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType
Get-Command tailscale -ErrorAction SilentlyContinue | Select-Object Source
```

先确认 Windows Server 版本，再选择其支持的 OpenSSH 安装方式。不要直接在未知版本上安装或修改现有 SSH 服务。

## 连接步骤

1. 当前电脑和办公室服务器安装 [Tailscale](https://tailscale.com/download/windows)，由你登录并加入同一私有网络。账号登录和多因素验证由你完成。
2. 获取办公室服务器的 Tailscale IP；确认当前电脑能访问。地址本身不代表已有操作权限。
3. 服务器启用对应 Windows 版本支持的 OpenSSH Server，准备专用测试账号，通过 SSH 公钥授权。私钥保留在当前电脑；公钥放到服务器测试账号。需要管理员权限的安装操作单独处理。
4. 以实际账号和 Tailscale IP 测试 SSH。防火墙和 Tailscale 访问规则应只允许所需测试来源，配置前先检查已有规则，避免影响其他管理员。
5. 连接后先只读检查系统、可用内存/磁盘、显卡、桌面会话与已有服务。再在独立目录上传初始模板安装包、核验 SHA-256，并开展快速测试。

不要在聊天中发送账户密码或私钥内容，也不要关闭防火墙来排查连接问题。

## 能测试什么

SSH 可用于传文件、运行命令、接口回归、MySQL 备份恢复、检查进程和读取日志。Unity/WebView2 画面、鼠标键盘焦点和投屏需要另外建立可交互桌面会话；Windows Server 的 GPU、驱动及远程桌面渲染不一定与最终 Windows 客户端相同。

本次按用户要求进行快速测试，不自动在服务器启动 72 小时长跑。Linux `124.221.0.245` 已通过 SSH 只读检查，约 2 GiB 内存且交换空间使用较多，可用于轻量后端验证，不能替代 Windows 安装和图形客户端验收。
