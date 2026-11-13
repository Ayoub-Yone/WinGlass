// Interactive-region bookkeeping for click-through overlay windows (dock + toast).
// Every registered element's bounding box (physical px) is sent to the backend, which toggles
// set_ignore_cursor_events as the cursor enters/leaves them. "Capture" mode makes the entire
// window interactive (drags, open context menus).

import { useEffect, type RefObject } from "react";
import { ipc, type HitRect } from "./ipc";

const elements = new Set<HTMLElement>();
let captureCount = 0;
let lastSent = "";
let frame = 0;
let started = false;

function flush(): void {
  frame = 0;
  const dpr = window.devicePixelRatio || 1;
  const rects: HitRect[] = [];
  for (const el of elements) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push([
      Math.floor(r.left * dpr) - 1,
      Math.floor(r.top * dpr) - 1,
      Math.ceil(r.width * dpr) + 2,
      Math.ceil(r.height * dpr) + 2,
    ]);
  }
  const capture = captureCount > 0;
  const key = JSON.stringify([rects, capture]);
  if (key === lastSent) return;
  lastSent = key;
  void ipc.setHitRegions(rects, capture).catch(() => {
    lastSent = "";
  });
}

export function scheduleHitFlush(): void {
  if (!frame) frame = requestAnimationFrame(flush);
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  // Catch CSS transitions / layout shifts that no observer reports.
  window.setInterval(scheduleHitFlush, 250);
  window.addEventListener("resize", scheduleHitFlush);
}

export function registerHitElement(el: HTMLElement): () => void {
  ensureStarted();
  elements.add(el);
  const ro = new ResizeObserver(scheduleHitFlush);
  ro.observe(el);
  scheduleHitFlush();
  return () => {
    ro.disconnect();
    elements.delete(el);
    scheduleHitFlush();
  };
}

/** Make the whole window interactive until the returned release function is called. */
export function pushCapture(): () => void {
  ensureStarted();
  captureCount += 1;
  scheduleHitFlush();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    captureCount = Math.max(0, captureCount - 1);
    scheduleHitFlush();
  };
}

export function useHitRegion(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    return registerHitElement(el);
  }, [ref, enabled]);
}

export function useCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return pushCapture();
  }, [active]);
}
