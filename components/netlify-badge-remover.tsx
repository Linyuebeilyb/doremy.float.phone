"use client";

import { useEffect } from "react";

/**
 * 移除 Netlify 在响应 HTML 时注入的「Powered by Netlify」角标。
 *
 * 为什么用 JS 而不是纯 CSS：
 * 这个角标不在本仓库代码里，由 Netlify 服务端注入，它的标签名/类名没有公开
 * 契约、且会随版本变化。先前用一组猜测的选择器（#netlify-badge 等）实测未
 * 命中，说明猜不中。改成「按可见文本定位，再向上找浮层容器」——不依赖任何
 * 类名，Netlify 改样式也不影响。
 *
 * 安全边界（避免误伤界面）：
 * - 只处理文本命中「powered by netlify」的元素；
 * - 向上最多 6 层找 fixed/absolute 定位的祖先；
 * - 且该祖先的尺寸必须像「角标」（高度 ≤ 120px、宽度 ≤ 420px），
 *   否则回退到文本的直接父元素，绝不隐藏整页容器。
 *
 * 同时用 MutationObserver 兜住「页面加载后才插入」的情况，并做了节流，
 * 避免频繁 DOM 变化造成重复全量扫描。
 */

const BADGE_TEXT = /powered\s+by\s+netlify/i;
const HIDE_ATTR = "data-netlify-badge-hidden";
const MAX_BADGE_HEIGHT = 120;
const MAX_BADGE_WIDTH = 420;
const MAX_ANCESTOR_DEPTH = 6;
const MAX_SHADOW_DEPTH = 3;
const SWEEP_THROTTLE_MS = 400;
// 首次加载后的补扫时点：Netlify 可能用 script 延迟把角标插进来
const INITIAL_RETRY_DELAYS_MS = [300, 1200, 3000];

function hide(el: HTMLElement): void {
    if (el.hasAttribute(HIDE_ATTR)) return;
    el.setAttribute(HIDE_ATTR, "");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
}

function looksLikeBadge(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.height <= MAX_BADGE_HEIGHT && rect.width <= MAX_BADGE_WIDTH;
}

/**
 * 从命中文本的元素向上找「浮动的、体积像角标」的容器；找不到就用它本身。
 *
 * 需要能穿过 shadow 边界：角标若在 shadow root 里，向上找到根就会 parentElement
 * 为 null，此时只有把宿主元素（host）藏掉才有效——只藏 shadow 内部的子孙，
 * 宿主本身可能仍占位或继续渲染。
 */
function findBadgeContainer(start: HTMLElement): HTMLElement {
    let node: HTMLElement | null = start;
    for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
        if (node === document.body) return start;
        const position = window.getComputedStyle(node).position;
        if ((position === "fixed" || position === "absolute") && looksLikeBadge(node)) {
            return node;
        }
        if (node.parentElement) {
            node = node.parentElement;
            continue;
        }
        // 到顶了：当前节点若是 shadow root 的顶层元素，改用它的宿主
        const root = node.getRootNode();
        const host = (root as ShadowRoot).host;
        if (host instanceof HTMLElement) {
            node = host;
            continue;
        }
        return start;
    }
    return start;
}

/**
 * 在给定根节点内找含角标文本的元素。
 *
 * 必须自己递归 shadow root：TreeWalker / querySelectorAll 都不会穿过 shadow 边界，
 * 而「角标浮在所有图层之上、按文字也扫不到」正是 shadow DOM 的典型症状
 *（宿主元素通常也没有可识别的类名，CSS 选择器同样够不着）。
 */
function collectHits(root: Document | ShadowRoot | HTMLElement, hits: HTMLElement[], depth: number): void {
    if (depth > MAX_SHADOW_DEPTH) return;

    const walker = root.ownerDocument
        ? root.ownerDocument.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT)
        : document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const value = node.nodeValue;
        if (!value || !BADGE_TEXT.test(value)) continue;
        const parent = node.parentElement;
        if (parent) hits.push(parent);
    }

    // 递归进 shadow root（open 才能拿到；closed 的取不到，只能靠 CSS 兜底）
    const elements = (root as ParentNode).querySelectorAll?.("*");
    if (elements) {
        elements.forEach(el => {
            const shadow = (el as HTMLElement).shadowRoot;
            if (shadow) collectHits(shadow, hits, depth + 1);
        });
    }
}

/** 同源 iframe 内部文档一起扫；跨域的读不到，按 src 兜底隐藏。 */
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
        hide(findBadgeContainer(hit));
    }
}

export function NetlifyBadgeRemover() {
    useEffect(() => {
        let disposed = false;
        let timer: number | null = null;

        const schedule = () => {
            if (disposed || timer !== null) return;
            timer = window.setTimeout(() => {
                timer = null;
                try {
                    sweep();
                } catch {
                    // 清理失败绝不能影响页面本身
                }
            }, SWEEP_THROTTLE_MS);
        };

        // 立即扫一次（此时角标通常已在 HTML 里），再补几次应对延迟注入
        try {
            sweep();
        } catch {
            /* ignore */
        }
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
