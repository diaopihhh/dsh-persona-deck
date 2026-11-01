/**
 * dsh-persona-deck — client 半边。
 *
 * 1. 聊天框标题栏「人设」下拉右边：一个「人设更新」按钮，往当前会话递一句话，
 *    让 agent 去查这个角色最近的新闻/新梗，先给用户看，点头再进卡。
 * 2. 插件页：卡列表、看全文、切到当前会话、删除、粘贴存卡。
 *
 * 手写 ModuleLoader bundle（跟 soul-md 一个形状），零依赖，只用 require("react")。
 */
window.__ModuleLoader__.load({
  id: "dsh-persona-deck",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;

    const REFRESH_ENDPOINT = "/dsh-persona-deck/refresh";
    const DECK_ENDPOINT = "/dsh-persona-deck/deck";
    const SAVE_ENDPOINT = "/dsh-persona-deck/save";
    const DELETE_ENDPOINT = "/dsh-persona-deck/delete";
    const USE_ENDPOINT = "/dsh-persona-deck/use";
    const REWRITE_ENDPOINT = "/dsh-persona-deck/rewrite";

    const BTN = {
      height: 26,
      padding: "0 10px",
      borderRadius: 6,
      border: "1px solid rgba(255,255,255,0.3)",
      background: "rgba(255,255,255,0.12)",
      color: "inherit",
      fontSize: 12,
      lineHeight: "24px",
      whiteSpace: "nowrap",
      cursor: "pointer",
      fontFamily: "inherit",
    };

    const BTN_SMALL = Object.assign({}, BTN, { height: 24, fontSize: 12, lineHeight: "22px", padding: "0 8px" });

    const BADGE_ON = {
      fontSize: 11,
      padding: "1px 6px",
      borderRadius: 4,
      background: "var(--dsh-color-accent, #4d7cfe)",
      color: "#fff",
      lineHeight: "16px",
    };

    const BADGE_DEF = {
      fontSize: 11,
      padding: "1px 6px",
      borderRadius: 4,
      border: "1px solid rgba(255,255,255,0.4)",
      opacity: 0.85,
      lineHeight: "16px",
    };

    const INPUT = {
      width: "100%",
      boxSizing: "border-box",
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.24)",
      borderRadius: 6,
      color: "inherit",
      fontFamily: "inherit",
      fontSize: 13,
      padding: "6px 8px",
    };

    // ── 标题栏「人设更新」按钮 ────────────────────────────────────────────
    function RefreshButton(props) {
      const [state, setState] = react.useState("idle"); // idle | sending | ok | err
      const [detail, setDetail] = react.useState("");

      const onClick = react.useCallback(() => {
        if (state === "sending") return;
        setState("sending");
        setDetail("");
        fetch(REFRESH_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: props.sessionId || "" }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok) {
              setState("ok");
              setDetail("已发出，等它回话");
            } else {
              setState("err");
              setDetail(String((data && data.error) || "没发出去"));
            }
          })
          .catch((error) => {
            setState("err");
            setDetail(String((error && error.message) || error));
          })
          .finally(() => {
            setTimeout(() => setState("idle"), 5000);
          });
      }, [props.sessionId, state]);

      const label = state === "sending" ? "查找中…" : state === "ok" ? "已发出" : state === "err" ? "没发出去" : "人设更新";
      const style = Object.assign({}, BTN, { marginLeft: 6, opacity: state === "sending" ? 0.6 : 1 });

      return h(
        "button",
        {
          type: "button",
          className: "__pd_refresh",
          style,
          disabled: state === "sending",
          title: detail || "联网查这个角色最近的新闻、新梗；先给用户看，确认后再存进人设卡",
          onClick,
        },
        label,
      );
    }

    // ── 插件页：卡组管理 ─────────────────────────────────────────────────
    function DeckSection() {
      const [data, setData] = react.useState({ ok: false, loading: true, cards: [] });
      const [msg, setMsg] = react.useState("");
      const [openName, setOpenName] = react.useState("");
      const [draft, setDraft] = react.useState({ name: "", text: "" });
      const [edit, setEdit] = react.useState(null);
      const [hint, setHint] = react.useState("");

      const 刷新 = react.useCallback(() => {
        setData((prev) => Object.assign({}, prev, { loading: true }));
        fetch(DECK_ENDPOINT, { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => setData(Object.assign({ ok: false, cards: [] }, d, { loading: false })))
          .catch((error) =>
            setData({ ok: false, loading: false, cards: [], error: String((error && error.message) || error) }),
          );
      }, []);

      react.useEffect(() => {
        刷新();
      }, [刷新]);

      const 调 = (url, body) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      const 切卡 = (name) => {
        if (!data.sessionId) {
          setMsg("先去对话页露个脸，我才知道是哪个会话");
          return;
        }
        调(USE_ENDPOINT, { name, sessionId: data.sessionId || "" }).then((d) => {
          setMsg(d && d.ok ? "" : String((d && d.error) || "没切成功"));
          if (d && d.ok) setData((prev) => Object.assign({}, prev, { current: String(d.choice || "") }));
          setTimeout(刷新, 300);
        });
      };

      const 删卡 = (name) => {
        调(DELETE_ENDPOINT, { name }).then((d) => {
          setMsg(d && d.ok ? "" : String((d && d.error) || "没删掉"));
          if (openName === name) setOpenName("");
          刷新();
        });
      };

      const 存卡 = () => {
        const n = draft.name.trim();
        const t = draft.text;
        if (!n || !t.trim()) {
          setMsg("卡名和正文都要填");
          return;
        }
        setHint("");
        调(SAVE_ENDPOINT, { name: n, text: t }).then((d) => {
          setMsg(d && d.ok ? "" : String((d && d.error) || "没存上"));
          if (d && d.ok) {
            if (!/^##/m.test(t)) {
              setHint(
                "「" +
                  n +
                  "」存好了。这个不是标准格式（没有 ## 分节），也能用，但角色容易飘——点「让大肥鱼重写」，我照 14 段整一遍。",
              );
            }
            setDraft({ name: "", text: "" });
            刷新();
          }
        });
      };

      const 重写 = () => {
        const n = String(draft.name || "").trim();
        if (!n) {
          setMsg("先在上面把卡名填上，我才知道重写哪一张");
          return;
        }
        if (!data.sessionId) {
          setMsg("先去对话页露个脸，我才知道是哪个会话");
          return;
        }
        调(REWRITE_ENDPOINT, { card: n, sessionId: data.sessionId || "" }).then((d) => {
          setMsg(d && d.ok ? "" : String((d && d.error) || "没递出去"));
          if (d && d.ok) setHint("已经跟大肥鱼说了。回聊天页看——他重写完会先贴给你确认，你点头他才覆盖。");
        });
      };

      const 打开卡 = (c) => {
        if (openName === c.name) {
          setOpenName("");
          setEdit(null);
          return;
        }
        const m = (c && c.meta) || {};
        setOpenName(c.name);
        setEdit({
          name: c.name,
          text: c.text || "",
          role: m.role || "",
          source: m.source || "",
          variant: m.variant || "",
          traits: Array.isArray(m.traits) ? m.traits.join("、") : m.traits || "",
        });
      };

      const 保存修改 = () => {
        const e = edit;
        if (!e) return;
        const traits = String(e.traits || "")
          .split(/[、,，\s]+/)
          .filter(Boolean);
        调(SAVE_ENDPOINT, {
          name: e.name,
          text: e.text,
          role: e.role,
          source: e.source,
          variant: e.variant,
          traits,
        }).then((d) => {
          setMsg(d && d.ok ? "" : String((d && d.error) || "没存上"));
          if (d && d.ok) setEdit(null);
          刷新();
        });
      };

      const 启用 = (name) => {
        if (!data.sessionId) {
          setMsg("先去对话页发一句，我才知道是哪个会话");
          return;
        }
        调(USE_ENDPOINT, { name, sessionId: data.sessionId || "" }).then((d) => {
          setMsg(d && d.ok ? "" : String((d && d.error) || "没启用上"));
          if (d && d.ok) setData((prev) => Object.assign({}, prev, { current: String(d.choice || "") }));
          setTimeout(刷新, 300);
        });
      };

      const cards = Array.isArray(data.cards) ? data.cards : [];
      const current = data.current || "";

      return h(
        "div",
        { className: "dsh-flat __pd_root", style: { fontSize: 13, lineHeight: 1.5 } },

        h(
          "p",
          { style: { margin: "0 0 10px", opacity: 0.7 } },
          data.loading
            ? "读卡中…"
            : data.deck
              ? "人设下拉接的是 " + data.deck + "，这里改的卡会同步过去。"
              : "现在没有人设下拉，卡收在插件自己的库里。",
        ),

        !data.loading
          ? h(
              "p",
              { style: { margin: "0 0 10px", fontSize: 12, opacity: 0.85 } },
              current
                ? "当前会话在用：「" + current + "」"
                : "当前会话没指定卡" + (data.active ? "，跟着默认「" + data.active + "」" : ""),
            )
          : null,

        msg ? h("p", { style: { margin: "0 0 10px", fontSize: 12, color: "#ffb3b3" } }, msg) : null,

        cards.length === 0
          ? h("p", { style: { opacity: 0.7 } }, "还没有卡。下面粘一段卡存进来，或者直接跟 agent 说「导入《出处》里的某某」。")
          : cards.map((c) =>
              h(
                "div",
                {
                  key: c.name,
                  style: {
                    background: current === c.name ? "rgba(77,124,254,0.16)" : "rgba(255,255,255,0.035)",
                    border:
                      current === c.name
                        ? "1px solid rgba(77,124,254,0.8)"
                        : "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    marginBottom: 8,
                  },
                },
                h(
                  "div",
                  { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
                  h("strong", { style: { fontSize: 13 } }, c.name),
                  c.meta && (c.meta.role || c.meta.source || c.meta.variant)
                    ? h(
                        "span",
                        { style: { opacity: 0.65, fontSize: 12 } },
                        [c.meta.role, c.meta.source, c.meta.variant].filter(Boolean).join(" · "),
                      )
                    : null,
                  current === c.name
                    ? h("span", { style: BADGE_ON }, "启用中")
                    : h("span", { style: BADGE_DEF }, "未启用"),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" } },
                  h(
                    "button",
                    {
                      type: "button",
                      style: BTN_SMALL,
                      onClick: (e) => {
                        e.stopPropagation();
                        打开卡(c);
                      },
                    },
                    openName === c.name ? "收起" : "看全文",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: BTN_SMALL,
                      disabled: current === c.name,
                      onClick: (e) => {
                        e.stopPropagation();
                        启用(c.name);
                      },
                    },
                    current === c.name ? "启用中" : "启用",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: BTN_SMALL,
                      onClick: (e) => {
                        e.stopPropagation();
                        删卡(c.name);
                      },
                    },
                    "删除",
                  ),
                ),
                openName === c.name && edit && edit.name === c.name
                  ? h(
                      "div",
                      { style: { marginTop: 8 } },
                      h("input", {
                        style: Object.assign({}, INPUT, { marginBottom: 6 }),
                        type: "text",
                        placeholder: "角色名",
                        value: edit.role,
                        onChange: (e) => setEdit(Object.assign({}, edit, { role: e.target.value })),
                      }),
                      h("input", {
                        style: Object.assign({}, INPUT, { marginBottom: 6 }),
                        type: "text",
                        placeholder: "出处",
                        value: edit.source,
                        onChange: (e) => setEdit(Object.assign({}, edit, { source: e.target.value })),
                      }),
                      h("input", {
                        style: Object.assign({}, INPUT, { marginBottom: 6 }),
                        type: "text",
                        placeholder: "版本（单版本留空）",
                        value: edit.variant,
                        onChange: (e) => setEdit(Object.assign({}, edit, { variant: e.target.value })),
                      }),
                      h("input", {
                        style: Object.assign({}, INPUT, { marginBottom: 6 }),
                        type: "text",
                        placeholder: "性格标签，用顿号隔开",
                        value: edit.traits,
                        onChange: (e) => setEdit(Object.assign({}, edit, { traits: e.target.value })),
                      }),
                      h("textarea", {
                        style: Object.assign({}, INPUT, { minHeight: 240, resize: "vertical" }),
                        value: edit.text,
                        onChange: (e) => setEdit(Object.assign({}, edit, { text: e.target.value })),
                      }),
                      h(
                        "div",
                        { style: { display: "flex", gap: 6, marginTop: 6 } },
                        h("button", { type: "button", style: BTN_SMALL, onClick: 保存修改 }, "保存修改"),
                        h(
                          "button",
                          {
                            type: "button",
                            style: BTN_SMALL,
                            onClick: () => {
                              setEdit(null);
                              setOpenName("");
                            },
                          },
                          "收起",
                        ),
                      ),
                    )
                  : null,
              ),
            ),

        h(
          "div",
          { style: { marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 12 } },
          h("p", { style: { margin: "0 0 8px", opacity: 0.75 } }, "粘贴存卡"),
          h("input", {
            style: Object.assign({}, INPUT, { marginBottom: 8 }),
            type: "text",
            placeholder: "卡名（单版本用角色名，多版本用 角色-版本）",
            value: draft.name,
            onChange: (e) => setDraft(Object.assign({}, draft, { name: e.target.value })),
          }),
          h("textarea", {
            style: Object.assign({}, INPUT, { minHeight: 140, resize: "vertical" }),
            placeholder: "把人设卡全文粘这儿，标题用 ## 分节",
            value: draft.text,
            onChange: (e) => setDraft(Object.assign({}, draft, { text: e.target.value })),
          }),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" } },
            h("button", { type: "button", style: BTN, onClick: 存卡 }, "保存"),
            h("button", { type: "button", style: BTN, onClick: 重写 }, "让大肥鱼重写"),
          ),
          hint
            ? h(
                "p",
                { style: { margin: "8px 0 0", fontSize: 12, opacity: 0.75, lineHeight: 1.5 } },
                hint,
              )
            : null,
        ),
      );
    }

    // ── 注册 ─────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register(
          { name: "conversation.session.header.actions", id: "persona-deck-refresh", order: 41 },
          (props) => h(RefreshButton, props || {}),
        ),
      );

      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-persona-deck" }, () => h(DeckSection, {})),
      );
    }

    return { name: "persona-deck", inject: ["slots"], apply };
  },
});
