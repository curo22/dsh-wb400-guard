// 真网关 A/B：两个触发源各自单独发、叠加发，对比「原样直发」与「经插件」。
// 前置：$env:WORKBUDDY_ELECTRON_BIN 指向 WorkBuddy 的 Electron 可执行文件，
//       $env:DSH_PROFILE_DIR 指向装有 dsh-workbuddy-connect 的 profile（默认桌面版）。
// 用法：node scripts/verify-identity-live.mjs
import { pathToFileURL } from "node:url";
const m = await import("../lib/index.js");
const prof = process.env.DSH_PROFILE_DIR || `${process.env.USERPROFILE}/.dsh/profiles/desktop`;
const mod = await import(pathToFileURL(`${prof}/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-vU86u9aU.js`).href);
const st = await new (mod.m ?? mod.WorkBuddyCredentialStore)({ variant: mod.S ?? mod.CN_VARIANT }).resolve();
const token = st.accessToken ?? st.token;
async function sendRaw(bodyObj) {
  const r = await fetch("https://copilot.tencent.com/v2/chat/completions", {
    method:"POST",
    headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json",
      "X-User-Id": st.uid, "X-Domain": st.domain, "X-IDE-Type":"WorkBuddy",
      "X-IDE-Name":"WorkBuddy", "X-IDE-Version":"1.0.0", "X-Product":"SaaS",
      "User-Agent":"WorkBuddy/1.0.0 WorkBuddy/1.0.0" },
    body: JSON.stringify(bodyObj),
  });
  const t = await r.text();
  return `${r.status}${(t.match(/"code":(\d+)/)||[])[1] ? " code="+(t.match(/"code":(\d+)/)||[])[1] : ""}`;
}
const guard = m.createGuardedFetch({ fetchImpl: async (url, init) => await fetch(url, init) });
const ID = "You are an AI agent powered by DeepSeek\u200B Harness.";
function body(sys){ return { model:"deepseek-v4.1-flash", stream:true, max_tokens:16,
  messages:[{role:"system",content:sys},{role:"user",content:"ok"}] }; }

const cases = [
  ["身份句",          ID + "\n\nBe concise."],
  ["身份句+@短语",     ID + "\n\n" + m.FILE_REFERENCE_PROMPT],
  ["仅@短语",          m.FILE_REFERENCE_PROMPT],
  ["身份句+大填充+@",   ID + "\n\n" + "Some context follows. ".repeat(120) + m.FILE_REFERENCE_PROMPT],
  ["中性system（对照）","You are a helpful assistant."],
];
console.log("场景                    原样直发        经插件");
for (const [n, sys] of cases) {
  const raw = await sendRaw(body(sys));
  // 经插件：包装后的 fetch 打到真实端点
  const r2 = await guard.fetch("https://copilot.tencent.com/v2/chat/completions", {
    method:"POST",
    headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json",
      "X-User-Id": st.uid, "X-Domain": st.domain, "X-IDE-Type":"WorkBuddy",
      "X-IDE-Name":"WorkBuddy", "X-IDE-Version":"1.0.0", "X-Product":"SaaS",
      "User-Agent":"WorkBuddy/1.0.0 WorkBuddy/1.0.0" },
    body: JSON.stringify(body(sys)),
  });
  const t2 = await r2.text();
  const g2 = `${r2.status}${(t2.match(/"code":(\d+)/)||[])[1] ? " code="+(t2.match(/"code":(\d+)/)||[])[1] : ""}`;
  console.log(`${n.padEnd(22)} ${raw.padEnd(15)} ${g2}`);
}
console.log("\nguard 统计:", JSON.stringify(guard.stats));
if (guard.stats.failed > 0 || guard.stats.rewritten < 4) {
  console.log("\n异常：改写次数不足或出现失败。");
  process.exit(1);
}
