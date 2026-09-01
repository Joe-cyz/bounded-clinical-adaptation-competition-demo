# Public snapshot preparation

本文件定义公开快照的发布前边界。当前工作区不是公开仓库，不能直接推送现有 .git 历史。

## Snapshot rule

最终应从脱敏后的当前快照建立一个新的、只有一个提交的公开仓库。不要把现有 Git 日志、历史提交、旧分支、内部证据或本机材料带入新仓库。

公开快照采用 MIT License，许可证正文位于根目录 `LICENSE`。

在仓库安全扫描通过前不得上传。扫描只覆盖脱敏后的公开快照，不读取本地密钥、真实教材或运行时数据。

## Excluded from the public snapshot

- .git/、.env.local、内部代理与操作指令文件；
- 本地临时目录、.next/、node_modules/、data/runtime/；
- 资料/、artifacts/、test-results/ 和 playwright-report*/；
- docs/evidence/ 及内部计划、检查、流程记录和提交映射；
- 真实模型服务 smoke runner、真实麦克风 runner 及其证据；
- 本地语音可执行文件、模型文件、音频和原始比赛 docx/pdf/pptx；
- Git 日志、历史发布材料和任何包含本机路径、密钥或完整正文的文件。

## Public content rules

公开说明只能描述合成数据临床前原型、模型参考、资料检索、资料引用、医生确认和实验性语音功能。模型参考只供医生参考，手工录入是当前可靠入口。不要把工程边界写成临床有效性、诊断能力、处方能力或生产可用性结论。

发布前应再次检查：没有真实个人信息、静态密钥、绝对路径、原始音频、完整模型响应、真实教材或运行时数据库。发现不确定内容时，将文件留在私有归档，不要凭猜测公开。
