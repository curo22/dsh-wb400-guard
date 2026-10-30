// 真网关 A/B：assistant 消息里带指纹会不会被拦，以及插件改完之后是否通过。
// 前置：$env:WORKBUDDY_ELECTRON_BIN 指向 WorkBuddy 的 Electron 可执行文件，
//       $env:DSH_PROFILE_DIR 指向装有 dsh-workbuddy-connect 的 profile（默认桌面版）。
// 用法：node scripts/verify-assistant-live.mjs
import { pathToFileURL } from "node:url";

const m = await import("../lib/index.js");
const prof = process.env.DSH_PROFILE_DIR || `${process.env.USERPROFILE}/.dsh/profiles/desktop`;
const mod = await import(
  pathToFileURL(`${prof}/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-vU86u9aU.js`).href
);
const st = await new (mod.m ?? mod.WorkBuddyCredentialStore)({ variant: mod.S ?? mod.CN_VARIANT }).resolve();
const token = st.accessToken ?? st.token;

const ENDPOINT = "https://copilot.tencent.com/v2/chat/completions";
const HEADERS = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-User-Id": st.uid,
  "X-Domain": st.domain,
  "X-IDE-Type": "WorkBuddy",
  "X-IDE-Name": "WorkBuddy",
  "X-IDE-Version": "1.0.0",
  "X-Product": "SaaS",
  "User-Agent": "WorkBuddy/1.0.0 WorkBuddy/1.0.0",
};

const ID = "You are an AI agent powered by DeepSeek\u200B Harness.";
const FRP = m.FILE_REFERENCE_PROMPT;

function describe(res, text) {
  const code = text.match(/"code":(\d+)/);
  const tag = code ? ` code=${code[1]}` : "";
  if (res.status === 200) return "200";
  if (res.status === 400 && code?.[1] === "11128") return "400 11128 BLOCKED";
  if (res.status === 400 && code?.[1] === "11101") return "400 11101 非流式";
  return `${res.status}${tag} OTHER`;
}

async function sendRaw(bodyObj) {
  const r = await fetch(ENDPOINT, { method: "POST", headers: HEADERS, body: JSON.stringify(bodyObj) });
  return describe(r, await r.text());
}

const guard = m.createGuardedFetch({ fetchImpl: async (url, init) => await fetch(url, init) });
async function sendGuarded(bodyObj) {
  const r = await guard.fetch(ENDPOINT, { method: "POST", headers: HEADERS, body: JSON.stringify(bodyObj) });
  return describe(r, await r.text());
}

const SYS = "You are a helpful assistant.";
const body = (messages) => ({ model: "deepseek-v4.1-flash", stream: true, max_tokens: 16, messages });

// [名称, messages, 原样直发应该是什么, 经插件应该是什么]
const CASES = [
  [
    "assistant 开头 FRP",
    body([
      { role: "system", content: SYS },
      { role: "user", content: "hi" },
      { role: "assistant", content: FRP },
      { role: "user", content: "again" },
    ]),
    "400 11128 BLOCKED",
    "200",
  ],
  [
    "assistant 中段 FRP",
    body([
      { role: "system", content: SYS },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Sure. " + FRP + " More." },
      { role: "user", content: "again" },
    ]),
    "400 11128 BLOCKED",
    "200",
  ],
  [
    "assistant 开头身份句",
    body([
      { role: "system", content: SYS },
      { role: "user", content: "hi" },
      { role: "assistant", content: ID + " Sure." },
      { role: "user", content: "again" },
    ]),
    "400 11128 BLOCKED",
    "200",
  ],
  [
    "assistant 普通@（不该被改）",
    body([
      { role: "system", content: SYS },
      { role: "user", content: "hi" },
      { role: "assistant", content: "ping @someone about a@b.com" },
      { role: "user", content: "again" },
    ]),
    "200",
    "200",
  ],
  [
    "对照：全干净",
    body([
      { role: "system", content: SYS },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Sure, done." },
      { role: "user", content: "again" },
    ]),
    "200",
    "200",
  ],
];

console.log("场景                        原样直发              经插件");
let bad = 0;
for (const [name, b, expectRaw, expectGuarded] of CASES) {
  const raw = await sendRaw(b);
  const g = await sendGuarded(b);
  const okRaw = raw === expectRaw || (expectRaw === "200" && raw === "200");
  const okG = g === expectGuarded;
  const mark = okRaw && okG ? "  " : "!!";
  if (!(okRaw && okG)) bad++;
  console.log(`${mark} ${name.padEnd(26)} ${raw.padEnd(21)} ${g}`);
}

console.log("\nguard 统计:", JSON.stringify(guard.stats));

// 三条触发的 assistant 用例必须被改写；两条干净的必须原样透传
if (guard.stats.rewritten !== 3 || guard.stats.passedThrough !== 2) {
  console.log(`!! 改写/透传计数不符：rewritten=${guard.stats.rewritten}（期望 3） passedThrough=${guard.stats.passedThrough}（期望 2）`);
  bad++;
}
if (guard.stats.failed > 0) {
  console.log("!! 出现内部失败");
  bad++;
}

console.log(bad === 0 ? "\n全部符合预期" : `\n有 ${bad} 项不符合预期`);
process.exit(bad === 0 ? 0 : 1);
