# 贡献指南

感谢你帮助改进小破软件。

## 开始之前

- 普通缺陷和功能建议先创建 Issue；安全漏洞请遵循 [安全政策](SECURITY.md) 私密报告。
- 不要提交 API Key、Cookie、Token、SQLite、日志、参考图、生成视频或私人项目内容。
- 运行环境为 Windows 10/11、Node.js 22.12.0 或更高版本。

## 本地开发

```powershell
git clone https://github.com/FengHaPi/BarelyWorks.git
cd BarelyWorks
npm ci
npm run dev
```

提交前必须运行：

```powershell
npm run check
```

## 提交要求

- 一个 Pull Request 只解决一个明确问题。
- 保留现有版本历史、文件哈希、安全门禁和本地优先边界。
- 行为变化需补充或更新测试与文档。
- 不要把未单独发布的内部构建写成公开版本；发布流程见 [发布检查清单](docs/release-process.md)。
