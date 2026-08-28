const translations = {
  zh: {
    skip: "跳到正文",
    navPrinciples: "设计原则",
    navWorkflow: "生产流程",
    navQuickstart: "快速开始",
    eyebrow: "Windows 本地优先 · v0.2.0 Alpha",
    heroTitle: "让 AI 视频生产的每一步都有版本和证据。",
    heroLead: "BarelyWorks 把故事转化为可追溯的九阶段视频生产流程，用版本化产物、累计核查、可审计的 Codex 运行和明确的人工门禁控制风险。",
    viewSource: "查看源码",
    browseReleases: "浏览版本",
    heroNote: "付费视频 API 默认关闭，外部生成始终由用户明确触发。",
    evidenceLabel: "发布证据",
    verified: "已验证",
    serverTests: "项服务端测试",
    uiTests: "项 UI 测试",
    browserE2E: "条浏览器 E2E",
    publicReleases: "个公开版本",
    auditVersion: "版本一致性门禁",
    auditCodeql: "CodeQL 与依赖扫描",
    auditMedia: "H.264/AAC 合成媒体验证",
    auditHistory: "独立 Tag 与版本历史",
    principlesKicker: "针对静默失败而设计",
    principlesTitle: "在生成成本变高之前，让整个工作流保持可核查。",
    principlesLead: "BarelyWorks 会明确展示上游错误、证据缺失、过期投递包和供应端失败，不会把未知状态伪装成通过。",
    cardVersionTitle: "版本化产物",
    cardVersionBody: "新修订不会偷偷替换当前 Head、版本血缘或历史审批。",
    cardVerifyTitle: "逐级累计核查",
    cardVerifyBody: "进入后续环节时，重新检查所有适用的上游产物、契约、哈希和批准记录。",
    cardHumanTitle: "人工审核门禁",
    cardHumanBody: "批准、供应端投递、粗剪和最终交付都需要明确操作。",
    cardLocalTitle: "本地优先边界",
    cardLocalBody: "项目原文、SQLite、参考图、生成媒体、交付文件和日志不会进入 Git。",
    workflowKicker: "九阶段生产流程",
    workflowTitle: "任意产物都能修订，所有下游都要重新验证。",
    stage1: "输入内容",
    stage2: "剧情大纲",
    stage3: "影视剧本",
    stage4: "资产定义",
    stage5: "导演脚本",
    stage6: "分镜设计",
    stage7: "视频生成",
    stage8: "质量审核",
    stage9: "剪辑导出",
    quickKicker: "快速开始",
    quickTitle: "在本地运行当前 Alpha。",
    quickLead: "需要 Windows 10/11、Node.js 22.12+、npm 和可运行的 Codex CLI；媒体阶段需要 FFmpeg。",
    copy: "复制",
    copied: "已复制",
    releaseKicker: "完整保留的版本历史",
    releaseTitle: "三个公开版本，三个不可变的检查点。",
    releaseLead: "内部构建 v0.1.2～v0.1.6 已合并进入 v0.2.0，并明确标记为未单独发布的开发版本。",
    releaseOne: "可审计的工作流基础",
    releaseTwo: "本地媒体链路",
    releaseThree: "Agent-first 累计核查",
    maintainerKicker: "面向真实维护工作",
    maintainerTitle: "只有经得起复核的证据，才能让自动化真正有用。",
    maintainerBody: "仓库已配置版本一致性检查、Windows CI、浏览器 E2E、CodeQL、Dependabot、贡献模板、私密漏洞报告和正式发布流程。",
    ctaKicker: "开源 Alpha",
    ctaTitle: "检查工作流、测试门禁，一起降低 AI 视频生产的脆弱性。",
    openGithub: "在 GitHub 查看",
    reportIssue: "提交问题",
    footerNote: "本地优先设计，默认由人控制。"
  }
};

const english = Object.fromEntries(
  [...document.querySelectorAll("[data-i18n]")].map((node) => [node.dataset.i18n, node.textContent.trim()]),
);

const languageButtons = [...document.querySelectorAll("[data-set-lang]")];

function getInitialLanguage() {
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested === "en" || requested === "zh") return requested;
  const saved = window.localStorage.getItem("barelyworks-language");
  if (saved === "en" || saved === "zh") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function setLanguage(language, updateUrl = true) {
  const dictionary = language === "zh" ? translations.zh : english;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.lang = language;
  document.title = language === "zh" ? "小破软件 · AI Video Studio" : "BarelyWorks · AI Video Studio";

  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const value = dictionary[node.dataset.i18n];
    if (value) node.textContent = value;
  });

  languageButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.setLang === language));
  });

  window.localStorage.setItem("barelyworks-language", language);
  if (updateUrl) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("lang", language);
    window.history.replaceState({}, "", nextUrl);
  }
}

languageButtons.forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.setLang));
});

document.querySelector("[data-copy-code]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const code = document.querySelector("pre code")?.textContent ?? "";
  await navigator.clipboard.writeText(code);
  const language = document.documentElement.dataset.lang;
  button.textContent = language === "zh" ? translations.zh.copied : "Copied";
  window.setTimeout(() => {
    button.textContent = language === "zh" ? translations.zh.copy : english.copy;
  }, 1400);
});

setLanguage(getInitialLanguage(), false);
