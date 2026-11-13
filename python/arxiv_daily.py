#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""arxiv_daily.py — arXiv 每日论文检索 / 摘要判定 / PDF+源码下载 / Markdown 报告。

该脚本是 dsh_daily_arxiv 插件的数据面：Node 侧（index.js）只负责调度、配置和
UI 通信，所有网络访问、文件落盘和大模型调用都在这里完成。

三种运行模式
------------
1. ``--mode auto --date YYYY-MM-DD``
   每日自动任务：检索该日期提交的论文 → 摘要判定 → 下载通过项 → 生成报告。
2. ``--mode search --from ... --to ...``
   手动任务第一步：只检索候选（不下载、不调用大模型），把候选项打印给 UI。
3. ``--mode process --ids '["2401.00001", ...]' --from ... --to ...``
   手动任务第二步：对用户勾选的候选项执行判定 → 下载 → 报告。
4. ``--mode test-llm``
   给 UI 的"测试连通性"按钮用：发一条最小请求验证 base_url / api_key / model。

输出协议（stdout 逐行）
-----------------------
* ``@@PROGRESS {"phase": ..., "done": n, "total": m, "message": "..."}``
  运行过程中的结构化进度，Node 侧原样转发给 UI。
* ``@@RESULT {"ok": true, ...}``
  最后一次出现的结构化结果，Node 侧据此判断成功/失败。

下载产物目录
------------
``<data-dir>/src/arxiv_{yyMMdd_HHmm}/`` 内包含：

* ``<stem>.json``   元信息 + 大模型判定 + 分析字段
* ``<stem>.pdf``    论文 PDF
* ``<stem>.zip``    arXiv LaTeX 源码包
* ``<stem>/``       解压后的源码
* ``candidates.json`` 本次检索的全部候选
* ``report.md``     本次的 Markdown 介绍报告
* ``run.json``      本次运行清单（统计、耗时、错误）

参考实现：``arxiv_download.py``（abs 页面解析、源码解压、限速节流、JSON 输出），
在其基础上补充了 PDF 下载、arXiv API 批量检索、摘要判定与报告生成。
"""

import argparse
import html
import io
import json
import os
import re
import ssl
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

try:  # 用户要求用 openai.OpenAI 完成判定与报告
    import openai
except Exception:  # noqa: BLE001 - 缺包时降级为规则模式，不直接崩溃
    openai = None

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
ARXIV_API = "https://export.arxiv.org/api/query"
ABS_URL = "https://arxiv.org/abs/{}"
PDF_URL = "https://arxiv.org/pdf/{}"
SRC_URL = "https://arxiv.org/src/{}"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 (dsh-daily-arxiv; polite-crawler)"
)

DEFAULT_KEYWORDS = [
    "Operations Research",
    "Optimization Modeling",
    "LLM+Optimization",
    "Agent+Optimization",
    "LLM Modeling Optimization",
    "LLM Formulation",
    "LLM Modeling",
    "LLM Evolutionary",
]

TARGET_PROFILE = (
    "研究者的兴趣画像：运筹优化（Operations Research）与优化建模（Optimization Modeling），"
    "尤其是大语言模型 / Agent 与优化建模、优化求解的交叉方向——包括用 LLM 做数学规划问题的"
    "自然语言理解与形式化建模（problem formulation / formulation generation）、"
    "LLM 辅助的建模语言或求解器调用、Agent 驱动的建模与求解流程、"
    "LLM 与进化算法/启发式搜索的结合（evolutionary / metaheuristic optimization with LLM）、"
    "以及 LLM 用于运筹优化问题分析、算法设计与决策支持的工作。"
    "纯 LLM 基础模型训练、纯计算机视觉、纯生物信息学等与优化建模无关的论文不属于目标主题。"
)

ANALYSIS_FIELDS = [
    "一句话总结",
    "研究对象",
    "解决的问题目标",
    "核心思想与方法",
    "研究意义",
    "优点与局限性",
]

SYSTEM_PROMPT = (
    "你是一位运筹优化（Operations Research）与大语言模型交叉领域的资深研究者与审稿人，"
    "擅长判断一篇论文是否属于「LLM / Agent 与优化建模求解」这一交叉主题，"
    "也擅长从摘要中提炼研究问题、方法、意义与优缺点。"
    "你的输出必须是严格合法的 JSON，不得包含解释、前言、markdown 代码块标记或任何多余文字。"
)

# ---------------------------------------------------------------------------
# 全局节流：arXiv 官方建议每次请求间隔 3 秒
# ---------------------------------------------------------------------------
_clock = threading.Lock()
_last_request = 0.0
PROCESS_STARTED = time.time()


def set_delay(seconds):
    global DELAY_SECONDS
    DELAY_SECONDS = max(0.0, float(seconds or 0))


DELAY_SECONDS = 3.0


def throttle():
    global _last_request
    with _clock:
        wait = DELAY_SECONDS - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.time()


def emit_progress(phase, done=0, total=0, message=""):
    sys.stdout.write("@@PROGRESS " + json.dumps(
        {"phase": phase, "done": done, "total": total, "message": message},
        ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message):
    sys.stdout.write("[arxiv] " + str(message) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
_ssl_context = None


def ssl_context():
    """构建 HTTPS 上下文。

    部分 Conda / 嵌入式 Python 没有把系统根证书打进默认路径，直接访问
    arxiv.org 会报 ``CERTIFICATE_VERIFY_FAILED``。这里优先使用 certifi 的
    CA 包，再叠加系统默认证书，两者都不可用时退回默认上下文。
    """
    global _ssl_context
    if _ssl_context is not None:
        return _ssl_context
    cafile = os.environ.get("SSL_CERT_FILE", "").strip()
    if not cafile:
        try:
            import certifi
            cafile = certifi.where()
        except Exception:  # noqa: BLE001
            cafile = ""
    try:
        context = ssl.create_default_context(cafile=cafile or None)
    except Exception:  # noqa: BLE001
        context = ssl.create_default_context()
    try:
        if cafile:
            context.load_default_certs()
    except Exception:  # noqa: BLE001
        pass
    _ssl_context = context
    return _ssl_context


def http_get(url, timeout=60, retries=3):
    last_error = None
    for attempt in range(1, retries + 1):
        throttle()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
                return resp.headers.get("Content-Type", ""), resp.read()
        except urllib.error.HTTPError as exc:
            last_error = exc
            # 429 / 5xx 值得重试，4xx 直接放弃
            if exc.code in (400, 401, 403, 404):
                raise
        except Exception as exc:  # noqa: BLE001 - 网络抖动一律重试
            last_error = exc
        if attempt < retries:
            time.sleep(min(30, 3 * attempt))
    raise RuntimeError("GET %s 失败：%s" % (url, last_error))


# ---------------------------------------------------------------------------
# arXiv API 检索
# ---------------------------------------------------------------------------
ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"


def normalize_keyword(raw):
    """把关键词整理成 arXiv 短语检索能用的形式。"""
    text = (raw or "").strip()
    if not text:
        return ""
    # "LLM+Optimization" 这类写法在检索里按空格短语处理更可靠；
    # 同时保留原文作为一个 OR 分支，两种写法都试。
    return text


def build_search_query(keywords, from_date, to_date):
    """(all:"kw1" OR all:"kw2" ...) AND submittedDate:[...]"""
    clauses = []
    for kw in keywords:
        phrase = kw.replace("+", " ").strip()
        for candidate in dict.fromkeys([kw.strip(), phrase]):
            if not candidate:
                continue
            escaped = candidate.replace('"', " ").strip()
            if escaped:
                clauses.append('all:"%s"' % escaped)
    if not clauses:
        raise ValueError("关键词库为空，先在 keywords.txt 里加上关键词")
    window = "[%s0000 TO %s2359]" % (
        from_date.replace("-", ""), to_date.replace("-", ""))
    return "(%s) AND submittedDate:%s" % (" OR ".join(clauses), window)


def parse_arxiv_feed(xml_text):
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    entries = []
    for node in root.findall(ATOM + "entry"):
        raw_id = (node.findtext(ATOM + "id") or "").strip()
        match = re.search(r"/abs/([^/]+?)(?:v(\d+))?$", raw_id)
        if not match:
            continue
        base_id = match.group(1)
        title = " ".join((node.findtext(ATOM + "title") or "").split())
        abstract = " ".join((node.findtext(ATOM + "summary") or "").split())
        authors = ", ".join(
            " ".join((a.findtext(ATOM + "name") or "").split())
            for a in node.findall(ATOM + "author")) if node.findall(ATOM + "author") else ""
        published = (node.findtext(ATOM + "published") or "").strip()
        updated = (node.findtext(ATOM + "updated") or "").strip()
        primary = node.find(ARXIV_NS + "primary_category")
        if primary is None:
            primary = node.find(ATOM + "category")
        categories = []
        for cat in node.findall(ATOM + "category"):
            term = cat.get("term")
            if term and term not in categories:
                categories.append(term)
        comment = " ".join((node.findtext(ARXIV_NS + "comment") or "").split())
        entries.append({
            "id": base_id,
            "version": int(match.group(2) or 1),
            "title": title,
            "abstract": abstract,
            "authors": authors,
            "published": published,
            "updated": updated,
            "primary_category": primary.get("term") if primary is not None else "",
            "categories": categories,
            "comment": comment,
            "abs_url": ABS_URL.format(base_id),
            "pdf_url": PDF_URL.format(base_id),
        })
    total_text = root.findtext("{http://a9.com/-/spec/opensearch/1.1/}totalResults")
    total = int(total_text) if total_text and total_text.isdigit() else len(entries)
    return entries, total


def search_arxiv(keywords, from_date, to_date, max_results):
    """按日期窗口 + 关键词检索，返回去重后的候选列表。"""
    query = build_search_query(keywords, from_date, to_date)
    log("search query: %s" % query)
    collected = []
    seen = {}
    start = 0
    page_size = min(100, max_results)
    while len(collected) < max_results:
        params = urllib.parse.urlencode({
            "search_query": query,
            "start": start,
            "max_results": page_size,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        })
        url = ARXIV_API + "?" + params
        ctype, body = http_get(url, timeout=90)
        if "xml" not in (ctype or "").lower():
            raise RuntimeError("arXiv API 返回了非 XML 内容：%s" % ctype)
        entries, total = parse_arxiv_feed(body.decode("utf-8", "ignore"))
        log("page start=%d got=%d total=%d" % (start, len(entries), total))
        for entry in entries:
            if entry["id"] in seen:
                continue
            seen[entry["id"]] = True
            collected.append(entry)
        if len(entries) < page_size or start + page_size >= total:
            break
        start += page_size
        emit_progress("search", len(collected), min(total, max_results), "检索中")
    return collected[:max_results]


def annotate_keywords(entries, keywords):
    """给每个候选打上命中的关键词（大小写不敏感的子串匹配，仅用于展示）。"""
    lowered = [(kw, kw.lower()) for kw in keywords]
    for entry in entries:
        haystack = (entry.get("title", "") + " \n " + entry.get("abstract", "")).lower()
        hits = []
        for original, low in lowered:
            probe = low.replace("+", " ")
            if low in haystack or probe in haystack:
                hits.append(original)
        entry["matched_keywords"] = hits
    return entries


# ---------------------------------------------------------------------------
# abs 页面解析 / 源码解压（沿用 arxiv_download.py 的实现）
# ---------------------------------------------------------------------------
def strip_tags(raw):
    return html.unescape(re.sub(r"<[^>]*>", " ", raw))


def parse_abs_page(text):
    title = None
    match = re.search(r'<h1[^>]*class=["\'][^"\']*title[^"\']*["\'][^>]*>(.*?)</h1>',
                      text, re.S | re.I)
    if match:
        title = strip_tags(match.group(1)).strip()
        title = re.sub(r"^\s*Title\s*:\s*", "", title, flags=re.I).strip() or None

    authors = []
    match = re.search(r'<div[^>]*class=["\'][^"\']*authors[^"\']*["\'][^>]*>(.*?)</div>',
                      text, re.S | re.I)
    if match:
        for anchor in re.finditer(r"<a\b[^>]*>(.*?)</a>", match.group(1), re.S | re.I):
            name = strip_tags(anchor.group(1)).strip()
            if name:
                authors.append(name)

    abstract = None
    match = re.search(
        r'<blockquote[^>]*class=["\'][^"\']*abstract[^"\']*["\'][^>]*>(.*?)</blockquote>',
        text, re.S | re.I)
    if match:
        abstract = strip_tags(match.group(1)).strip()
        abstract = re.sub(r"^\s*Abstract\s*:\s*", "", abstract, flags=re.I).strip() or None
    return title, ", ".join(authors), abstract


def sanitize_title(title):
    out = "".join(ch for ch in (title or "")
                  if ch.isascii() and (ch.isalnum() or ch in "_- "))
    return out[:16] if out.strip() else "paper"


def extract_archive(archive, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    data = archive.read_bytes()
    count = 0
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                try:
                    target = out_dir / info.filename
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(info))
                    count += 1
                except Exception as exc:  # noqa: BLE001
                    log("  skip %s: %s" % (info.filename, exc))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
            for member in tf.getmembers():
                if member.isdir():
                    continue
                try:
                    target = out_dir / member.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    handle = tf.extractfile(member)
                    if handle is not None:
                        target.write_bytes(handle.read())
                        count += 1
                except Exception as exc:  # noqa: BLE001
                    log("  skip %s: %s" % (member.name, exc))
    return count


# ---------------------------------------------------------------------------
# 大模型
# ---------------------------------------------------------------------------
class LlmClient(object):
    def __init__(self, cfg):
        if openai is None:
            raise RuntimeError("未安装 openai 包：请执行 pip install openai")
        self.base_url = str(cfg.get("base_url", "")).rstrip("/")
        self.api_key = str(cfg.get("api_key", ""))
        self.model = str(cfg.get("model") or cfg.get("model_name") or "")
        if not self.base_url or not self.model:
            raise RuntimeError("大模型配置不完整：base_url 与 model 必填")
        kwargs = {"api_key": self.api_key or "not-needed"}
        kwargs["base_url"] = self.base_url
        self.client = openai.OpenAI(**kwargs)

    def chat(self, user_prompt, system_prompt=None, max_tokens=3000, temperature=0.2):
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt or SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = response.choices[0].message.content or ""
        return content.strip()

    def chat_json(self, user_prompt, max_tokens=3000, retries=3):
        last_error = None
        for attempt in range(1, retries + 1):
            try:
                raw = self.chat(user_prompt, max_tokens=max_tokens)
                return parse_json_response(raw)
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                log("  LLM 第 %d 次调用失败：%s" % (attempt, exc))
                if attempt < retries:
                    time.sleep(2 * attempt)
        raise RuntimeError("大模型调用失败：%s" % last_error)


def parse_json_response(text):
    body = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", body, flags=re.S)
    if fence:
        body = fence.group(1).strip()
    start, end = body.find("{"), body.rfind("}")
    if start == -1 or end <= start:
        array_start, array_end = body.find("["), body.rfind("]")
        if array_start != -1 and array_end > array_start:
            return json.loads(body[array_start:array_end + 1])
        raise ValueError("大模型返回中未找到 JSON")
    return json.loads(body[start:end + 1])


# ---------------------------------------------------------------------------
# 摘要判定
# ---------------------------------------------------------------------------
SCREEN_PROMPT = """请判断下面每篇 arXiv 论文是否属于我的目标研究主题。

{profile}

关键词库（用户维护，仅作参考，不要因为没命中关键词就否定论文）：
{keywords}

判定要求：
1. 只根据标题与摘要判断，不要臆测正文内容；
2. relevant=true 表示该论文与「LLM/Agent × 优化建模/求解/运筹优化」的交叉主题直接相关；
3. score 为 0-100 的相关性分数，80 以上表示非常相关；
4. topics 用 1-3 个短语概括它所属的子方向（中文或英文均可）；
5. reason 用一句中文说明判定理由。

只输出一个 JSON 对象，格式严格如下，不要输出任何其他文字：
{{"decisions": [{{"id": "论文 id", "relevant": true, "score": 88, "topics": ["..."], "reason": "..."}}]}}

待判定论文（JSON 数组）：
{papers}
"""


def screen_by_abstract(llm, candidates, keywords, min_score, batch_size=6):
    """用大模型按摘要筛选，返回 {id: decision}。"""
    decisions = {}
    total = len(candidates)
    emit_progress("screen", 0, total, "摘要判定中")
    for offset in range(0, total, batch_size):
        batch = candidates[offset:offset + batch_size]
        payload = [{
            "id": paper_id_of(item),
            "title": item.get("title", ""),
            "abstract": (item.get("abstract") or "")[:1800],
        } for item in batch]
        prompt = SCREEN_PROMPT.format(
            profile=TARGET_PROFILE,
            keywords="\n".join("- " + kw for kw in keywords),
            papers=json.dumps(payload, ensure_ascii=False, indent=2),
        )
        try:
            parsed = llm.chat_json(prompt, max_tokens=2200)
            items = parsed.get("decisions") if isinstance(parsed, dict) else parsed
            if not isinstance(items, list):
                raise ValueError("decisions 不是数组")
            for item in items:
                paper_id = str(item.get("id", "")).strip()
                if not paper_id:
                    continue
                try:
                    score = int(float(item.get("score", 0)))
                except Exception:  # noqa: BLE001
                    score = 0
                decisions[paper_id] = {
                    "relevant": bool(item.get("relevant")),
                    "score": max(0, min(100, score)),
                    "topics": [str(t) for t in (item.get("topics") or [])][:3],
                    "reason": str(item.get("reason", "")).strip(),
                }
        except Exception as exc:  # noqa: BLE001 - 单批失败不放弃整轮
            log("  判定批次失败（offset=%d）：%s" % (offset, exc))
        for item in batch:
            if item["id"] not in decisions:
                # 大模型漏答时按关键词命中情况做保守兜底
                hit = bool(item.get("matched_keywords"))
                decisions[item["id"]] = {
                    "relevant": hit,
                    "score": 60 if hit else 30,
                    "topics": item.get("matched_keywords", [])[:3],
                    "reason": "大模型未返回该条判定，按关键词命中兜底",
                }
        emit_progress("screen", min(offset + batch_size, total), total, "摘要判定中")

    for paper_id, decision in decisions.items():
        if decision["score"] < min_score:
            decision["relevant"] = False
            decision["reason"] = (decision["reason"] + "（低于阈值 %d）" % min_score).strip()
    return decisions


def rule_screen(candidates, min_score, accept_all=False):
    """没有可用大模型时的规则兜底。

    自动任务按关键词命中判定；手动任务里用户已经亲手勾选，直接保留。
    """
    decisions = {}
    for item in candidates:
        hits = item.get("matched_keywords") or []
        if accept_all:
            decisions[item["id"]] = {
                "relevant": True,
                "score": max(int(min_score), 50),
                "topics": hits[:3],
                "reason": "未配置大模型，手动勾选的论文直接保留",
            }
            continue
        decisions[item["id"]] = {
            "relevant": bool(hits),
            "score": 65 if hits else 20,
            "topics": hits[:3],
            "reason": "未配置大模型，按关键词命中判定",
        }
    return decisions


# ---------------------------------------------------------------------------
# 单篇分析
# ---------------------------------------------------------------------------
ANALYSIS_PROMPT = """请阅读下面这篇论文的标题、作者与摘要，站在「LLM / Agent 与优化建模求解」
这一交叉主题的视角，提炼分析信息。

要求：
1. 六个字段全部给出，内容用简体中文撰写；
2. 每个字段 40～300 字，观点必须严格基于摘要原文，不要编造摘要中没有的内容；
3. "优点与局限性"要具体：优点写方法新颖性、效果、规模、开源等；局限性写问题类型覆盖、
   理论保障、可扩展性、真实场景差距等摘要中暴露或可推知的短板；
4. 只输出一个 JSON 对象，键名与下面完全一致，值必须是字符串，不要输出 markdown 围栏。

JSON 格式：
{{
  "一句话总结": "",
  "研究对象": "",
  "解决的问题目标": "",
  "核心思想与方法": "",
  "研究意义": "",
  "优点与局限性": ""
}}

=== 论文信息 ===
标题：{title}
作者：{authors}
主题标签：{topics}
摘要：{abstract}
"""


def analyze_paper(llm, entry):
    prompt = ANALYSIS_PROMPT.format(
        title=entry.get("title", ""),
        authors=entry.get("authors", ""),
        topics=", ".join(entry.get("topics") or []) or "（未标注）",
        abstract=entry.get("abstract", ""),
    )
    info = llm.chat_json(prompt, max_tokens=2000)
    if not isinstance(info, dict):
        raise ValueError("分析结果不是 JSON 对象")
    cleaned = {}
    for field in ANALYSIS_FIELDS:
        cleaned[field] = str(info.get(field, "")).strip()
    missing = [f for f in ANALYSIS_FIELDS if not cleaned[f]]
    if missing:
        raise ValueError("字段缺失：%s" % missing)
    return cleaned


REPORT_PROMPT = """下面是我今天从 arXiv 检索并通过摘要判定筛选出的论文清单（含各自的要点分析）。
请写一份中文的 Markdown「今日导读」，用于我的每日论文速览。

要求：
1. 只使用我给出的信息，不要虚构论文、数字或结论；
2. 结构固定为四个二级标题：`## 今日概览`、`## 主题分布`、`## 优先阅读`、`## 趋势观察`；
3. 「今日概览」2-4 句话概括今天这批论文的整体情况；
4. 「主题分布」用无序列表，按子方向归类，每条写清方向名和对应论文（用 arXiv 编号）；
5. 「优先阅读」用有序列表给出 1-3 篇最值得先读的论文，每篇一句话说明理由；
6. 「趋势观察」1-3 句话，指出这批工作反映出的趋势或尚未解决的问题；
7. 直接输出 Markdown 正文，不要加总标题，不要用代码块包裹整篇内容。

论文清单：
{papers}
"""


def build_overview(llm, entries):
    digest = []
    for item in entries:
        digest.append({
            "id": paper_id_of(item),
            "title": item.get("title", ""),
            "topics": item.get("topics") or item.get("matched_keywords") or [],
            "score": item.get("score", 0),
            "summary": item.get("analysis", {}).get("一句话总结", ""),
            "method": item.get("analysis", {}).get("核心思想与方法", ""),
        })
    prompt = REPORT_PROMPT.format(papers=json.dumps(digest, ensure_ascii=False, indent=2))
    return llm.chat(prompt, max_tokens=2200, temperature=0.4).strip()


def rule_overview(entries):
    lines = ["## 今日概览", "",
             "本次共筛选出 %d 篇与目标主题相关的论文（未配置大模型，导读为规则生成）。" % len(entries),
             "", "## 主题分布", ""]
    buckets = {}
    for item in entries:
        key = (item.get("topics") or item.get("matched_keywords") or ["未分类"])[0]
        buckets.setdefault(key, []).append(paper_id_of(item))
    if not buckets:
        lines.append("- （无）")
    for key, ids in buckets.items():
        lines.append("- **%s**：%s" % (key, "、".join(ids)))
    lines.extend(["", "## 优先阅读", ""])
    for index, item in enumerate(sorted(entries, key=lambda x: -x.get("score", 0))[:3], 1):
        lines.append("%d. **%s**（%s）— 相关性 %d" % (
            index, item.get("title", ""), paper_id_of(item), item.get("score", 0)))
    lines.extend(["", "## 趋势观察", "",
                  "- 请配置大模型后重新生成，以获得基于摘要的趋势分析。", ""])
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------
def download_one(entry, out_dir, force=False):
    """获取 abs 页面 → json、PDF、源码压缩包、解压目录。"""
    paper_id = entry["id"]
    title = entry.get("title") or ""
    authors = entry.get("authors") or ""
    abstract = entry.get("abstract") or ""

    stem = "%s_%s" % (sanitize_title(title), paper_id)
    json_path = out_dir / (stem + ".json")
    pdf_path = out_dir / (stem + ".pdf")
    zip_path = out_dir / (stem + ".zip")
    src_dir = out_dir / stem

    # 1) abs 页面（失败则回退到 API 元信息，不阻断下载）
    try:
        _, raw = http_get(ABS_URL.format(paper_id), timeout=60)
        page_title, page_authors, page_abstract = parse_abs_page(raw.decode("utf-8", "ignore"))
        if page_title:
            title = page_title
        if page_authors:
            authors = page_authors
        if page_abstract:
            abstract = page_abstract
    except Exception as exc:  # noqa: BLE001
        log("  %s abs 页面获取失败，使用 API 元信息：%s" % (paper_id, exc))

    record = {
        "id": paper_id,
        "arxiv_id": paper_id,
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "arxiv_url": ABS_URL.format(paper_id),
        "pdf_url": PDF_URL.format(paper_id),
        "published": entry.get("published", ""),
        "updated": entry.get("updated", ""),
        "primary_category": entry.get("primary_category", ""),
        "categories": entry.get("categories", []),
        "matched_keywords": entry.get("matched_keywords", []),
        "score": entry.get("score", 0),
        "topics": entry.get("topics", []),
        "relevance_reason": entry.get("reason", ""),
        "pdf_file": pdf_path.name,
        "src_zip": zip_path.name,
        "src_dir": src_dir.name if src_dir.exists() else "",
        "downloaded_at": datetime.now().isoformat(timespec="seconds"),
    }
    for field in ANALYSIS_FIELDS:
        record[field] = entry.get("analysis", {}).get(field, "")

    # 2) PDF
    if pdf_path.exists() and pdf_path.stat().st_size > 1024 and not force:
        log("  %s PDF 已存在，跳过" % paper_id)
    else:
        _, body = http_get(PDF_URL.format(paper_id), timeout=180)
        if not body[:4] == b"%PDF":
            raise RuntimeError("PDF 端点未返回 PDF 内容（%d 字节）" % len(body))
        pdf_path.write_bytes(body)
        log("  %s PDF 已保存（%.2f MB）" % (paper_id, len(body) / 1048576.0))

    # 3) 源码压缩包
    if zip_path.exists() and zip_path.stat().st_size > 0 and not force:
        log("  %s 源码包已存在，跳过" % paper_id)
    else:
        try:
            ctype, body = http_get(SRC_URL.format(paper_id), timeout=180)
            if "html" in (ctype or "").lower() or not body:
                raise RuntimeError("src 端点返回 %s，源码可能不可用" % ctype)
            zip_path.write_bytes(body)
            log("  %s 源码包已保存（%.2f MB）" % (paper_id, len(body) / 1048576.0))
        except Exception as exc:  # noqa: BLE001 - 源码缺失不阻塞整篇
            record["src_error"] = str(exc)
            log("  %s 源码下载失败：%s" % (paper_id, exc))

    # 4) 解压
    if zip_path.exists() and zip_path.stat().st_size > 0:
        try:
            count = extract_archive(zip_path, src_dir)
            record["src_dir"] = src_dir.name
            log("  %s 解压出 %d 个文件" % (paper_id, count))
        except Exception as exc:  # noqa: BLE001
            record["src_error"] = str(exc)
            log("  %s 解压失败：%s" % (paper_id, exc))

    json_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


# ---------------------------------------------------------------------------
# Markdown 报告
# ---------------------------------------------------------------------------
def paper_id_of(item):
    return str(item.get("id") or item.get("arxiv_id") or "")


def write_report(out_dir, meta, accepted, skipped, overview, keyword_list):
    lines = []
    lines.append("# arXiv 每日论文报告 · %s" % meta["date_label"])
    lines.append("")
    lines.append("> 生成时间：%s  " % meta["generated_at"])
    lines.append("> 检索区间：%s ～ %s  " % (meta["from_date"], meta["to_date"]))
    lines.append("> 关键词：%s  " % "、".join(keyword_list))
    lines.append("> 检索命中 %d 篇 → 摘要判定通过 %d 篇 → 实际下载 %d 篇  " % (
        meta["candidate_count"], meta.get("selected_count", len(accepted)), len(accepted)))
    lines.append("> 数据目录：`%s`  " % meta["out_dir_rel"])
    if meta.get("llm_model"):
        lines.append("> 判定/报告模型：`%s`（%s）  " % (meta["llm_model"], meta["llm_base_url"]))
    else:
        lines.append("> 判定/报告模型：未配置（使用规则兜底）  ")
    lines.append("")

    lines.append(overview.strip() if overview else "")
    lines.append("")

    lines.append("## 论文清单")
    lines.append("")
    if accepted:
        lines.append("| # | 标题 | arXiv | 相关性 | 主题 | 本地文件 |")
        lines.append("|---|---|---|---|---|---|")
        for index, item in enumerate(accepted, 1):
            files = ["[PDF](%s)" % item.get("pdf_file", "")]
            if item.get("src_zip"):
                files.append("[源码包](%s)" % item["src_zip"])
            if item.get("src_dir"):
                files.append("[源码目录](%s/)" % item["src_dir"])
            lines.append("| %d | %s | [%s](%s) | %d | %s | %s |" % (
                index,
                item.get("title", "").replace("|", "\\|"),
                paper_id_of(item),
                item.get("arxiv_url", ""),
                int(item.get("score", 0)),
                " / ".join(item.get("topics") or item.get("matched_keywords") or []) or "-",
                " ".join(files),
            ))
    else:
        lines.append("本次没有通过判定的论文。")
    lines.append("")

    if accepted:
        lines.append("## 论文详述")
        lines.append("")
        for index, item in enumerate(accepted, 1):
            lines.append("### %d. %s" % (index, item.get("title", "")))
            lines.append("")
            lines.append("- **arXiv**：[%s](%s)" % (paper_id_of(item), item.get("arxiv_url", "")))
            lines.append("- **作者**：%s" % (item.get("authors") or "未知"))
            if item.get("published"):
                lines.append("- **提交时间**：%s" % item["published"])
            if item.get("primary_category"):
                lines.append("- **主分类**：%s" % item["primary_category"])
            lines.append("- **相关性**：%d 分%s" % (
                int(item.get("score", 0)),
                (" — " + item["reason"]) if item.get("reason") else ""))
            if item.get("topics") or item.get("matched_keywords"):
                lines.append("- **主题**：%s" % " / ".join(
                    item.get("topics") or item.get("matched_keywords")))
            lines.append("- **本地文件**：`%s`、`%s`%s" % (
                item.get("pdf_file", ""),
                item.get("src_zip", ""),
                ("、`%s/`" % item["src_dir"]) if item.get("src_dir") else ""))
            lines.append("")
            analysis = item.get("analysis") or {}
            for field in ANALYSIS_FIELDS:
                value = (analysis.get(field) or "").strip()
                if not value:
                    continue
                lines.append("**%s**：%s" % (field, value))
                lines.append("")
            abstract = (item.get("abstract") or "").strip()
            if abstract:
                lines.append("<details><summary>展开原始摘要</summary>")
                lines.append("")
                lines.append(abstract)
                lines.append("")
                lines.append("</details>")
                lines.append("")

    if meta.get("errors"):
        lines.append("## 运行告警")
        lines.append("")
        for message in meta["errors"]:
            lines.append("- %s" % message)
        lines.append("")

    lines.append("## 附录")
    lines.append("")
    lines.append("- 关键词库（每行一个，`#` 开头为注释）：")
    lines.append("")
    for kw in keyword_list:
        lines.append("  - %s" % kw)
    lines.append("")
    lines.append("- 目录结构：`<stem>.json` 元信息、`<stem>.pdf` 原文、"
                 "`<stem>.zip` LaTeX 源码包、`<stem>/` 解压结果。")
    lines.append("")
    report_path = out_dir / "report.md"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def make_out_dir(data_dir):
    stamp = datetime.now().strftime("%y%m%d_%H%M")
    out_dir = data_dir / "src" / ("arxiv_" + stamp)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def load_llm_config(path):
    if not path:
        return {}
    candidate = Path(path)
    if not candidate.exists():
        return {}
    try:
        data = json.loads(candidate.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # noqa: BLE001
        log("大模型配置解析失败：%s" % exc)
        return {}
    if not data.get("base_url") or not (data.get("model") or data.get("model_name")):
        return {}
    if not data.get("model") and data.get("model_name"):
        data["model"] = data["model_name"]
    return data


def cmd_search(args, data_dir):
    keywords = read_keywords(args.keywords_file, data_dir)
    entries = search_arxiv(keywords, args.date_from, args.date_to, args.max_results)
    annotate_keywords(entries, keywords)
    emit_progress("search", len(entries), len(entries), "检索完成")
    out_dir = make_out_dir(data_dir)
    preview = {
        "from_date": args.date_from,
        "to_date": args.date_to,
        "keywords": keywords,
        "count": len(entries),
        "candidates": entries,
    }
    (out_dir / "candidates.json").write_text(
        json.dumps(preview, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "mode": "search",
        "count": len(entries),
        "keywords": keywords,
        "candidates": [{
            "id": paper_id_of(item),
            "title": item["title"],
            "authors": item["authors"],
            "published": item["published"],
            "primary_category": item["primary_category"],
            "matched_keywords": item["matched_keywords"],
            "abstract": item["abstract"][:600],
            "abs_url": item["abs_url"],
        } for item in entries],
    }


def cmd_process(args, data_dir):
    """手动任务：对用户勾选的 id 执行判定 → 下载 → 报告。"""
    keywords = read_keywords(args.keywords_file, data_dir)
    ids = [str(x).strip() for x in json.loads(args.ids or "[]")]
    ids = list(dict.fromkeys([i for i in ids if i]))
    if not ids:
        return {"ok": False, "error": "没有选择任何论文"}

    out_dir = make_out_dir(data_dir)
    candidates = []
    for paper_id in ids:
        candidates.append({
            "id": paper_id,
            "title": "",
            "abstract": "",
            "authors": "",
            "abs_url": ABS_URL.format(paper_id),
            "matched_keywords": [],
        })

    # 手动模式下候选可能来自任意日期，先用 abs 页面补齐标题/摘要用于判定
    emit_progress("prepare", 0, len(candidates), "读取候选元信息")
    for index, item in enumerate(candidates, 1):
        try:
            _, raw = http_get(ABS_URL.format(item["id"]), timeout=60)
            title, authors, abstract = parse_abs_page(raw.decode("utf-8", "ignore"))
            item["title"] = title or ""
            item["authors"] = authors or ""
            item["abstract"] = abstract or ""
        except Exception as exc:  # noqa: BLE001
            log("  %s 元信息获取失败：%s" % (item["id"], exc))
        emit_progress("prepare", index, len(candidates), "读取候选元信息")
    annotate_keywords(candidates, keywords)
    return finish_run(args, data_dir, out_dir, keywords, candidates, "manual")


def cmd_auto(args, data_dir):
    keywords = read_keywords(args.keywords_file, data_dir)
    date_from = args.date_from or args.date
    date_to = args.date_to or args.date
    if not date_from or not date_to:
        today = datetime.now().strftime("%Y-%m-%d")
        date_from = date_from or today
        date_to = date_to or today
    out_dir = make_out_dir(data_dir)
    entries = search_arxiv(keywords, date_from, date_to, args.max_results)
    annotate_keywords(entries, keywords)
    (out_dir / "candidates.json").write_text(json.dumps({
        "from_date": date_from,
        "to_date": date_to,
        "keywords": keywords,
        "count": len(entries),
        "candidates": entries,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return finish_run(args, data_dir, out_dir, keywords, entries, "auto")


def finish_run(args, data_dir, out_dir, keywords, candidates, mode):
    """判定 → 下载 → 报告，三种模式共用的收尾流程。"""
    started = PROCESS_STARTED
    errors = []
    llm = None
    llm_cfg = load_llm_config(args.llm_config)
    if llm_cfg:
        try:
            llm = LlmClient(llm_cfg)
            log("大模型：model=%s base_url=%s" % (llm.model, llm.base_url))
        except Exception as exc:  # noqa: BLE001
            errors.append("大模型初始化失败：%s" % exc)
            log(errors[-1])
    else:
        log("未配置可用的大模型，本次使用规则兜底")

    # 1) 摘要判定
    accept_all = mode == "manual"
    if llm is not None and candidates:
        try:
            decisions = screen_by_abstract(llm, candidates, keywords, args.min_score)
        except Exception as exc:  # noqa: BLE001
            errors.append("摘要判定失败：%s" % exc)
            decisions = rule_screen(candidates, args.min_score, accept_all=accept_all)
    else:
        decisions = rule_screen(candidates, args.min_score, accept_all=accept_all)

    selected = []
    skipped = []
    for item in candidates:
        decision = decisions.get(item["id"], {
            "relevant": False, "score": 0, "topics": [], "reason": "未判定"})
        item["score"] = decision["score"]
        item["topics"] = decision["topics"]
        item["reason"] = decision["reason"]
        (selected if decision["relevant"] else skipped).append(item)
    log("判定结果：通过 %d / 共 %d" % (len(selected), len(candidates)))

    # 2) 逐篇分析 + 下载
    accepted = []
    limit = min(len(selected), args.max_downloads)
    emit_progress("download", 0, limit, "准备下载")
    if len(selected) > limit:
        errors.append("通过判定的论文有 %d 篇，按上限只处理前 %d 篇" % (len(selected), limit))
    for index, item in enumerate(selected[:limit], 1):
        emit_progress("download", index - 1, limit,
                      "处理 %s" % (item.get("title") or item["id"])[:60])
        if not item.get("abstract"):
            try:
                _, raw = http_get(ABS_URL.format(item["id"]), timeout=60)
                title, authors, abstract = parse_abs_page(raw.decode("utf-8", "ignore"))
                item["title"] = item.get("title") or (title or "")
                item["authors"] = item.get("authors") or (authors or "")
                item["abstract"] = abstract or ""
            except Exception as exc:  # noqa: BLE001
                errors.append("%s 摘要获取失败：%s" % (item["id"], exc))

        if llm is not None:
            try:
                item["analysis"] = analyze_paper(llm, item)
            except Exception as exc:  # noqa: BLE001
                errors.append("%s 分析失败：%s" % (item["id"], exc))
                item["analysis"] = {}
        else:
            item["analysis"] = {}

        try:
            record = download_one(item, out_dir, force=args.force)
            accepted.append(record)
        except Exception as exc:  # noqa: BLE001
            errors.append("%s 下载失败：%s" % (item["id"], exc))
            log(errors[-1])
        emit_progress("download", index, limit, "已处理 %d/%d" % (index, limit))

    # 3) 报告
    emit_progress("report", 0, 1, "生成报告")
    overview = ""
    if llm is not None and accepted:
        try:
            overview = build_overview(llm, accepted)
        except Exception as exc:  # noqa: BLE001
            errors.append("导读生成失败：%s" % exc)
            overview = rule_overview(accepted)
    else:
        overview = rule_overview(accepted)

    date_label = args.date or args.date_from or datetime.now().strftime("%Y-%m-%d")
    meta = {
        "date_label": date_label,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "from_date": args.date_from or args.date or date_label,
        "to_date": args.date_to or args.date or date_label,
        "candidate_count": len(candidates),
        "selected_count": len(selected),
        "out_dir_rel": str(out_dir),
        "llm_model": llm.model if llm is not None else "",
        "llm_base_url": llm.base_url if llm is not None else "",
        "errors": errors,
    }
    report_path = write_report(out_dir, meta, accepted, skipped, overview, keywords)

    manifest = {
        "mode": mode,
        "date": date_label,
        "from_date": meta["from_date"],
        "to_date": meta["to_date"],
        "started_at": datetime.fromtimestamp(started).isoformat(timespec="seconds"),
        "duration_seconds": round(time.time() - started, 1),
        "out_dir": str(out_dir),
        "report": str(report_path),
        "keywords": keywords,
        "counts": {
            "candidates": len(candidates),
            "selected": len(selected),
            "downloaded": len(accepted),
            "skipped": len(skipped),
        },
        "llm": {
            "configured": llm is not None,
            "model": llm.model if llm is not None else "",
            "base_url": llm.base_url if llm is not None else "",
        },
        "errors": errors,
        "papers": [{
            "id": paper_id_of(item),
            "title": item.get("title", ""),
            "score": item.get("score", 0),
            "topics": item.get("topics", []),
            "pdf": item.get("pdf_file", ""),
            "src": item.get("src_zip", ""),
        } for item in accepted],
    }
    (out_dir / "run.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress("done", 1, 1, "完成")
    return {
        "ok": True,
        "mode": mode,
        "out_dir": str(out_dir),
        "report": str(report_path),
        "counts": manifest["counts"],
        "duration_seconds": manifest["duration_seconds"],
        "llm_configured": llm is not None,
        "errors": errors,
    }


def read_keywords(keywords_file, data_dir):
    path = Path(keywords_file) if keywords_file else (data_dir / "keywords.txt")
    if not path.exists():
        return list(DEFAULT_KEYWORDS)
    keywords = []
    for line in path.read_text(encoding="utf-8-sig", errors="ignore").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        if text not in keywords:
            keywords.append(text)
    return keywords or list(DEFAULT_KEYWORDS)


def cmd_test_llm(args, data_dir):
    cfg = load_llm_config(args.llm_config)
    if not cfg:
        return {"ok": False, "error": "尚未配置 base_url / api_key / model"}
    try:
        client = LlmClient(cfg)
        reply = client.chat(
            "请只回复两个字：收到。",
            system_prompt="你是一个连通性测试助手，请按要求简短回复。",
            max_tokens=32,
            temperature=0.0,
        )
        return {"ok": True, "model": client.model, "base_url": client.base_url,
                "reply": reply[:200]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

    parser = argparse.ArgumentParser(description="dsh_daily_arxiv 数据面")
    parser.add_argument("--mode", required=True,
                        choices=["auto", "search", "process", "test-llm"])
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--keywords-file", default="")
    parser.add_argument("--llm-config", default="")
    parser.add_argument("--date", default="")
    parser.add_argument("--from", dest="date_from", default="")
    parser.add_argument("--to", dest="date_to", default="")
    parser.add_argument("--ids", default="[]")
    parser.add_argument("--max-results", type=int, default=200)
    parser.add_argument("--max-downloads", type=int, default=40)
    parser.add_argument("--min-score", type=int, default=60)
    parser.add_argument("--delay", type=float, default=3.0)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    set_delay(args.delay)
    data_dir = Path(args.data_dir).resolve() if args.data_dir else Path.cwd()
    data_dir.mkdir(parents=True, exist_ok=True)

    try:
        if args.mode == "search":
            if not args.date_from or not args.date_to:
                raise SystemExit("search 模式需要 --from 与 --to")
            result = cmd_search(args, data_dir)
        elif args.mode == "process":
            result = cmd_process(args, data_dir)
        elif args.mode == "test-llm":
            result = cmd_test_llm(args, data_dir)
        else:
            result = cmd_auto(args, data_dir)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
        log("运行失败：%s" % result["error"])

    sys.stdout.write("@@RESULT " + json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
