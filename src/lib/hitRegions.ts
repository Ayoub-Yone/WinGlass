// Interactive-region bookkeeping for click-through overlay windows (dock + toast).
// Every registered element's bounding box (physical px) is sent to the backend, which toggles
// set_ignore_cursor_events as the cursor enters/leaves them. "Capture" mode makes the entire
// window interactive (drags, open context menus). "Hold" tells the auto-hide engine to keep the dock
// shown: a flyout / preview / menu is open or a text field has focus.

import { useEffect, type RefObject } from "react";
import { ipc, type HitRect } from "./ipc";

const elements = new Set<HTMLElement>();
const holdElements = new Set<HTMLElement>();
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
  const active = document.activeElement;
  const typing = document.hasFocus() && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);
  const hold = capture || typing || [...holdElements].some((el) => el.isConnected);
  const key = JSON.stringify([rects, capture, hold]);
  if (key === lastSent) return;
  lastSent = key;
  void ipc.setHitRegions(rects, capture, hold).catch(() => {
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
  window.addEventListener("focusin", scheduleHitFlush);
  window.addEventListener("focusout", scheduleHitFlush);
  window.addEventListener("blur", scheduleHitFlush);
}

/** `hold`: while registered, the element keeps an auto-hiding dock shown (flyouts, previews). */
export function registerHitElement(el: HTMLElement, hold = false): () => void {
  ensureStarted();
  elements.add(el);
  if (hold) holdElements.add(el);
  const ro = new ResizeObserver(scheduleHitFlush);
  ro.observe(el);
  scheduleHitFlush();
  return () => {
    ro.disconnect();
    elements.delete(el);
    holdElements.delete(el);
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

export function useHitRegion(ref: RefObject<HTMLElement | null>, enabled = true, hold = false): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    return registerHitElement(el, hold);
  }, [ref, enabled, hold]);
}

export function useCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return pushCapture();
  }, [active]);
}
