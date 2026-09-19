#!/usr/bin/env python3
"""Re-localize a pristine upstream dsh-auto-collapse client bundle.

The fork in lib/client.js is generated, not hand-edited. Upstream ships 34
hardcoded Chinese strings (as \\uXXXX escapes) and no locale lookup at all, so
every release of the fork is:

    npm pack dsh-auto-collapse@<version>          # or read it from the profile
    tar xzf dsh-auto-collapse-*.tgz
    python3 localize.py package/lib/client.js lib/client.js
    node --check lib/client.js

Run it against a PRISTINE upstream copy: the script asserts the exact shape it
expects and aborts rather than half-applying, which is how a layout change
upstream gets noticed instead of silently producing a mixed-language bundle.

What it does:
  1. replaces all 33 string sites with tr("key") lookups (34 dictionary keys);
  2. renames the module id, settings namespace and log prefixes to ours;
  3. injects the en/zh dictionaries, a {placeholder} filler, and a `tr` that
     apply() rebinds through ctx.locale;
  4. declares `locale` in the plugin's inject list;
  5. gives the two runtime-built SVGs an intrinsic size (see patch_hardening);
  6. asserts no CJK escape survives.
"""
import codecs
import json
import re
import sys

# ── the copy, per locale ─────────────────────────────────────────────────────
EN = {
    "actionEdited": "Edited files",
    "actionRead": "Read files",
    "actionSearched": "Searched the web",
    "actionBrowser": "Used the browser",
    "actionRan": "Ran commands",
    "actionTool": "Used tools",
    "actionToolNamed": "Used {tool}",
    "actionThought": "Thought",
    "actionContext": "Injected context",
    "liveWaiting": "Waiting",
    "liveThinking": "Thinking",
    "liveContext": "Injecting context",
    "liveRunning": "Running",
    "statusError": "failed",
    "statusStopped": "stopped",
    "workProcess": "Work",
    "a11yCollapse": "Collapse",
    "a11yExpand": "Expand",
    "a11yWork": "work process: ",
    "settingsTitle": "Status text",
    "settingsCollapse": "Collapse settings",
    "settingsExpand": "Expand settings",
    "settingsDescription": "Custom status text replaces the running-status wording. Provided by the @muen/dsh-codex-fold plugin.",
    "settingsUnsaved": "Unsaved",
    "settingsReadOnly": "This deployment's settings are read-only.",
    "settingsFieldLabel": "Custom status text",
    "settingsOverridden": "Overridden",
    "settingsReset": "Restore default",
    "settingsPlaceholder": "Deep sleeping...",
    "settingsHint": "Empty restores the official default (Deep sleeping...)",
    "settingsFailed": "This deployment did not accept these values; they were kept for you to edit.",
    "settingsDiscard": "Discard changes",
    "settingsSaving": "Saving\u2026",
    "settingsSave": "Save",
}

ZH = {
    "actionEdited": "\u7F16\u8F91\u4E86\u6587\u4EF6",
    "actionRead": "\u8BFB\u53D6\u4E86\u6587\u4EF6",
    "actionSearched": "\u641C\u7D22\u4E86\u8D44\u6599",
    "actionBrowser": "\u4F7F\u7528\u4E86\u6D4F\u89C8\u5668",
    "actionRan": "\u8FD0\u884C\u4E86\u547D\u4EE4",
    "actionTool": "\u8C03\u7528\u4E86\u5DE5\u5177",
    "actionToolNamed": "\u8C03\u7528\u4E86 {tool}",
    "actionThought": "\u5DF2\u601D\u8003",
    "actionContext": "\u5DF2\u6CE8\u5165\u4E0A\u4E0B\u6587",
    "liveWaiting": "\u7B49\u5F85\u64CD\u4F5C",
    "liveThinking": "\u6B63\u5728\u601D\u8003",
    "liveContext": "\u6B63\u5728\u6CE8\u5165\u4E0A\u4E0B\u6587",
    "liveRunning": "\u6B63\u5728\u8FD0\u884C",
    "statusError": "\u51FA\u9519",
    "statusStopped": "\u5DF2\u505C\u6B62",
    "workProcess": "\u5DE5\u4F5C\u8FC7\u7A0B",
    "a11yCollapse": "\u6536\u8D77",
    "a11yExpand": "\u5C55\u5F00",
    "a11yWork": "\u5DE5\u4F5C\u8FC7\u7A0B\uFF1A",
    "settingsTitle": "\u72B6\u6001\u63D0\u793A\u8BCD",
    "settingsCollapse": "\u6536\u8D77\u8BBE\u7F6E",
    "settingsExpand": "\u5C55\u5F00\u8BBE\u7F6E",
    "settingsDescription": "\u81EA\u5B9A\u4E49\u72B6\u6001\u63D0\u793A\u8BCD\uFF0C\u53EF\u4EE5\u66FF\u6362\u539F\u6709\u7684\u8FD0\u884C\u72B6\u6001\u6587\u6848\uFF0C\u7531 @muen/dsh-codex-fold \u63D2\u4EF6\u63D0\u4F9B\u3002",
    "settingsUnsaved": "\u672A\u4FDD\u5B58",
    "settingsReadOnly": "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
    "settingsFieldLabel": "\u81EA\u5B9A\u4E49\u72B6\u6001\u63D0\u793A\u8BCD",
    "settingsOverridden": "\u5DF2\u8986\u76D6",
    "settingsReset": "\u6062\u590D\u9ED8\u8BA4",
    "settingsPlaceholder": "\u6DF1\u5EA6\u6C42\u7D22\u4E2D...",
    "settingsHint": "\u4E3A\u7A7A\u65F6\u6062\u590D\u5B98\u65B9\u9ED8\u8BA4\u6587\u6848\uFF08\u6DF1\u5EA6\u6C42\u7D22\u4E2D...\uFF09",
    "settingsFailed": "\u672C\u90E8\u7F72\u6CA1\u6709\u63A5\u53D7\u8FD9\u4E9B\u503C\uFF0C\u5DF2\u4FDD\u7559\u4F9B\u4F60\u4FEE\u6539\u3002",
    "settingsDiscard": "\u653E\u5F03\u4FEE\u6539",
    "settingsSaving": "\u4FDD\u5B58\u4E2D\u2026",
    "settingsSave": "\u4FDD\u5B58",
}

NS = "muen-codex-fold"          # settings namespace / plugin-card key (lowercase, hyphenated)
PACKAGE = "@muen/dsh-codex-fold"  # module id the client loader dispatches on


def mixed(text: str) -> str:
    """A JS double-quoted literal with only non-ASCII escaped, as the bundle writes it."""
    return '"' + "".join(ch if ord(ch) < 128 else "\\u%04X" % ord(ch) for ch in text) + '"'


def js_dict(d):
    return "{" + ",".join("%s:%s" % (json.dumps(k), json.dumps(v, ensure_ascii=False)) for k, v in d.items()) + "}"


def apply_strings(s: str) -> str:
    def sub(old, new, expect=1):
        nonlocal s
        n = s.count(old)
        if n != expect:
            raise SystemExit("ABORT: expected %d of %r, found %d" % (expect, old[:70], n))
        s = s.replace(old, new)

    # action labels
    sub(mixed("编辑了文件"), 'tr("actionEdited")')
    sub(mixed("读取了文件"), 'tr("actionRead")')
    sub(mixed("搜索了资料"), 'tr("actionSearched")')
    sub(mixed("使用了浏览器"), 'tr("actionBrowser")')
    sub(mixed("运行了命令"), 'tr("actionRan")', 2)
    sub(mixed("调用了工具"), 'tr("actionTool")')
    sub("`" + mixed("调用了")[1:-1] + " ${tool}`", 'tr("actionToolNamed", { tool })')
    sub(mixed("已思考"), 'tr("actionThought")')
    sub(mixed("已注入上下文"), 'tr("actionContext")')
    # live status
    sub(mixed("等待操作"), 'tr("liveWaiting")')
    sub(mixed("正在思考"), 'tr("liveThinking")')
    sub(mixed("正在注入上下文"), 'tr("liveContext")')
    sub(mixed("正在运行"), 'tr("liveRunning")')
    sub(r'" \xB7 ' + mixed("出错")[1:-1] + '"', '" \\xB7 " + tr("statusError")')
    sub(r'" \xB7 ' + mixed("已停止")[1:-1] + '"', '" \\xB7 " + tr("statusStopped")')
    sub(mixed("工作过程"), 'tr("workProcess")')
    # aria labels
    sub('`${expanded ? ' + mixed("收起") + ' : ' + mixed("展开") + "}" + mixed("工作过程：")[1:-1] + "${summary.text}",
        '`${tr(expanded ? "a11yCollapse" : "a11yExpand")}${tr("a11yWork")}${summary.text}')
    sub('`${open ? ' + mixed("收起设置") + ' : ' + mixed("展开设置") + "}: " + mixed("状态提示词")[1:-1] + '`',
        '`${tr(open ? "settingsCollapse" : "settingsExpand")}: ${tr("settingsTitle")}`')
    # settings card
    sub(mixed("状态提示词"), 'tr("settingsTitle")')
    sub(mixed("自定义状态提示词，可以替换原有的运行状态文案（深度求索中...），由插件dsh-auto-collapse提供"), 'tr("settingsDescription")')
    sub(mixed("未保存"), 'tr("settingsUnsaved")')
    sub(mixed("本部署的设置为只读。"), 'tr("settingsReadOnly")')
    sub(mixed("自定义状态提示词"), 'tr("settingsFieldLabel")')
    sub(mixed("已覆盖"), 'tr("settingsOverridden")')
    sub(mixed("恢复默认"), 'tr("settingsReset")')
    sub(mixed("深度求索中..."), 'tr("settingsPlaceholder")')
    sub(mixed("为空时恢复官方默认文案（深度求索中...）"), 'tr("settingsHint")')
    sub(mixed("本部署没有接受这些值，已保留供你修改。"), 'tr("settingsFailed")')
    sub(mixed("放弃修改"), 'tr("settingsDiscard")')
    sub(mixed("保存中…"), 'tr("settingsSaving")')
    sub(mixed("保存"), 'tr("settingsSave")')
    # identity
    sub('id:"dsh-auto-collapse"', 'id:"%s"' % PACKAGE)
    sub('var name = "dsh-auto-collapse";', 'var name = "%s";' % PACKAGE)
    sub("var inject = [];", 'var inject = ["locale"];')
    s = s.replace('"dsh-auto-collapse"', '"%s"' % NS)
    s = s.replace("[dsh-auto-collapse]", "[%s]" % NS)
    return s


def inject_locale(s: str) -> str:
    block = (
        "\n  // \u2500\u2500 %s addition: localized copy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n"
        '  var __muenNS = "%s";\n'
        "  var __muenEN = %s;\n"
        "  var __muenZH = %s;\n"
        "  function __muenFill(template, params) {\n"
        "    if (params === void 0 || params === null) return template;\n"
        '    return String(template).replace(/\\{(\\w+)\\}/g, (m, k) => params[k] === void 0 ? m : String(params[k]));\n'
        "  }\n"
        "  var tr = function (key, params) {\n"
        "    var t = __muenEN[key];\n"
        "    return t === void 0 ? key : __muenFill(t, params);\n"
        "  };\n"
    ) % (PACKAGE, NS, js_dict(EN), js_dict(ZH))

    anchor1 = '  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);\n'
    if s.count(anchor1) != 1:
        raise SystemExit("ABORT: bundle header changed upstream (anchor 1)")
    s = s.replace(anchor1, anchor1 + block)

    anchor2 = "  function apply(ctx) {\n"
    if s.count(anchor2) != 1:
        raise SystemExit("ABORT: apply() signature changed upstream (anchor 2)")
    binding = (
        "  function apply(ctx) {\n"
        "    // Dictionaries ride ctx.effect so they leave with the plugin; the binding\n"
        "    // stays on the built-in English table when the locale service is absent.\n"
        "    try {\n"
        "      ctx.effect(() => {\n"
        "        const offs = [];\n"
        '        try { offs.push(ctx.locale.register(__muenNS, "en", __muenEN)); } catch (e) {}\n'
        '        try { offs.push(ctx.locale.register(__muenNS, "zh", __muenZH)); } catch (e) {}\n'
        "        return () => { for (const off of offs) { try { off(); } catch (e) {} } };\n"
        '      }, "%s: dictionaries");\n'
        "      tr = ctx.locale.bind(__muenNS);\n"
        "    } catch (e) {}\n"
    ) % PACKAGE
    return s.replace(anchor2, binding)


def patch_hardening(s: str) -> str:
    """Two defects that only show up once the page is actually running.

    1. Intrinsic icon size.

    Upstream builds its group icon and group chevron with `createElementNS` and
    sets only `viewBox` — every width/height comes from the injected stylesheet
    (`#dshcf-v2-style`). When that element is not in `document.head` at paint
    time — it is created and removed with the fold controller — the SVGs fall
    back to the CSS default for a replaced element with no intrinsic size, which
    is 300x150 px. The 16x16 "three bars and three dots" icon then paints as the
    oversized blobs a reader sees mid-turn, and the 12x12 chevron as a giant V.

    Attributes plus inline styles so neither a missing stylesheet nor a host rule
    can inflate them; both are what the CSS would have said anyway.
    """
    targets = (
        ('svg.setAttribute("viewBox", "0 0 16 16");', "svg", 14),
        ('chevron.setAttribute("viewBox", "0 0 12 12");', "chevron", 12),
    )
    for anchor, name, size in targets:
        if anchor not in s:
            raise SystemExit("ABORT: icon anchor missing upstream: %s" % anchor)
        addition = (
            '%s\n      %s.setAttribute("width", "%d");'
            '\n      %s.setAttribute("height", "%d");'
            '\n      %s.style.width = "%dpx";'
            '\n      %s.style.height = "%dpx";'
            % (anchor, name, size, name, size, name, size, name, size)
        )
        s = s.replace(anchor, addition, 1)

    # 2. Keep the injected stylesheet. Upstream removes it on dispose, while the
    #    rows it styled can still be in the DOM — and those rows carry no other
    #    sizing. The rules are static and scoped to `.dshcf-*` classes, so one
    #    element living for the life of the page is the cheaper trade.
    drop = "      this.style.remove();"
    if drop not in s:
        raise SystemExit("ABORT: stylesheet disposal anchor missing upstream")
    s = s.replace(
        drop,
        "      // Deliberately NOT removed: the rules are static and scoped to\n"
        "      // .dshcf-* classes, and a dispose that strips them while folded rows\n"
        "      // remain in the DOM leaves those rows unstyled. One style element per\n"
        "      // page is the cheaper end of the trade.",
        1,
    )
    # 3. Style the chip rows inline. The injected stylesheet cannot be relied on
    #    at runtime: with it absent the rows fall back to the platform's button
    #    chrome — grey fill, border, centred label — which is the "boxed chip"
    #    defect a reader sees instead of a quiet inline chip. Inline styles win
    #    over any stylesheet rule that is not `!important`, so this makes the row
    #    correct whether or not the CSS lands.
    append = "      button.append(icon, label, detail, chevron);"
    if append not in s:
        raise SystemExit("ABORT: chip append anchor missing upstream")
    inline = """      button.style.appearance = "none";
      button.style.display = "flex";
      button.style.alignItems = "center";
      button.style.justifyContent = "flex-start";
      button.style.alignSelf = "flex-start";
      button.style.gap = "6px";
      button.style.boxSizing = "border-box";
      button.style.maxWidth = "100%";
      button.style.minWidth = "0";
      button.style.minHeight = "24px";
      button.style.margin = "0";
      button.style.padding = "0";
      button.style.border = "0";
      button.style.background = "transparent";
      button.style.color = "var(--dsw-alias-label-tertiary, #919191)";
      button.style.font = "inherit";
      button.style.lineHeight = "24px";
      button.style.textAlign = "left";
      button.style.cursor = "pointer";
      icon.style.display = "inline-flex";
      icon.style.flex = "none";
      icon.style.width = "16px";
      icon.style.height = "16px";
      icon.style.alignItems = "center";
      icon.style.justifyContent = "center";
      label.style.flex = "0 1 auto";
      label.style.minWidth = "0";
      label.style.overflow = "hidden";
      label.style.whiteSpace = "nowrap";
      label.style.textOverflow = "ellipsis";
      detail.style.minWidth = "0";
      detail.style.overflow = "hidden";
      detail.style.whiteSpace = "nowrap";
      detail.style.textOverflow = "ellipsis";
      detail.style.color = "var(--dsw-alias-label-secondary, #aaa)";
      chevron.style.flex = "none";
      chevron.style.opacity = "0.65";
      chevron.style.transform = "rotate(-90deg)";
"""
    s = s.replace(append, inline + append, 1)

    # The chevron's open/closed rotation lived only in CSS
    # (`.dshcf-group[aria-expanded="true"] .dshcf-group-chevron`), so drive it
    # from the same update that already maintains `aria-expanded`.
    row_object = "      const row = { button, label, detail, targets: /* @__PURE__ */ new Set() };"
    if row_object not in s:
        raise SystemExit("ABORT: row object anchor missing upstream")
    s = s.replace(
        row_object,
        "      const row = { button, label, detail, chevron, targets: /* @__PURE__ */ new Set() };",
        1,
    )
    label_write = "      if (row.label.textContent !== summary.text) row.label.textContent = summary.text;"
    if label_write not in s:
        raise SystemExit("ABORT: label write anchor missing upstream")
    s = s.replace(
        label_write,
        label_write
        + "\n      if (row.chevron !== void 0) row.chevron.style.transform = expanded ? \"none\" : \"rotate(-90deg)\";",
        1,
    )
    return s


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    s = open(src, encoding="utf-8").read()
    s = apply_strings(s)
    s = inject_locale(s)
    s = patch_hardening(s)
    leftover = []
    for m in re.finditer(r"(?:\\u[0-9A-Fa-f]{4})+", s):
        text = codecs.decode(m.group(0), "unicode_escape")
        if ord(text[0]) > 0x2000:
            leftover.append(text)
    if leftover:
        raise SystemExit("ABORT: CJK escapes survived: %s" % leftover[:8])
    required = (
        'var __muenNS = "%s";' % NS,
        'AUTO_COLLAPSE_NS = "%s";' % NS,
    )
    for want in required:
        if want not in s:
            raise SystemExit("ABORT: expected settings namespace declaration missing: %s" % want)
    # `var name` is the plugin identity and may be the package name; the settings
    # namespace and the injected __muenNS may not.
    for bad in ('AUTO_COLLAPSE_NS = "@muen', "__muenNS = \"@muen"):
        if bad in s:
            raise SystemExit("ABORT: package name leaked into a settings namespace: %s" % bad)
    open(dst, "w", encoding="utf-8").write(s)
    print("localized %s -> %s (%d dictionary keys, 0 CJK escapes)" % (src, dst, len(EN)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
