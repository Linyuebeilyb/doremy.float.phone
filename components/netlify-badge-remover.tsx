"use client";

import { useEffect } from "react";

/**
 * 移除 Netlify 在响应 HTML 时注入的「Powered by Netlify」角标。
 *
 * 为什么不用纯 CSS：
 * 角标不在本仓库代码里，由 Netlify 注入，标签名/类名没有公开契约且会随版本
 * 变化。先按猜测的选择器（#netlify-badge / .netlify-badge 等）实测未命中。
 *
 * 为什么按「元素整体文本」而不是逐文本节点匹配：
 * 角标的文案常常被拆进多个节点（"Powered by" 一段、"Netlify" 加粗一段，
 * 中间还可能夹图标元素）。逐个 Text 节点做正则匹配时，任何单个节点都凑不出
 * 完整句子，命中数恒为 0——这是上一版在普通 DOM 上也没生效的直接原因。
 * 这里改成读元素的 textContent 整体判断，再取「最外层」的命中元素隐藏。
 *
 * 安全边界（避免误伤界面）：
 * - 元素文本长度上限 120 字，整页容器天然被排除；
 * - 取「父元素不再命中」的最外层节点作为隐藏目标；
 * - 目标尺寸必须像角标（高 ≤160px、宽 ≤500px），否则退回到更内层的命中元素；
 * - 全程 try/catch，清理失败不影响页面本身。
 */

const BADGE_TEXT = /powered\s*by\s*netlify/i;
const HIDE_ATTR = "data-netlify-badge-hidden";
const MAX_TEXT_LENGTH = 120;
const MAX_BADGE_HEIGHT = 160;
const MAX_BADGE_WIDTH = 500;
const MAX_SHADOW_DEPTH = 3;
const SWEEP_THROTTLE_MS = 400;
// 首次加载后的补扫时点：注入脚本可能晚于 React 挂载
const INITIAL_RETRY_DELAYS_MS = [300, 1000, 2500, 5000];

function hide(el: HTMLElement): void {
    if (el.hasAttribute(HIDE_ATTR)) return;
    el.setAttribute(HIDE_ATTR, "");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
}

function matchesBadgeText(el: Element): boolean {
    const text = el.textContent;
    if (!text || text.length > MAX_TEXT_LENGTH) return false;
    return BADGE_TEXT.test(text);
}

function looksLikeBadge(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.height <= MAX_BADGE_HEIGHT && rect.width <= MAX_BADGE_WIDTH;
}

/** 命中元素里取「最外层」的那个：父元素不再命中就是它。 */
function isOutermostHit(el: Element): boolean {
    const parent = el.parentElement;
    return !parent || !matchesBadgeText(parent);
}

/**
 * 递归收集某个根（文档 / shadow root / iframe 文档）内的角标元素。
 * TreeWalker 与 querySelectorAll 都不穿过 shadow 边界，必须显式递归。
 */
function collectHits(root: Document | ShadowRoot | HTMLElement, hits: HTMLElement[], depth: number): void {
    if (depth > MAX_SHADOW_DEPTH) return;

    const scope = root as ParentNode;
    const elements = scope.querySelectorAll?.("*");
    if (!elements) return;

    elements.forEach(el => {
        if (el instanceof HTMLElement && matchesBadgeText(el) && isOutermostHit(el)) {
            hits.push(el);
        }
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) collectHits(shadow, hits, depth + 1);
    });
}

function sweepFrames(hits: HTMLElement[]): void {
    document.querySelectorAll<HTMLIFrameElement>("iframe").forEach(frame => {
        if (/netlify\.com/i.test(frame.getAttribute("src") || "")) {
            hide(frame);
            return;
        }
        try {
            const doc = frame.contentDocument;
            if (doc?.body) collectHits(doc, hits, 0);
        } catch {
            // 跨域访问会抛错，忽略
        }
    });
}

function sweep(): void {
    if (!document.body) return;

    const hits: HTMLElement[] = [];
    collectHits(document.body, hits, 0);
    sweepFrames(hits);

    for (const hit of hits) {
        // 优先隐藏尺寸像角标的那个；不像就退回命中元素本身，绝不向上吞掉整页
        hide(looksLikeBadge(hit) ? hit : (hit.parentElement instanceof HTMLElement && looksLikeBadge(hit.parentElement) ? hit.parentElement : hit));
    }
}

export function NetlifyBadgeRemover() {
    useEffect(() => {
        let disposed = false;
        let timer: number | null = null;

        const runSweep = () => {
            try {
                sweep();
            } catch {
                // 清理失败绝不能影响页面本身
            }
        };

        const schedule = () => {
            if (disposed || timer !== null) return;
            timer = window.setTimeout(() => {
                timer = null;
                runSweep();
            }, SWEEP_THROTTLE_MS);
        };

        runSweep();
        const retryTimers = INITIAL_RETRY_DELAYS_MS.map(ms => window.setTimeout(schedule, ms));

        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });

        return () => {
            disposed = true;
            if (timer !== null) window.clearTimeout(timer);
            retryTimers.forEach(id => window.clearTimeout(id));
            observer.disconnect();
        };
    }, []);

    return null;
}
