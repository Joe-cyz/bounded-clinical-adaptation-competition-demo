# 中文门诊病例演示网页

这是作者为“四新”比赛制作的网页案例。项目使用虚构病例和合成资料，演示门诊记录从建立、填写、查阅参考资料到最终确认的大致过程。

这个项目只用于比赛展示、学习和研究，不能用于真实诊疗，也不能代替医生判断。

## 最简单的启动方式（Windows）

如果你拿到的是 `门诊病例演示-Windows便携版.zip`：

1. 解压整个压缩包；
2. 双击 `启动演示.cmd`；
3. 等待浏览器自动打开。

便携版已经包含运行环境，不需要安装 Node.js、pnpm 或其他依赖。

## 从源代码启动

### Windows

1. 电脑需要先安装 [Node.js 24](https://nodejs.org/en/download)。
2. 下载并解压项目。
3. 双击根目录里的 `start-demo.cmd`。

第一次启动会自动安装网页所需的依赖，完成后浏览器会打开演示页面。以后再次启动只需双击同一个文件。停止运行时，关闭启动窗口或按 `Ctrl+C`。

### macOS / Linux

在项目目录运行：

```bash
chmod +x start-demo.sh
./start-demo.sh
```

## 网页内容

- 预置的虚构门诊病例；
- 病历填写与版本记录；
- 参考信息和资料检索页面；
- 诊疗内容复核与最终确认页面；
- 只使用本地合成数据的演示环境。

一键启动不会连接真实模型服务，也不会启用麦克风。演示过程中请只填写虚构内容，不要输入真实患者信息。

## 开发者运行

```bash
pnpm install --frozen-lockfile
pnpm dev
```

浏览器访问 `http://localhost:3000`。测试命令为：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

更多说明见 [当前功能](docs/current-status.md)、[操作指南](docs/beginner-operation-guide.md) 和 [项目结构](docs/architecture.md)。

## 开源许可

本项目使用 [MIT License](LICENSE)。所有病例和演示资料均为合成内容。
