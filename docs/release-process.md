# 发布检查清单

本流程用于保证 package、Tag、Release 和文档始终指向同一个版本，避免新版本覆盖或隐藏旧版本。

## 发布前

1. 确认本次版本号遵循语义化版本。
2. 同步更新：
   - `package.json`
   - `package-lock.json`
   - `.codex-plugin/plugin.json`
   - `README.md` 当前版本
   - `CHANGELOG.md` 公开发布条目
3. 运行：

   ```powershell
   npm ci
   npm run check
   npm run verify:v1
   ```

4. 确认 Actions 的 `verify` 工作流通过。

## 创建版本

1. 将发布提交合并到 `main`。
2. 在该发布提交上创建唯一 Tag：`v<package.json version>`。
3. 在 GitHub Releases 中选择这个已存在的 Tag 创建 Release。
4. Alpha 版本标记为 Pre-release。
5. Release 正文写明实际历史发布日期、主要变化、验证结果与已知边界。
6. 打开 Releases 与 Tags 页面，确认旧版本仍存在且各自指向正确提交。

## 规则

- 没有独立发布提交、Tag 和 Release 的版本只能称为“内部构建”。
- 不移动或复用已经公开的版本 Tag。
- 不删除旧 Release 来更新新版本。
- 当前未提供安装包时，必须明确写明 Release 仅包含源码。
