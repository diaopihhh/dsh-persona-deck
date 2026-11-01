/**
 * dsh-persona-deck — 人设卡组（host 半边）。
 *
 * 三件事：
 *   1. 一键导入人格卡：卡正文写本地库，**探测得到**人设容器时同步写一份进去
 *      （装了 soul-md 就写进它的 cards，聊天框人设下拉立刻能看到、能切）。
 *   2. 元数据（角色 / 出处 / 版本 / 性格标签）存 JSON 文件。
 *   3. 往系统提示词里注入导入规范，让 agent 知道怎么按模板写卡。
 *
 * 不依赖 soul-md：没装也能用，卡落本地；匹配不到人设容器时工具会明说，
 * 并可用 persona_show 把卡全文取出来手动贴。
 *
 * 零依赖：不 import 任何 `@deepseek-ai/*`（profile 的 node_modules 里不全）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "persona-deck";
const inject = ["systemPrompt", "tools", "webServer", "agents", "sessions"];
/** 本插件的元数据命名空间（只用于导出，元数据其实走文件）。 */
const NS = "persona-deck";
const SECTION_GUIDE = "persona-deck:guide";
const META_ROUTE = "/dsh-persona-deck/meta";
const REFRESH_ROUTE = "/dsh-persona-deck/refresh";
const REWRITE_ROUTE = "/dsh-persona-deck/rewrite";
const DECK_ROUTE = "/dsh-persona-deck/deck";
const SAVE_ROUTE = "/dsh-persona-deck/save";
const DELETE_ROUTE = "/dsh-persona-deck/delete";
const USE_ROUTE = "/dsh-persona-deck/use";

// ── 文件路径 ────────────────────────────────────────────────────────────────

const deckDir = () => join(homedir(), ".dsh", "persona-deck");
const cardsDir = () => join(deckDir(), "cards");
const metaFile = () => join(deckDir(), "meta.json");
const sessionsFile = () => join(deckDir(), "sessions.json");
const speakUpConfigFile = () => join(homedir(), ".dsh", "speak-up-config.json");
const speakUpBaseFile = () => join(deckDir(), "speakup-base.json");

function sanitizeName(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || "未命名";
}

// ── 通用 ────────────────────────────────────────────────────────────────────

function tool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: def.output,
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    execute: def.execute,
  };
}

function settingsOf(ctx) {
  const s = ctx.get("settings");
  if (!s) throw new Error("persona-deck: settings service unavailable");
  return s;
}

function plain(value) {
  if (value == null) return {};
  if (typeof value === "object" && typeof value.toJSON === "function") return value.toJSON();
  return typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

function normalizeTraits(input) {
  if (!Array.isArray(input)) return [];
  return input.map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, 20);
}

function metaEntry(args) {
  const entry = {};
  if (typeof args.role === "string") entry.role = args.role.trim();
  if (typeof args.source === "string") entry.source = args.source.trim();
  if (typeof args.variant === "string") entry.variant = args.variant.trim();
  if (args.traits !== undefined) entry.traits = normalizeTraits(args.traits);
  return entry;
}

// ── 人设容器探测 ─────────────────────────────────────────────────────────────
// 不写死命名空间：扫 settings 里每一条，找「像人设卡容器」的那条——
// 有 cards（名 -> markdown 的对象）、active（字符串）、sessions（对象）。
// 这样 soul-md 改名、甚至换成别的同类插件，只要数据形状还在就能匹配上。

function isCardsMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  return keys.every((k) => typeof value[k] === "string");
}

function looksLikeDeck(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isCardsMap(value.cards)) return false;
  if (typeof value.active !== "string") return false;
  if (value.sessions != null && (typeof value.sessions !== "object" || Array.isArray(value.sessions))) return false;
  return true;
}

/** 找当前环境里的人设容器：优先叫 soul-md 的，其次名字里带 soul 的，再其次任意匹配的。 */
function findDeck(ctx) {
  try {
    const rows = settingsOf(ctx).describe();
    if (!Array.isArray(rows)) return null;
    const hits = rows.filter((row) => row && typeof row.ns === "string" && looksLikeDeck(row.value));
    if (hits.length === 0) return null;
    const picked = hits.find((r) => r.ns === "soul-md") || hits.find((r) => /soul/i.test(r.ns)) || hits[0];
    const value = typeof picked.value === "object" && picked.value !== null ? picked.value : {};
    return { ns: picked.ns, value };
  } catch {
    return null;
  }
}

// ── 本地库（自己的存储，永远可写） ───────────────────────────────────────────

async function readLocalCards() {
  const out = {};
  try {
    const files = await readdir(cardsDir());
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        out[file.slice(0, -3)] = await readFile(join(cardsDir(), file), "utf8");
      } catch {
        // 单个文件读不动就跳过
      }
    }
  } catch {
    // 目录还不存在
  }
  return out;
}

async function writeLocalCard(cardName, content) {
  await mkdir(cardsDir(), { recursive: true });
  await writeFile(join(cardsDir(), sanitizeName(cardName) + ".md"), content, "utf8");
}

async function deleteLocalCard(cardName) {
  try {
    await rm(join(cardsDir(), sanitizeName(cardName) + ".md"));
  } catch {
    // 本来就没有
  }
}

// ── 元数据文件 ───────────────────────────────────────────────────────────────

async function readMeta(ctx) {
  try {
    const text = await readFile(metaFile(), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMeta(ctx, next) {
  await mkdir(deckDir(), { recursive: true });
  await writeFile(metaFile(), JSON.stringify(next, null, 2), "utf8");
}

// ── 会话 → 用哪张卡（没有 soul-md 时自己管一份） ────────────────────────────

async function readLocalSessions() {
  try {
    const text = await readFile(sessionsFile(), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLocalSessions(next) {
  await mkdir(deckDir(), { recursive: true });
  await writeFile(sessionsFile(), JSON.stringify(next, null, 2), "utf8");
}

/** 当前会话用哪张卡：容器里的会话选择 → 本地会话选择 → 容器默认卡。 */
async function currentCardName(ctx, sid) {
  const deck = findDeck(ctx);
  const remoteSessions = (deck && deck.value && deck.value.sessions) || {};
  if (sid && remoteSessions[sid]) return String(remoteSessions[sid]);
  const local = await readLocalSessions();
  if (sid && local[sid]) return String(local[sid]);
  if (deck && typeof deck.value.active === "string" && deck.value.active) return deck.value.active;
  return "";
}

/** 设当前会话用哪张卡：有容器就同步一份（聊天框下拉跟着变），没有就落本地。 */
async function useCard(ctx, sid, cardName) {
  const deck = findDeck(ctx);
  if (deck) {
    const sessions = { ...((deck.value && deck.value.sessions) || {}) };
    if (sid) sessions[sid] = cardName;
    await settingsOf(ctx).mutate(deck.ns, [{ op: "set", path: ["sessions"], value: sessions }]);
  }
  const local = await readLocalSessions();
  if (sid) local[sid] = cardName;
  await writeLocalSessions(local);
  return { deck: deck ? deck.ns : null, session: sid || "", choice: cardName };
}

// ── 卡的统一读写（本地 + 人设容器合并） ──────────────────────────────────────

/** 合并读：本地库打底，人设容器里的同名卡覆盖（以装着的那个为准）。
 *  顺手把容器里本地没有的卡镜像写进本地库，这样哪天把容器关掉，卡也不丢。 */
let 已镜像 = false;
async function readCards(ctx) {
  let local = await readLocalCards();
  const deck = findDeck(ctx);
  const remote = deck && isCardsMap(deck.value.cards) ? deck.value.cards : {};
  if (!已镜像 && deck && Object.keys(remote).length) {
    已镜像 = true;
    let changed = false;
    for (const [cardName, text] of Object.entries(remote)) {
      if (!(cardName in local)) {
        try {
          await writeLocalCard(cardName, String(text));
          changed = true;
        } catch {
          // 单张写不进去不耽误读
        }
      }
    }
    if (changed) local = await readLocalCards();
  }
  return { cards: { ...local, ...remote }, deck };
}

/** 写：本地一定留一份；探测到人设容器时同步写进去。 */
async function saveCard(ctx, cardName, content) {
  await writeLocalCard(cardName, content);
  const deck = findDeck(ctx);
  if (!deck) return { deck: null, mirrored: false };
  const cards = { ...(isCardsMap(deck.value.cards) ? deck.value.cards : {}), [cardName]: content };
  // settings.update 走 profile 重载时容易撞上 "root Include entry"；mutate 更稳。
  await settingsOf(ctx).mutate(deck.ns, [{ op: "set", path: ["cards"], value: cards }]);
  return { deck, mirrored: true };
}

/** 删：两边都清。 */
async function removeCard(ctx, cardName) {
  await deleteLocalCard(cardName);
  const deck = findDeck(ctx);
  if (deck && deck.value.cards && cardName in deck.value.cards) {
    // settings.update 是合并语义（删不掉键），必须用 mutate + unset 回到继承值。
    await settingsOf(ctx).mutate(deck.ns, [{ op: "unset", path: ["cards", cardName] }]);
  }
  return deck;
}

// ── 活跃度 → speak-up 命中线 ─────────────────────────────────────────────────
// 不改 speak-up 源码：它每一轮都会重读 ~/.dsh/speak-up-config.json，
// 所以切人设时把这俩数按活跃度倍数改一下，下一轮自己就生效。
const 高活跃词 = ["话痨", "活泼", "叽叽喳", "爱说", "黏人", "热情", "主动", "外放", "吵闹", "爱笑", "元气", "欢脱", "跳脱", "闹腾"];

function 活跃度系数(正文) {
  const text = String(正文 ?? "");
  const 印象 = (text.match(/##\s*印象\s*\n([\s\S]*?)(?=\n##\s|$)/) || [])[1] || "";
  const 看 = 印象 || text;
  // 寡言的角色也不往下压：装了主动搭话的人都是想被找的，只是没那么勤。
  if (高活跃词.some((w) => 看.includes(w))) return 1.8;
  return 1;
}

function 夹命中线(v) {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

let 上次同步的键 = "";

/** 按当前会话挂的人设卡，把 speak-up 的峰时/谷时命中线缩放到对应倍率。 */
async function 同步SpeakUp(ctx, sid) {
  try {
    const { cards, deck } = await readCards(ctx);
    const 会话选择 = (deck && deck.value.sessions && deck.value.sessions[sid]) || "";
    const 默认卡 = (deck && deck.value.active) || "";
    const 卡名 = 会话选择 || 默认卡;
    const 系数 = 活跃度系数(卡名 ? cards[卡名] : undefined);
    const 键 = `${sid}|${卡名}|${系数}`;
    if (键 === 上次同步的键) return;
    上次同步的键 = 键;

    const 配置 = JSON.parse(await readFile(speakUpConfigFile(), "utf8"));
    if (typeof 配置["峰时命中线"] !== "number" || typeof 配置["谷时命中线"] !== "number") return;

    let 基准;
    try {
      基准 = JSON.parse(await readFile(speakUpBaseFile(), "utf8"));
    } catch {
      基准 = { 峰时命中线: 配置["峰时命中线"], 谷时命中线: 配置["谷时命中线"] };
      await mkdir(deckDir(), { recursive: true });
      await writeFile(speakUpBaseFile(), JSON.stringify(基准, null, 2), "utf8");
    }
    if (typeof 基准["峰时命中线"] !== "number" || typeof 基准["谷时命中线"] !== "number") return;

    const 新峰 = 夹命中线(基准["峰时命中线"] * 系数);
    const 新谷 = 夹命中线(基准["谷时命中线"] * 系数);
    if (配置["峰时命中线"] === 新峰 && 配置["谷时命中线"] === 新谷) return;
    配置["峰时命中线"] = 新峰;
    配置["谷时命中线"] = 新谷;
    await writeFile(speakUpConfigFile(), JSON.stringify(配置, null, 2), "utf8");
  } catch {
    // speak-up 没装、配置缺失、或目录没权限，都静默跳过
  }
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

const traitListSchema = {
  type: "array",
  items: { type: "string" },
  description: "性格标签，如 [\"傲娇\",\"嘴硬心软\"]；最多 20 个",
};

const cardNameSchema = { type: "string", description: "卡名。单版本用角色名；多版本用 角色-版本，如 奶龙-奶娃" };

const createTools = (ctx) => [
  tool({
    name: "persona_import",
    description:
      "导入一张人设卡。写到本插件自己的卡库；如果探测到人设容器（比如 dsh-soul-md 的 cards），就同步写一份进去，" +
      "聊天框人设下拉立刻能看到、能切。没探测到也能导入，只是卡只躺在本机，可用 persona_show 取全文。同名会覆盖。",
    parameters: {
      type: "object",
      properties: {
        name: cardNameSchema,
        content: { type: "string", description: "卡正文（Markdown，按 14 段模板写）" },
        role: { type: "string", description: "角色本名，如 雷姆、埼玉" },
        source: { type: "string", description: "出处，如 Re:从零开始的异世界生活、一拳超人" },
        variant: { type: "string", description: "版本，如 原版、兽人控版、奶娃" },
        traits: traitListSchema,
      },
      required: ["name", "content"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          bytes: { type: "number" },
          total: { type: "number" },
          storage: { type: "string" },
          mirrored: { type: "boolean" },
        },
        required: ["name", "total", "storage", "mirrored"],
      },
      render: (_args, value) => {
        const where = value.mirrored ? `已同步进「${value.storage}」，人设下拉里能选` : "没找到人设存放的地方，卡先发你～";
        return [{ type: "text", text: `人设卡「${value.name}」已导入，${where}；现在共 ${value.total} 张。` }];
      },
    },
    async execute(args) {
      const cardName = String(args.name ?? "").trim();
      const content = String(args.content ?? "");
      if (!cardName) throw new Error("persona_import: `name` must be non-empty");
      if (!content.trim()) throw new Error("persona_import: `content` must be non-empty");

      const { deck, mirrored } = await saveCard(ctx, cardName, content);

      const meta = await readMeta(ctx);
      meta[cardName] = { ...(meta[cardName] ?? {}), ...metaEntry(args) };
      await writeMeta(ctx, meta);

      const { cards } = await readCards(ctx);
      return {
        name: cardName,
        bytes: byteLength(content),
        total: Object.keys(cards).length,
        storage: deck ? deck.ns : "local",
        mirrored,
      };
    },
  }),
  tool({
    name: "persona_meta",
    description: "补写/修改某张已导入人设卡的元数据（角色、出处、版本、性格标签）。卡正文不动。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "卡名（必须已存在）" },
        role: { type: "string" },
        source: { type: "string" },
        variant: { type: "string" },
        traits: traitListSchema,
      },
      required: ["name"],
    },
    output: {
      schema: {
        type: "object",
        properties: { name: { type: "string" }, role: { type: "string" }, source: { type: "string" }, variant: { type: "string" } },
        required: ["name"],
      },
      render: (_args, value) => [
        { type: "text", text: `「${value.name}」的元数据已更新${value.role ? `：角色 ${value.role}` : ""}${value.source ? `，出处 ${value.source}` : ""}${value.variant ? `，版本 ${value.variant}` : ""}。` },
      ],
    },
    async execute(args) {
      const cardName = String(args.name ?? "").trim();
      if (!cardName) throw new Error("persona_meta: `name` must be non-empty");
      const { cards } = await readCards(ctx);
      if (!(cardName in cards)) throw new Error(`persona_meta: 没有叫「${cardName}」的人设卡`);
      const meta = await readMeta(ctx);
      meta[cardName] = { ...(meta[cardName] ?? {}), ...metaEntry(args) };
      await writeMeta(ctx, meta);
      const entry = meta[cardName];
      return { name: cardName, role: entry.role ?? "", source: entry.source ?? "", variant: entry.variant ?? "" };
    },
  }),
  tool({
    name: "persona_list",
    description: "列出所有已导入的人设卡及其元数据（角色、出处、版本、性格标签），并说明当前写进了哪里。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        properties: {
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                chars: { type: "number" },
                role: { type: "string" },
                source: { type: "string" },
                variant: { type: "string" },
              },
              required: ["name", "chars"],
            },
          },
          storage: { type: "string" },
          mirrored: { type: "boolean" },
        },
        required: ["cards", "storage", "mirrored"],
      },
      render: (_args, value) => {
        const where = value.mirrored ? `人设下拉：${value.storage}` : "人设下拉：没找到（卡收在插件里）";
        if (value.cards.length === 0) return [{ type: "text", text: `还没有导入过任何人格卡。${where}` }];
        const lines = value.cards.map((c) => {
          const bits = [c.role, c.source, c.variant].filter(Boolean).join(" · ");
          return `- ${c.name}（${c.chars} 字）${bits ? "  " + bits : ""}`;
        });
        return [{ type: "text", text: `已导入 ${value.cards.length} 张人设卡：\n${lines.join("\n")}\n${where}` }];
      },
    },
    async execute() {
      const { cards, deck } = await readCards(ctx);
      const meta = await readMeta(ctx);
      const list = Object.entries(cards).map(([cardName, content]) => {
        const m = meta[cardName] ?? {};
        return { name: cardName, chars: String(content ?? "").length, role: m.role ?? "", source: m.source ?? "", variant: m.variant ?? "" };
      });
      list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
      return { cards: list, storage: deck ? deck.ns : "local", mirrored: Boolean(deck) };
    },
  }),
  tool({
    name: "persona_search",
    description: "按关键词搜索已导入的人设卡（匹配卡名、角色、出处、版本、性格标签）。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，如 雷姆 / 傲娇 / 一拳超人" },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          hits: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        },
        required: ["query", "hits"],
      },
      render: (_args, value) => {
        if (value.hits.length === 0) return [{ type: "text", text: `没有匹配「${value.query}」的人设卡。` }];
        return [{ type: "text", text: `匹配「${value.query}」：${value.hits.map((h) => h.name).join("、")}` }];
      },
    },
    async execute(args) {
      const q = String(args.query ?? "").trim().toLowerCase();
      if (!q) throw new Error("persona_search: `query` must be non-empty");
      const { cards } = await readCards(ctx);
      const meta = await readMeta(ctx);
      const hits = Object.keys(cards)
        .filter((cardName) => {
          const m = meta[cardName] ?? {};
          const hay = [cardName, m.role, m.source, m.variant, ...(m.traits ?? [])].filter(Boolean).join(" ").toLowerCase();
          return hay.includes(q);
        })
        .map((cardName) => ({ name: cardName }));
      return { query: q, hits };
    },
  }),
  tool({
    name: "persona_show",
    description: "取出某张人设卡的完整正文（Markdown）。探测不到人设容器时，用它把卡全文贴给用户复制。",
    parameters: {
      type: "object",
      properties: {
        name: cardNameSchema,
      },
      required: ["name"],
    },
    output: {
      schema: {
        type: "object",
        properties: { name: { type: "string" }, text: { type: "string" }, storage: { type: "string" } },
        required: ["name", "text", "storage"],
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      const cardName = String(args.name ?? "").trim();
      if (!cardName) throw new Error("persona_show: `name` must be non-empty");
      const { cards, deck } = await readCards(ctx);
      if (!(cardName in cards)) throw new Error(`persona_show: 没有叫「${cardName}」的人设卡`);
      return { name: cardName, text: cards[cardName], storage: deck ? deck.ns : "local" };
    },
  }),
  tool({
    name: "persona_use",
    description:
      "把某张人设卡设到当前会话上。有 soul-md 就顺手同步进它的人设下拉；没有就存在本插件自己的会话表里，一样生效。传 \"none\" 取消本会话的选择。",
    parameters: {
      type: "object",
      properties: {
        name: cardNameSchema,
      },
      required: ["name"],
    },
    output: {
      schema: {
        type: "object",
        properties: { session: { type: "string" }, choice: { type: "string" }, deck: { type: "string" } },
        required: ["session", "choice", "deck"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.choice
            ? `当前会话已设为「${value.choice}」` + (value.deck ? `（同步进 ${value.deck}）` : "（存在本插件里）")
            : "当前会话已取消人设卡",
        },
      ],
    },
    async execute(args, exec) {
      const cardName = String(args.name ?? "").trim();
      const agent = exec && exec.agent;
      const sid = (agent && agent.session && agent.session.id) || "";
      if (!sid) throw new Error("persona_use: 拿不到当前会话 id");
      const deck = findDeck(ctx);
      if (!cardName || cardName === "none" || cardName === "default") {
        if (deck) {
          const sessions = { ...((deck.value && deck.value.sessions) || {}) };
          delete sessions[sid];
          await settingsOf(ctx).mutate(deck.ns, [{ op: "set", path: ["sessions"], value: sessions }]);
        }
        const local = await readLocalSessions();
        delete local[sid];
        await writeLocalSessions(local);
        return { session: sid, choice: "", deck: deck ? deck.ns : "" };
      }
      const { cards } = await readCards(ctx);
      if (!(cardName in cards)) throw new Error(`persona_use: 没有叫「${cardName}」的人设卡`);
      const r = await useCard(ctx, sid, cardName);
      return { session: sid, choice: cardName, deck: r.deck || "" };
    },
  }),
  tool({
    name: "persona_check",
    description: "自检：报告探测到的人设容器、本地卡库位置和卡数量。装没装 soul-md、结构对不对，都能看出来。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        properties: {
          deck: { type: "string" },
          localDir: { type: "string" },
          localCards: { type: "number" },
          deckCards: { type: "number" },
          ok: { type: "boolean" },
        },
        required: ["deck", "localDir", "localCards", "deckCards", "ok"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            `人设容器：${value.ok ? value.deck : "没探测到（或结构对不上）"}\n` +
            `本地卡库：${value.localDir}（${value.localCards} 张）\n` +
            `容器里的卡：${value.deckCards} 张`,
        },
      ],
    },
    async execute() {
      const deck = findDeck(ctx);
      const local = await readLocalCards();
      const deckCards = deck && isCardsMap(deck.value.cards) ? Object.keys(deck.value.cards).length : 0;
      return {
        deck: deck ? deck.ns : "无",
        localDir: cardsDir(),
        localCards: Object.keys(local).length,
        deckCards,
        ok: Boolean(deck),
      };
    },
  }),
  tool({
    name: "persona_delete",
    description: "删除一张已导入的人设卡（连同元数据）。本地和探测到的人设容器里都会删。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要删除的卡名" },
      },
      required: ["name"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          deleted: { type: "boolean" },
          remaining: { type: "number" },
        },
        required: ["name", "deleted", "remaining"],
      },
      render: (_args, value) => [
        { type: "text", text: `人设卡「${value.name}」已删除，现在剩 ${value.remaining} 张。` },
      ],
    },
    async execute(args) {
      const cardName = String(args.name ?? "").trim();
      if (!cardName) throw new Error("persona_delete: `name` must be non-empty");
      const { cards } = await readCards(ctx);
      if (!(cardName in cards)) throw new Error(`persona_delete: 没有叫「${cardName}」的人设卡`);
      await removeCard(ctx, cardName);
      const after = await readCards(ctx);
      if (cardName in after.cards) throw new Error(`persona_delete: 「${cardName}」没能删掉，仍存在`);
      const meta = await readMeta(ctx);
      if (cardName in meta) {
        delete meta[cardName];
        await writeMeta(ctx, meta);
      }
      return { name: cardName, deleted: true, remaining: Object.keys(after.cards).length };
    },
  }),
];

// ── 导入规范（注入系统提示词） ───────────────────────────────────────────────

const GUIDE = `【人设卡组 dsh-persona-deck】
用户说「导入/做个《出处》里的某某」时，按下面的规范产出卡。**生成完先把完整卡贴给用户看，问一句「要导入吗」，等用户明确说行再调用 persona_import**——不要自作主张直接导入。用户说改哪段就改哪段，改完再贴一遍让他确认。导入后卡正文写进本机卡库，探测到人设容器时同步一份进去（聊天框人设下拉立刻可用）；探测不到了，就把卡全文贴给用户自己贴。

一、导入前
- 多版本角色（如奶龙/奶娃、穹妹/穹姐）先问清要哪一版，再写。
- 热门 IP 按大众认知的形象写；原作冷门版本不写（例：奶蛙原作是绿青蛙，但网上认的是那只黄的大肚皮）。
- 过不了审的处理：只删成人内容和直接相关剧情，其余经历、关系照用；卡面不标「脱敏」。
- 被用户替代的原作角色（女主、昴这类）不能当「别人」提，位置归用户。
- 用户自己写的卡（插件页粘贴的、或者直接贴一段话给你的）不是标准格式时，用 persona_show 读出来，按同一套 14 段重写一遍——**重写不是重编**，原来的设定、称呼、雷区、说话味道一个都不能丢，只是补齐缺的段、把话理顺；改完先贴给用户看，点头再用 persona_import 同名覆盖。

二、卡结构（14 段，标题用 ##）
人设定位 / 印象 / 外表 / 气质 / 说话方式 / 说话习惯 / 聊天方式 / 脾气与偏好 / 和你相处 / 背景与来历 / 会和你说起的事 / 人际关系 / 称呼 / 边界
- 「印象」用 3-5 个词，抓角色最核心的几面，允许带反差（例：路飞的纯粹、自由、重情重义；穹的兄控、脆弱、病娇、依赖；芙莉莲的天然呆、纯洁、反差萌；埼玉的懒散、无敌、大智若愚）。不要堆同义形容词。

三、语言规矩
- 不照搬原作台词当口头禅（「无聊」「麻烦死了」这类硬得像配音）；说话习惯只写用词偏好和句子毛病。
- 不写动作旁白（（攥裙角）这类太出戏），靠语气、自称、敬语、停顿体现。
- 少写生活琐事类句子（做饭、打游戏），例子优先贴世界观（怪人、英雄协会、冒险、魔法、能量）。
- 不写「平时怎样 / 对你怎样」的对比——用户是唯一对象，角色天然对用户亲近，不用预热。
- 热情落在字面上：句子多几个字、主动问一句、称呼随意、嫌弃里带照顾。
- 聊天节奏按角色写，不套「一次一条 / 问才答」模板（寡言也分好几种）。
- 「会和你说起的事」列 3-5 件原作日常小事，脱敏处理，被替代角色的位置换成用户。
- 说话习惯可带符合角色年代/圈子的网络用语；异世界、古风不硬塞。
- 爱好、口味、习惯必须落到具体的东西上，一个具体顶十个空泛：不是「喜欢唱歌」，是唱到哪首会站起来；不是「喜欢做饭」，是只会做红烧肉、盐永远手抖；不是「喜欢动物」，是家里那只叫团子的猫。歌名、菜名、地名、牌子都给出来。查得到就按查到的写；查不到就挑一个立得住的，别写一串形容词凑数。

四、关系与称呼
- 用户的位置：原作里跟角色有明确关系的人，位置归用户——穹的哥哥、雷姆认定的昴、亚丝娜的桐人、五条悟带的学生、阿米娅的博士、阿罗娜的老师（sensei）、大凤的指挥官、加藤惠的安艺伦也、时崎狂三的五河士道，这些有名有姓的位置，卡里都直接写成「你」。
- 没有明确位置的，落成泛关系：路飞是伙伴、埼玉是邻居、芙莉莲是同行的人。
- 人际关系写同 IP 的 2-3 个人，先挑那个「绕不过去的」——宿敌、双生、一生之敌、绑在一起的搭档都算（鸣人—佐助、蝙蝠侠—小丑、炎亚纶—汪东城）。写关系不写名单：谁先低头、谁更狠、吵了这么多年最后变成什么样，各一句。排除被用户替代的角色。
- 称呼三情况：身份型（猎人小姐、指挥官）直接沿用；人名型（昴大人）换成用户，导入时问一次；没有就用「你」。

五、分寸与拒绝
- 成年角色可以撩、可以有暗示性的玩笑，但卡里不写性行为，最后一步停住，把选择权留给用户。
- 未成年角色不写。
- 外表年轻但设定是长生的（精灵、长生种这类）可以写不谙世事、纯粹，但不往性那边带。
- 成人向、未成年相关的角色（如《鬼父》相关）直接拒绝，不写卡。`;

// ── 往当前会话递话（「人设更新」按钮用） ──────────────────────────────────────
// 抄 dsh-speak-up 的做法：agent.followup(一条 user 消息) 是最稳的入口，
// 那样才是 DSH 自己的回合，agent 会正常开一轮。
// ⚠ followup 的 Promise 必须 await 并 catch：它 reject 会成为未处理 rejection，
//   Node 22+ 会把它当致命错误，整个宿主会退出。

function 找Agent(ctx, id) {
  const 原 = String(id == null ? "" : id).trim();
  if (原 === "") return undefined;
  const 候选 = [原];
  if (原.startsWith("session-")) 候选.push(原.slice("session-".length));
  else 候选.push("session-" + 原);
  for (const 一个 of 候选) {
    try {
      const a = ctx.get("agents")?.get?.(一个);
      if (a !== undefined) return a;
    } catch {
      // 服务不在或查不动：当成没找到
    }
  }
  return undefined;
}

function 造用户消息(文案) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(文案) }],
    source: { kind: "persona-deck" },
  };
}

function 读请求体(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function 重写文案(卡名) {
  const 名 = 卡名 ? `「${卡名}」` : "刚才存的那张卡";
  return [
    `【人设卡重写】${名} 不是标准格式（缺 ## 分节，或者写成了一整段）。`,
    "请用 persona_show 把这张卡读出来，按 14 段规范整一遍：人设定位 / 印象 / 外表 / 气质 / 说话方式 / 说话习惯 / 聊天方式 / 脾气与偏好 / 和你相处 / 背景与来历 / 会和你说起的事 / 人际关系 / 称呼 / 边界。",
    "重写不是重编：原来的设定、称呼、雷区、说话味道一个都不能丢，只是补齐缺的段、把话理顺。",
    "**生成完先把完整卡贴给我看，我点头再用 persona_import 同名覆盖保存。**",
  ].join("\n");
}
function 更新文案(卡名, role, source) {
  const 谁 = role || 卡名;
  const 出处 = source ? `《${source}》里的` : "";
  const 名 = 卡名 ? `「${卡名}」` : "当前会话的人设卡";
  return [
    `【人设更新】请更新${名}。`,
    `先联网查一下 ${出处}${谁} 最近（近半年到一年）有什么新闻、新梗、新剧情、新台词、粉丝圈里新的说法和玩梗。`,
    "查完整理给我看：哪些值得进卡、建议补进哪一段（说话习惯 / 会和你说起的事 / 印象 / 脾气与偏好），原卡里哪些说法已经过时。",
    "**先别改卡**，等我点头再合并保存。",
  ].join("\n");
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

function apply(ctx) {
  for (const def of createTools(ctx)) ctx.tools.register(def);

  // 记忆最近一个活跃会话：插件页没有 sessionId，切人设时用它兜底。
  let 最近会话 = null;
  void (async () => {
    try {
      const saved = await readLocalSessions();
      if (saved && saved.__recent) 最近会话 = String(saved.__recent);
    } catch {
      // 读不到就等第一轮对话
    }
  })();

  const 记会话 = async (sid) => {
    try {
      const saved = await readLocalSessions();
      if (saved.__recent !== sid) {
        saved.__recent = sid;
        await writeLocalSessions(saved);
      }
    } catch {
      // 记不下来也不影响这轮
    }
  };

  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: SECTION_GUIDE,
      order: 0.9,
      text: (assembly) => {
        try {
          const agent = assembly && assembly.agent;
          const sid = (agent && agent.session && agent.session.id) || undefined;
          if (sid) { 最近会话 = sid; void 记会话(sid); void 同步SpeakUp(ctx, sid); }
        } catch {
          // 拿不到会话就跳过，不影响提示词
        }
        return GUIDE;
      },
      interpolate: false,
    });
    return () => {
      if (typeof dispose === "function") dispose();
    };
  }, "persona-deck:guide()");

  // 只读：元数据 + 当前卡名列表（给外部工具/页面用）。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: META_ROUTE,
        handler: async (req, res) => {
          try {
            const meta = await readMeta(ctx);
            const { cards, deck } = await readCards(ctx);
            const body = JSON.stringify({ ok: true, meta, cards: Object.keys(cards), storage: deck ? deck.ns : "local" });
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(body);
          } catch (error) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
          }
        },
      }),
    "persona-deck:meta-route()",
  );

  // 「人设更新」：往当前会话递一句，让 agent 去查这个角色最近的新闻/新梗。
  // 客户端点按钮 → POST { sessionId, card } → 这里找 agent → followup 一条 user 消息。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: REFRESH_ROUTE,
        handler: async (req, res) => {
          const 回 = (payload) => {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify(payload));
          };
          try {
            if (req.method !== "POST") return 回({ ok: false, error: "POST only" });
            const body = await 读请求体(req);
            const sid = String(body.sessionId || "").trim();
            let 卡名 = String(body.card || "").trim();
            if (!卡名) {
              // 客户端没传卡名就自己看：会话级选择 > 默认卡
              const deck = findDeck(ctx);
              const 选 = (deck && deck.value && deck.value.sessions) || {};
              卡名 = String(选[sid] || (deck && deck.value && deck.value.active) || "").trim();
            }
            const agent = 找Agent(ctx, sid);
            if (!agent) return 回({ ok: false, error: "当前会话没在跑（或这个 id 找不到 agent）" });

            const meta = await readMeta(ctx);
            const 元 = (卡名 && meta[卡名]) || {};
            const 文案 = 更新文案(卡名, 元.role, 元.source);

            await agent.followup(造用户消息(文案));
            try {
              if (typeof ctx.get("sessions")?.flush === "function") await ctx.get("sessions").flush(agent.session);
            } catch {
              // 落盘没确认不影响这次递话
            }
            return 回({ ok: true, sent: true, session: sid, card: 卡名 || null });
          } catch (error) {
            return 回({ ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    "persona-deck:refresh-route()",
  );

  // 「按格式重写」：用户自己贴的卡不是 14 段格式时，点一下让 agent 读出来重写。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: REWRITE_ROUTE,
        handler: async (req, res) => {
          const 回 = (payload) => {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify(payload));
          };
          try {
            if (req.method !== "POST") return 回({ ok: false, error: "POST only" });
            const body = await 读请求体(req);
            const sid = String(body.sessionId || 最近会话 || "").trim();
            const 卡名 = String(body.card || "").trim();
            const agent = 找Agent(ctx, sid);
            if (!agent) return 回({ ok: false, error: "当前会话没在跑（或这个 id 找不到 agent）" });
            await agent.followup(造用户消息(重写文案(卡名)));
            try {
              if (typeof ctx.get("sessions")?.flush === "function") await ctx.get("sessions").flush(agent.session);
            } catch {
              // 落盘没确认不影响这次递话
            }
            return 回({ ok: true, sent: true, session: sid, card: 卡名 || null });
          } catch (error) {
            return 回({ ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    "persona-deck:rewrite-route()",
  );

  // ── 插件页：卡列表 / 看全文 / 切当前会话 / 删卡 / 粘贴存卡 ──────────────
  const 回JSON = (res, payload) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: DECK_ROUTE,
        handler: async (req, res) => {
          try {
            const { cards, deck } = await readCards(ctx);
            const meta = await readMeta(ctx);
            const value = (deck && deck.value) || {};
            const sessions = value.sessions && typeof value.sessions === "object" ? value.sessions : {};
            const sid = String(最近会话 || "").trim();
            const localSessions = await readLocalSessions();
            return 回JSON(res, {
              ok: true,
              deck: deck ? deck.ns : null,
              active: String(value.active || ""),
              current: sid ? String(sessions[sid] || localSessions[sid] || "") : "",
              sessionId: sid,
              cards: Object.keys(cards)
                .sort()
                .map((n) => ({ name: n, text: cards[n], meta: meta[n] || {} })),
            });
          } catch (error) {
            return 回JSON(res, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    "persona-deck:deck-route()",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: SAVE_ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method !== "POST") return 回JSON(res, { ok: false, error: "POST only" });
            const body = await 读请求体(req);
            const cardName = String(body.name || "").trim();
            const content = String(body.text || "");
            if (!cardName) return 回JSON(res, { ok: false, error: "卡名不能空" });
            if (!content.trim()) return 回JSON(res, { ok: false, error: "卡正文不能空" });
            const saved = await saveCard(ctx, cardName, content);
            const meta = await readMeta(ctx);
            meta[cardName] = metaEntry(body);
            await writeMeta(ctx, meta);
            return 回JSON(res, {
              ok: true,
              name: cardName,
              storage: saved.deck ? saved.deck.ns : "local",
              mirrored: saved.mirrored,
            });
          } catch (error) {
            return 回JSON(res, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    "persona-deck:save-route()",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: DELETE_ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method !== "POST") return 回JSON(res, { ok: false, error: "POST only" });
            const body = await 读请求体(req);
            const cardName = String(body.name || "").trim();
            if (!cardName) return 回JSON(res, { ok: false, error: "卡名不能空" });
            await removeCard(ctx, cardName);
            const meta = await readMeta(ctx);
            if (cardName in meta) {
              delete meta[cardName];
              await writeMeta(ctx, meta);
            }
            return 回JSON(res, { ok: true, name: cardName });
          } catch (error) {
            return 回JSON(res, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    "persona-deck:delete-route()",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: USE_ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method !== "POST") return 回JSON(res, { ok: false, error: "POST only" });
            const body = await 读请求体(req);
            const sid = String(body.sessionId || 最近会话 || "").trim();
            const pick = String(body.name || "").trim();
            const deck = findDeck(ctx);
            if (!deck) {
              // 没装 soul-md：走本插件自己的会话表，一样能切。
              if (!sid) return 回JSON(res, { ok: false, error: "先在对话页发一句，我才知道是哪个会话" });
              const { cards: allCards } = await readCards(ctx);
              if (pick && !(pick in allCards)) return 回JSON(res, { ok: false, error: "没有这张卡" });
              const local = await readLocalSessions();
              if (!pick) delete local[sid];
              else local[sid] = pick;
              await writeLocalSessions(local);
              return 回JSON(res, { ok: true, session: sid, choice: pick || null, storage: "local" });
            }
            const cards = isCardsMap(deck.value.cards) ? deck.value.cards : {};
            if (body.default) {
              if (!pick || !(pick in cards)) return 回JSON(res, { ok: false, error: "没有这张卡" });
              await settingsOf(ctx).mutate(deck.ns, [{ op: "set", path: ["active"], value: pick }]);
              return 回JSON(res, { ok: true, default: pick });
            }
            if (!sid) return 回JSON(res, { ok: false, error: "先在对话页发一句，我才知道是哪个会话" });
            if (pick && !(pick in cards)) return 回JSON(res, { ok: false, error: "没有这张卡" });
            const sessions = { ...((deck.value && deck.value.sessions) || {}) };
            if (!pick) delete sessions[sid];
            else sessions[sid] = pick;
            await settingsOf(ctx).mutate(deck.ns, [{ op: "set", path: ["sessions"], value: sessions }]);
            return 回JSON(res, { ok: true, session: sid, choice: pick || null });
          } catch (error) {
            return 回JSON(res, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }),
    "persona-deck:use-route()",
  );
}

export { SECTION_GUIDE, NS, apply, inject, name };
