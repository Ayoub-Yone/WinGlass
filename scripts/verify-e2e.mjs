// End-to-end verification of a winglass release build, driven through the WebView2 DevTools
// protocol. Needs a binary built with a debugging port (wry ignores
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), i.e. with a TAURI_CONFIG overlay that appends
// `--remote-debugging-port=9333 --remote-allow-origins=*` to both windows' additionalBrowserArgs:
//
//   TAURI_CONFIG="$(cat overlay.json)" cargo build --release      # verification build
//   node scripts/verify-e2e.mjs [path-to-winglass.exe]
//   cargo build --release                                         # rebuild without the port
//
// The app runs against a throw-away profile (APPDATA / LOCALAPPDATA redirected to a temp
// directory), so no real settings, secrets or layout are touched. The native taskbar IS modified
// while the test runs — that is the point — and every phase asserts it is put back.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = resolve(process.argv[2] ?? join(here, "..", "src-tauri", "target", "release", "winglass.exe"));
const helper = join(here, "win-helper.ps1");
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "winglass-verify-"));
const roaming = join(profile, "Roaming");
const local = join(profile, "Local");
mkdirSync(roaming, { recursive: true });
mkdirSync(local, { recursive: true });
const stateFile = join(roaming, "winglass", "taskbar_state.json");

const results = [];
const notes = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const note = (line) => {
  notes.push(line);
  console.log(`      ${line}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psArgs(action, extra) {
  return JSON.parse(
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", action, ...extra], { encoding: "utf8" }).trim(),
  );
}
function ps(action, pid = 0) {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", action, "-ProcessId", String(pid)], { encoding: "utf8" });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}
const taskbar = () => ps("taskbar");
const memory = (pid) => ps("memory", pid);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(fn, timeoutMs = 15000, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}

// ------------------------------------------------------------------ CDP plumbing

async function targets() {
  const resp = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await resp.json()).filter((t) => t.type === "page");
}
const findTarget = async (kind) => (await targets()).find((t) => t.url.includes(`window=${kind}`));

class Page {
  static async open(kind, timeoutMs = 20000) {
    const target = await waitFor(() => findTarget(kind), timeoutMs);
    if (!target) throw new Error(`no ${kind} webview on the debugging port`);
    const page = new Page();
    page.ws = new WebSocket(target.webSocketDebuggerUrl);
    page.pending = new Map();
    page.seq = 0;
    await new Promise((res, rej) => {
      page.ws.onopen = res;
      page.ws.onerror = () => rej(new Error(`cannot attach to ${kind}`));
    });
    page.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = page.pending.get(msg.id);
      if (waiter) {
        page.pending.delete(msg.id);
        waiter(msg);
      }
    };
    await waitFor(() => page.eval("Boolean(window.__TAURI_INTERNALS__ && document.getElementById('root')?.firstChild)"), timeoutMs);
    return page;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const msg = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text);
    return msg.result?.result?.value;
  }
  invoke(cmd, args = {}) {
    return this.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  }
  emit(event, payload) {
    return this.invoke("plugin:event|emit", { event, payload });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

function launch() {
  const child = spawn(exe, [], { env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local }, detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

async function patchSettings(dock, patch) {
  const current = await dock.invoke("get_settings");
  await dock.invoke("update_settings", { settings: { ...current, ...patch } });
  await sleep(450);
}

async function contextMenuLabels(dock) {
  return dock.eval(`(async () => {
    const pill = document.querySelector('.lb-pill');
    const r = pill.getBoundingClientRect();
    pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + 3 }));
    await new Promise((res) => setTimeout(res, 250));
    const main = [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((b) => b.innerText.trim());
    const clipped = [...document.querySelectorAll('[role=menu] [role=menuitem] span.truncate')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.innerText);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((res) => setTimeout(res, 150));
    return { main, clipped };
  })()`);
}

// Layout audit executed inside the picker: every widget, every span it supports.
const AUDIT = `(async () => {
  const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const problems = [];
  const ellipsis = [];
  let cards = 0;
  const tiles = [...document.querySelectorAll('[data-widget-tile]')];
  for (const tile of tiles) {
    const name = tile.dataset.widgetTile;
    const spanButtons = [...tile.querySelectorAll('button')].filter((b) => /^(1x1|2x1|3x1)$/.test(b.innerText.trim()));
    const variants = spanButtons.length ? spanButtons : [null];
    for (const button of variants) {
      if (button) { button.click(); await frame(); }
      const span = button ? button.innerText.trim() : 'auto';
      const pill = tile.querySelector('.lb-pill');
      const card = pill?.firstElementChild;
      if (!card) { problems.push(name + ' ' + span + ': no preview'); continue; }
      cards += 1;
      const box = card.getBoundingClientRect();
      const expected = getComputedStyle(document.documentElement).getPropertyValue('--lb-height').trim();
      if (Math.abs(pill.getBoundingClientRect().height - parseFloat(expected)) > 0.6) problems.push(name + ' ' + span + ': pill height ' + pill.getBoundingClientRect().height + ' != ' + expected);
      if (card.scrollWidth > card.clientWidth + 1 && getComputedStyle(card).overflowX !== 'visible' && span !== 'auto') problems.push(name + ' ' + span + ': horizontal overflow ' + card.scrollWidth + ' > ' + card.clientWidth);
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (!text) continue;
        const el = node.parentElement;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0) continue;
        // Nearest ancestor that truncates with an ellipsis (designed, visible truncation).
        let truncating = null;
        for (let a = el; a && a !== card.parentElement; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible') { truncating = a; break; }
        }
        if (truncating) {
          if (truncating.scrollWidth > truncating.clientWidth + 1) ellipsis.push(name + ' ' + span + ': "' + text + '"');
          continue;
        }
        // Hard clipping: text sticking out of the card or of any overflow-hidden ancestor.
        let clip = box;
        for (let a = el; a && a !== card; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
            const r = a.getBoundingClientRect();
            clip = { left: Math.max(clip.left, r.left), right: Math.min(clip.right, r.right), top: Math.max(clip.top, r.top), bottom: Math.min(clip.bottom, r.bottom) };
          }
        }
        // Vertical extent = the line box (nearest non-inline ancestor): an inline glyph box is taller
        // than its line-height without any ink being cut.
        let block = el;
        while (block !== card && getComputedStyle(block).display === 'inline') block = block.parentElement;
        const line = block.getBoundingClientRect();
        const dx = Math.max(clip.left - rect.left, rect.right - clip.right);
        const dy = Math.max(clip.top - line.top, line.bottom - clip.bottom);
        if (dx > 1 || dy > 1.5) {
          problems.push(name + ' ' + span + ': clipped "' + text + '" (' + (dx > 1 ? Math.round(dx) + 'px horizontally' : Math.round(dy * 10) / 10 + 'px vertically') + ')');
        }
        // Wrapping glitch: single-line labels must not break onto a second line.
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
        if (range.getClientRects().length > 1 && rect.height > lineHeight * 1.7 && el.tagName !== 'TEXTAREA') problems.push(name + ' ' + span + ': wrapped "' + text + '"');
      }
      // Numeric text must use tabular figures.
      for (const el of card.querySelectorAll('*')) {
        if (el.children.length === 0 && /\\d/.test(el.textContent) && !getComputedStyle(el).fontVariantNumeric.includes('tabular-nums')) {
          problems.push(name + ' ' + span + ': "' + el.textContent.trim() + '" is not tabular-nums');
        }
      }
    }
  }
  return { tiles: tiles.length, cards, problems, ellipsis };
})()`;

// ------------------------------------------------------------------ run

let pid = 0;
const original = taskbar();
console.log(`binary: ${exe}`);
console.log(`profile: ${profile}`);
console.log(`native taskbar before: ${JSON.stringify(original)}\n`);

try {
  if (!existsSync(exe)) throw new Error(`missing ${exe}`);
  // A second instance exits immediately (single-instance mutex) and the checks would silently
  // run against whatever is already on the debugging port.
  if (/winglass.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq winglass.exe", "/NH"], { encoding: "utf8" }))) {
    throw new Error("winglass.exe is already running — quit it before verifying");
  }

  // ---------------------------------------------------------------- first launch
  pid = launch();
  let dock = await Page.open("dock", 40000);
  let toast = await Page.open("toast");
  await sleep(1500);

  const first = await dock.invoke("get_settings");
  check("first launch: French", first.language === "fr" && (await dock.eval("document.documentElement.lang")) === "fr", `language=${first.language}`);
  check("first launch: iOS liquid glass, balanced frost", first.theme === "liquid-glass" && first.glassFrostLevel === 0.32, `${first.theme}/${first.glassFrostLevel}`);
  check("first launch: taskbar completely hidden", first.taskbarMode === "completely_hidden" && taskbar().visible === false, JSON.stringify(taskbar()));
  check("taskbar state persisted while modified", existsSync(stateFile));
  check("only dock + toast webviews exist at idle", (await targets()).length === 2, (await targets()).map((t) => t.url.split("?")[1]).join(", "));

  // Whatever the user has in front (a fullscreen game…) must not slide the dock away mid-test;
  // the fullscreen rule gets its own probe below.
  await patchSettings(dock, { hideOnFullscreen: false });
  await sleep(1500);
  const glass = await waitFor(async () => (/running$/.test(await dock.invoke("get_glass_status")) ? "running" : null), 8000);
  check("liquid glass capture running", glass === "running", String(await dock.invoke("get_glass_status")));
  const canvas = await dock.eval("(() => { const c = document.querySelector('.lb-pill canvas'); return c ? { w: c.width, h: c.height, bg: getComputedStyle(document.querySelector('.lb-pill')).backgroundColor } : null; })()");
  check("glass shader composited (pill background handed to WebGL)", canvas && canvas.w > 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(canvas.bg), JSON.stringify(canvas));

  // ---------------------------------------------------------------- size presets
  const scale = await dock.eval("window.devicePixelRatio");
  for (const [size, height] of [["compact", 46], ["large", 70], ["medium", 58]]) {
    await patchSettings(dock, { size });
    const layout = await dock.invoke("get_dock_layout");
    const pill = await dock.eval("document.querySelector('.lb-pill').getBoundingClientRect().height");
    const inner = await dock.eval("window.innerHeight");
    check(`size preset ${size}: ${height}px pill, window resized`, layout.dockHeight === height && Math.abs(pill - height) < 0.6 && Math.abs(inner - (470 + height + 10)) <= 1.5, `pill=${pill} window=${inner}`);
  }

  // ---------------------------------------------------------------- edge snapping + toast orientation
  const pushToast = (id) => dock.emit("toast:push", { id, title: "Orientation", subtitle: "verify", kind: "system", durationMs: 1500 });
  const toastInfo = (id) =>
    toast.eval(`(() => { const ID = ${JSON.stringify(id)}; const cards = [...document.querySelectorAll('[data-toast]')]; const card = cards.find((c) => c.dataset.toast === ID); const root = document.querySelector('#root > div');
      return { y: window.screenY, h: window.outerHeight, screenH: window.screen.height, direction: getComputedStyle(root).flexDirection,
               animation: card ? getComputedStyle(card).animationName : null, cardTop: card ? card.getBoundingClientRect().top : null, cardBottom: card ? card.getBoundingClientRect().bottom : null, inner: window.innerHeight }; })()`);
  const pillInfo = () => dock.eval("(() => { const r = document.querySelector('.lb-pill').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, inner: window.innerHeight, y: window.screenY, h: window.outerHeight, screenH: window.screen.height }; })()");

  await dock.invoke("set_dock_position", { position: "top" });
  await sleep(700);
  let p = await pillInfo();
  check("top snap: pill 10px below the top edge", Math.abs(p.top - 10) <= 1 && Math.abs(p.y) <= 1, JSON.stringify(p));
  await pushToast("orient-top");
  await sleep(450);
  let ti = await toastInfo("orient-top");
  check("top dock: toasts open downward, below the pill", ti.direction === "column-reverse" && ti.animation === "lb-toast-in-down" && Math.abs(ti.y - (10 + 58 + 12)) <= 2 && ti.cardTop < 12, JSON.stringify(ti));

  await dock.invoke("set_dock_position", { position: "bottom" });
  await sleep(700);
  p = await pillInfo();
  check("bottom snap: pill 10px above the bottom edge", Math.abs(p.inner - p.bottom - 10) <= 1 && Math.abs(p.y + p.h - p.screenH) <= 2, JSON.stringify(p));
  await pushToast("orient-bottom");
  await sleep(450);
  ti = await toastInfo("orient-bottom");
  check("bottom dock: toasts open upward, above the pill", ti.direction === "column" && ti.animation === "lb-toast-in-up" && Math.abs(ti.y + ti.h - (ti.screenH - 80)) <= 2 && ti.inner - ti.cardBottom < 12, JSON.stringify(ti));
  void scale;

  // ---------------------------------------------------------------- language switching (dock, menu, toasts)
  await patchSettings(dock, { simulation: true, doNotDisturb: false });
  await sleep(1500);
  const dockText = () => dock.eval("document.body.innerText + ' ' + [...document.querySelectorAll('input')].map((i) => i.placeholder).join(' ')");
  const toastText = async (rule) => {
    await dock.emit("automation:test", { rule });
    await sleep(700);
    return toast.eval("document.body.innerText");
  };
  const EXPECT = {
    fr: {
      dock: ["Rechercher ou ouvrir"],
      menu: ["Ajouter des widgets...", "Style", "Taille", "Position", "Langue / Language", "Automatisations", "Paramètres", "Restaurer la barre des tâches et quitter"],
      toasts: {
        preMeetingPause: ["Revue de design dans 2 min", "À ", "Calendrier"],
        aiLimitWarning: ["Limite Claude Hebdo épuisée demain à 16:00", "À ce rythme · Réinitialisation"],
        revenueMilestone: ["en 30 jours", "Objectif atteint"],
        renewalReminder: ["Abonnement Figma se renouvelle", "À ", "garder ou résilier ?", "Garder", "Résilier"],
      },
    },
    en: {
      dock: ["Search or open"],
      menu: ["Add Widgets…", "Style", "Size", "Position", "Langue / Language", "Automations", "Settings", "Restore Windows Taskbar & Quit"],
      toasts: {
        preMeetingPause: ["Design review in 2 min", "At ", "Calendar"],
        aiLimitWarning: ["Claude Weekly limit runs out tomorrow at 4:00 PM", "At this pace · Resets"],
        revenueMilestone: ["in 30 days", "Milestone reached"],
        renewalReminder: ["Figma subscription renews", "At ", "keep or cancel?", "Keep", "Cancel it"],
      },
    },
  };
  for (const lang of ["en", "fr"]) {
    await patchSettings(dock, { language: lang });
    const text = await dockText();
    check(`${lang}: dock widgets switch live`, EXPECT[lang].dock.every((s) => text.includes(s)) && (await dock.eval("document.documentElement.lang")) === lang, EXPECT[lang].dock.filter((s) => !text.includes(s)).join(" | "));
    const menu = await contextMenuLabels(dock);
    check(`${lang}: context menu switches live`, EXPECT[lang].menu.every((s) => menu.main.includes(s)), `got: ${menu.main.join(" | ")}`);
    check(`${lang}: context menu labels are not clipped`, menu.clipped.length === 0, menu.clipped.join(" | "));
    for (const [rule, strings] of Object.entries(EXPECT[lang].toasts)) {
      const shown = await toastText(rule);
      check(`${lang}: automation toast ${rule}`, strings.every((s) => shown.includes(s)), `missing: ${strings.filter((s) => !shown.includes(s)).join(" | ")}  got: ${shown.replace(/\n/g, " / ")}`);
    }
    const clippedToast = await toast.eval("[...document.querySelectorAll('[data-toast] .truncate')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.innerText)");
    check(`${lang}: toast text fits`, clippedToast.length === 0, clippedToast.join(" | "));
    if (lang === "fr") {
      // AI quota tile highlight follows the automation thresholds (simulated usage is > 1 %).
      const s0 = await dock.invoke("get_settings");
      const ai = s0.automations.aiLimitWarning;
      await patchSettings(dock, { automations: { ...s0.automations, aiLimitWarning: { ...ai, thresholdPercent: 1, criticalPercent: 100 } } });
      const warned = await waitFor(() => dock.eval(`document.querySelectorAll('.lb-card[data-alert="warn"]').length || null`), 4000);
      await patchSettings(dock, { automations: { ...s0.automations, aiLimitWarning: { ...ai, thresholdPercent: 1, criticalPercent: 2 } } });
      const critical = await waitFor(() => dock.eval(`document.querySelectorAll('.lb-card[data-alert="critical"]').length || null`), 4000);
      await patchSettings(dock, { automations: { ...s0.automations, aiLimitWarning: { ...ai, enabled: false } } });
      const off = await dock.eval(`document.querySelectorAll('.lb-card[data-alert]').length`);
      await patchSettings(dock, { automations: s0.automations });
      check("AI quota tiles highlight at the warning / critical thresholds, never when the rule is off", warned > 0 && critical > 0 && off === 0, JSON.stringify({ warned, critical, off, defaults: [ai.thresholdPercent, ai.criticalPercent] }));
      check("automation defaults: pause 2 min before meetings, AI warnings at 85 % and 95 %", s0.automations.preMeetingPause.minutes === 2 && ai.thresholdPercent === 85 && ai.criticalPercent === 95, JSON.stringify(s0.automations));
      const badge = await dock.eval("(() => { const b = [...document.querySelectorAll('.uppercase')].find((e) => /^(LUN|MAR|MER|JEU|VEN|SAM|DIM)$/.test(e.innerText.trim().toUpperCase())); return b ? b.innerText.trim().toUpperCase() + ' ' + b.nextElementSibling.innerText.trim() : null; })()");
      check("fr: calendar day badge (LUN 20 style)", /^(LUN|MAR|MER|JEU|VEN|SAM|DIM) \d{1,2}$/.test(badge ?? ""), String(badge));
      // Clicking the calendar card opens a month calendar (simulated events -> day dots + agenda).
      await dock.eval(`(() => { const c = document.querySelector('[data-instance="calendar-default"] .lb-card'); if (c) c.click(); return Boolean(c); })()`);
      const readCal = () =>
        dock.eval(`(() => {
          const m = document.querySelector('[data-testid="calendar-month"]');
          if (!m) return null;
          const pop = document.querySelector('[data-testid="calendar-popover"]').getBoundingClientRect();
          const pill = document.querySelector('.lb-pill').getBoundingClientRect();
          return {
            cells: m.querySelectorAll('[role="gridcell"]').length,
            today: m.querySelector('[aria-current="date"]')?.innerText.trim() ?? null,
            selected: m.querySelector('[aria-selected="true"]')?.getAttribute("aria-label") ?? null,
            title: m.querySelector('[aria-live]')?.innerText ?? null,
            headers: [...m.querySelectorAll('[role="columnheader"]')].map((h) => h.innerText.trim()).join(""),
            dots: m.querySelectorAll('[role="gridcell"] span[aria-hidden]').length,
            agenda: m.lastElementChild.innerText.replace(/\\s+/g, " ").slice(0, 160),
            top: pop.top, bottom: pop.bottom, pillTop: pill.top,
          };
        })()`);
      const cal = await waitFor(readCal, 4000);
      check(
        "calendar: clicking the card opens a month calendar (today marked, week starts Monday, fits above the dock)",
        cal && cal.cells % 7 === 0 && cal.cells >= 28 && cal.today === String(new Date().getDate()) && cal.headers.startsWith("L") && cal.top >= 0 && cal.bottom <= cal.pillTop,
        JSON.stringify(cal),
      );
      check("calendar: simulated events appear as day dots and in the selected day's agenda", cal && cal.dots > 0 && !/Rien de prévu/.test(cal.agenda), JSON.stringify({ dots: cal?.dots, agenda: cal?.agenda }));
      await dock.eval(`document.querySelector('[data-testid="calendar-month"] [aria-label="Mois suivant"]').click()`);
      await sleep(150);
      const nextMonth = await readCal();
      check("calendar: « Mois suivant » shows the next month", nextMonth && nextMonth.title !== cal?.title && nextMonth.today === null, JSON.stringify({ from: cal?.title, to: nextMonth?.title }));
      await dock.eval(`document.querySelector('[data-testid="calendar-month"] [role="grid"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))`);
      await sleep(150);
      await dock.eval(`document.querySelector('[data-testid="calendar-month"] [role="grid"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`);
      await sleep(150);
      const moved = await readCal();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      check("calendar: Home returns to today, ArrowRight selects the next day", moved && moved.selected?.includes(String(tomorrow.getDate())) && moved.title === cal?.title || (tomorrow.getDate() === 1 && moved?.selected?.includes("1")), JSON.stringify(moved?.selected));
      await dock.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await sleep(200);
      check("calendar: Escape closes the month calendar", (await dock.eval(`!document.querySelector('[data-testid="calendar-month"]')`)) === true);
      const clock = await dock.eval("[...document.querySelectorAll('.lb-card')].map((c) => c.innerText).find((x) => /^\\d{2}:\\d{2}\\n/.test(x)) ?? null");
      check("fr: 24-hour clock", clock !== null && !/AM|PM/.test(clock), JSON.stringify(clock));
    }
  }

  // ---------------------------------------------------------------- memory: idle, modals open, modals closed
  await sleep(11000); // startup trim fires 10 s after launch; let the dock settle too
  await dock.invoke("update_settings", { settings: { ...(await dock.invoke("get_settings")), simulation: false } });
  await sleep(3000);
  const idle = memory(pid);
  note(`idle: host working set ${idle.hostWorkingSetMb} MB (private ${idle.hostPrivateMb} MB), ${idle.webviewCount} WebView2 processes, ${idle.childWorkingSetMb} MB`);
  check("idle host working set < 40 MB (Get-Process winglass)", idle.hostWorkingSetMb < 40, `${idle.hostWorkingSetMb} MB`);

  // ---------------------------------------------------------------- integrated launcher (no Win+S)
  const apps = await dock.invoke("search_installed_apps", { query: "a" });
  const launchable = (a) => /\.(lnk|url|exe)$/i.test(a.path) || (a.kind === "packaged" && /^shell:AppsFolder\\[^\\]+![^\\]+$/.test(a.path));
  check("search_installed_apps: Start Menu / Desktop / packaged / App Paths index answers", Array.isArray(apps) && apps.length > 0 && apps.every(launchable), JSON.stringify(apps?.slice?.(0, 3)));
  // Packaged (MSIX / Store) apps have no .lnk: they come from the shell AppsFolder (Calculator ships with Windows).
  const calc = await dock.invoke("search_installed_apps", { query: "calc" });
  const packagedHit = calc.find((a) => a.kind === "packaged");
  check("search: packaged Store apps are indexed (Calculatrice via shell:AppsFolder)", Boolean(packagedHit) && launchable(packagedHit), JSON.stringify(calc.map((a) => [a.name, a.kind])));
  if (packagedHit) {
    const icon = await dock.invoke("get_app_icon", { key: packagedHit.path });
    check("search: packaged app icon resolves through its AppsFolder item", typeof icon === "string" && icon.startsWith("data:image/png"), String(icon).slice(0, 40));
  }
  const claudeHits = await dock.invoke("search_installed_apps", { query: "claude" });
  note(`search "claude": ${JSON.stringify(claudeHits.map((a) => [a.name, a.kind]))}`);
  const fake = await dock.invoke("launch_app", { path: "shell:AppsFolder\\Not.Indexed_123!App" }).then(() => "ok", (e) => String(e));
  check("launch_app refuses AppsFolder AUMIDs that are not in the index", fake !== "ok", fake);
  const typeSearch = (text) =>
    dock.eval(`(() => {
      const input = document.querySelector('[data-testid="search-input"]');
      if (!input) return false;
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  check("search widget present in the default layout", Boolean(await typeSearch("a")));
  const flyout = await waitFor(
    () =>
      dock.eval(`(() => {
        const list = document.querySelector('[data-testid="search-results"]');
        const pill = document.querySelector('[data-testid="dock-pill"]') ?? document.querySelector(".lb-pill");
        if (!list) return null;
        const r = list.parentElement.getBoundingClientRect();
        const p = pill ? pill.getBoundingClientRect() : null;
        return { hits: list.querySelectorAll('[data-testid="search-hit"]').length, bottom: r.bottom, pillTop: p ? p.top : null };
      })()`),
    5000,
  );
  check("search flyout lists apps directly above the dock without overlapping it", flyout && flyout.hits > 0 && (flyout.pillTop === null || flyout.bottom <= flyout.pillTop), JSON.stringify(flyout));
  const keyOnInput = (key) =>
    dock.eval(`document.querySelector('[data-testid="search-input"]').dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }))`);
  await keyOnInput("ArrowDown");
  await sleep(100);
  const activeIndex = await dock.eval(`[...document.querySelectorAll('[data-testid="search-results"] button')].findIndex((b) => b.dataset.active === "true")`);
  check("search flyout: ArrowDown moves the selection", activeIndex === 1, String(activeIndex));
  await keyOnInput("Escape");
  await sleep(200);
  check("search flyout: Escape dismisses", (await dock.eval(`!document.querySelector('[data-testid="search-results"]')`)) === true);
  // Typed local paths open in Explorer (rows only — Enter would open a real Explorer window).
  await typeSearch("C:\\Win");
  const pathRows = await waitFor(() => dock.eval(`(() => { const r = [...document.querySelectorAll('[data-testid="search-path"]')].map((e) => e.innerText.replace(/\\s+/g, " ")); return r.length ? r : null; })()`), 4000);
  check("search: a typed local path lists matching folders (C:\\Win -> Windows)", pathRows && pathRows.some((r) => r.startsWith("Windows")), JSON.stringify(pathRows));
  await typeSearch("C:\\Windows");
  const exactPath = await waitFor(() => dock.eval(`document.querySelector('[data-testid="search-path"]')?.innerText.includes("Ouvrir Windows dans l'Explorateur") || null`), 4000);
  check("search: an exact folder offers « Ouvrir … dans l'Explorateur »", exactPath === true);
  const completions = await dock.invoke("complete_path", { query: "%WINDIR%\\Sys" });
  check("complete_path expands %VARS% and lists folders first", completions.length > 0 && completions[0].isDir && completions.every((h) => /^c:\\windows\\sys/i.test(h.path)), JSON.stringify(completions.map((h) => h.name)));
  const share = await dock.invoke("open_path", { path: "\\\\server\\share" }).then(() => "ok", (e) => String(e));
  check("open_path refuses network shares and missing paths", share !== "ok");
  await dock.eval(`document.querySelector('[data-testid="search-input"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(200);

  // ---------------------------------------------------------------- brightness (WMI panel / DDC/CI monitors)
  const displays = await dock.invoke("get_brightness");
  check("get_brightness: adjustable displays with 0–100 % values", Array.isArray(displays) && displays.every((d) => d.id && d.percent >= 0 && d.percent <= 100), JSON.stringify(displays));
  if (displays[0]) {
    const same = await dock.invoke("set_brightness", { id: displays[0].id, percent: displays[0].percent });
    check("set_brightness round-trips the current value (no visible change)", Math.abs(same.percent - displays[0].percent) <= 2, JSON.stringify(same));
  }
  const searchHost = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Process SearchHost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count"], { encoding: "utf8" }).trim();
  check("Windows Search overlay never opened", searchHost === "" || searchHost === "0", searchHost);

  // ---------------------------------------------------------------- system volume (WASAPI)
  const audio0 = await dock.invoke("audio_state");
  check("audio_state: default output endpoint bound", audio0.available === true && audio0.devices.some((d) => d.isDefault), JSON.stringify({ ...audio0, devices: audio0.devices?.length }));
  const volumeCard = await dock.eval(`Boolean(document.querySelector('[data-testid="volume-widget"]'))`);
  check("volume widget enabled by default in the dock", volumeCard === true);
  if (audio0.available) {
    const wheel = (deltaY) =>
      dock.eval(`document.querySelector('[data-testid="volume-widget"]').dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, bubbles: true }))`);
    const down = audio0.volume >= 2 ? 100 : -100; // wheel down lowers; stay inside 0–100
    await wheel(down);
    const stepped = await waitFor(async () => {
      const s = await dock.invoke("audio_state");
      return s.volume !== audio0.volume ? s : null;
    }, 3000);
    check("mouse wheel over the volume widget steps the system volume by 2%", stepped && Math.abs(stepped.volume - audio0.volume) === 2, `${audio0.volume} -> ${stepped?.volume}`);
    await sleep(300);
    await wheel(-down);
    const back = await waitFor(async () => {
      const s = await dock.invoke("audio_state");
      return s.volume === audio0.volume ? s : null;
    }, 3000);
    check("wheel back restores the original volume (callback-fed state)", Boolean(back), String(back?.volume));
    const shownPct = await dock.eval(`document.querySelector('[data-testid="volume-widget"]').innerText`);
    check("volume widget shows the live percentage", shownPct.includes(`${audio0.volume}%`) || (audio0.muted && shownPct.includes("0%")), shownPct);
    await dock.eval(`document.querySelector('[data-testid="volume-widget"]').closest('.lb-card').click()`);
    const pop = await waitFor(() => dock.eval(`(() => { const p = document.querySelector('[data-testid="volume-popover"]'); return p ? { slider: !!p.querySelector('[data-testid="volume-slider"]'), mute: !!p.querySelector('[data-testid="volume-mute"]'), devices: p.querySelectorAll('[data-testid="volume-device"]').length } : null; })()`), 3000);
    check("volume flyout: mute button, slider and output devices", pop && pop.slider && pop.mute && pop.devices === audio0.devices.length, JSON.stringify(pop));
    const wheelOn = (sel, deltaY) => dock.eval(`document.querySelector('${sel}').dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, bubbles: true, cancelable: true }))`);
    await wheelOn('[data-testid="volume-devices"]', down);
    await sleep(700);
    check("volume flyout: wheel over the device list scrolls, volume untouched", (await dock.invoke("audio_state")).volume === audio0.volume);
    const notCancelled = await wheelOn('[data-testid="volume-slider"]', down);
    const viaSlider = await waitFor(async () => { const st = await dock.invoke("audio_state"); return st.volume !== audio0.volume ? st : null; }, 3000);
    check("volume flyout: wheel over the master slider steps the volume (popover does not scroll)", viaSlider && Math.abs(viaSlider.volume - audio0.volume) === 2 && notCancelled === false, `${audio0.volume} -> ${viaSlider?.volume}, defaultPrevented=${!notCancelled}`);
    await sleep(300);
    await wheelOn('[data-testid="volume-slider"]', -down);
    await waitFor(async () => ((await dock.invoke("audio_state")).volume === audio0.volume ? true : null), 3000);
    const mixer = await waitFor(() => dock.eval(`(() => { const m = document.querySelector('[data-testid="volume-apps"]'); return m ? { rows: m.querySelectorAll('[data-testid="app-volume-row"]').length, sliders: m.querySelectorAll('[data-testid="app-volume-slider"]').length } : null; })()`), 3000);
    const sessions = await dock.invoke("get_audio_sessions");
    check("volume flyout: per-app mixer lists every audio session", mixer && mixer.rows === sessions.length && mixer.sliders === sessions.length, `${JSON.stringify(mixer)} sessions=${sessions.map((a) => a.name || "system").join(", ")}`);
    const scrollable = await dock.eval(`(() => { const p = document.querySelector('[data-testid="volume-popover"]'); return getComputedStyle(p).overflowY; })()`);
    check("volume flyout scrolls (overflow-y: auto)", scrollable === "auto", scrollable);
    await dock.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await sleep(200);
    check("volume flyout closes on Escape", (await dock.eval(`!document.querySelector('[data-testid="volume-popover"]')`)) === true);
  }

  // ---------------------------------------------------------------- hidden-icons chevron + tray card (no tray strip in the bar)
  const tray = await dock.invoke("get_tray_icons");
  check("get_tray_icons: running tray apps, never the shell, winglass listed as itself", Array.isArray(tray) && tray.every((t) => t.id && t.name && !/\\explorer\.exe$/i.test(t.exe)) && tray.some((t) => t.isSelf && /winglass\.exe$/i.test(t.exe)), JSON.stringify(tray.map((t) => `${t.name}${t.isSelf ? "*" : ""}`)));
  const chevron = await waitFor(() => dock.eval(`(() => {
    const c = document.querySelector('.lb-pill [data-testid="tray-chevron"]');
    if (!c) return null;
    const slot = c.closest('[data-instance]');
    const next = slot?.nextElementSibling;
    return { up: Boolean(c.querySelector('.lucide-chevron-up')), tile: c.classList.contains('lb-card'), label: c.getAttribute('aria-label'), iconsInBar: document.querySelectorAll('.lb-pill [data-testid="tray-icon"]').length, nextIsClock: Boolean(next && next.getAttribute('data-instance')?.startsWith('clock')) };
  })()`), 6000);
  check("one rounded « Afficher les icônes cachées » chevron tile (^), left of the clock, zero tray icons in the bar", chevron && chevron.up && chevron.tile && chevron.label === "Afficher les icônes cachées" && chevron.iconsInBar === 0 && chevron.nextIsClock, JSON.stringify(chevron));
  const shellBefore = taskbar();
  await dock.eval(`document.querySelector('[data-testid="tray-chevron"]').click()`);
  const card = await waitFor(() => dock.eval(`(() => {
    const card = document.querySelector('[data-testid="tray-card"]');
    const grid = document.querySelector('[data-testid="tray-grid"]');
    if (!card || !grid) return null;
    const cs = getComputedStyle(card), gs = getComputedStyle(grid);
    const cr = card.getBoundingClientRect(), ch = document.querySelector('[data-testid="tray-chevron"]').getBoundingClientRect();
    const cells = [...grid.querySelectorAll('[data-testid="tray-icon"]')];
    const img = cells[0]?.querySelector('img, svg')?.getBoundingClientRect();
    return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, border: cs.borderTopColor, padding: cs.paddingTop, columns: gs.gridTemplateColumns.split(' ').length, gap: gs.columnGap, cells: cells.length, self: grid.querySelectorAll('[data-self]').length, gapAbove: Math.round(ch.top - cr.bottom), icon: img ? Math.round(img.width) : 0, labelsUnderIcons: grid.innerText.trim().length };
  })()`), 3000);
  check("tray card: 22px radius, rgba(24,24,26,0.92), 1px rgba(255,255,255,0.08) border, 22px padding, ~10px above the chevron", card && card.radius === "22px" && card.bg === "rgba(24, 24, 26, 0.92)" && card.border === "rgba(255, 255, 255, 0.08)" && card.padding === "22px" && Math.abs(card.gapAbove - 10) <= 1, JSON.stringify(card));
  check("tray card: 5-column grid, 22px gaps, 28–30px icons, every tray app incl. winglass, no text labels", card && card.columns === 5 && card.gap === "22px" && card.icon >= 26 && card.icon <= 30 && card.cells === tray.length && card.self === 1 && card.labelsUnderIcons === 0, JSON.stringify(card));
  const tip = await dock.eval(`(() => { const b = document.querySelector('[data-testid="tray-grid"] [data-testid="tray-icon"]'); b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); return new Promise((r) => setTimeout(() => r({ want: b.getAttribute('aria-label'), got: document.querySelector('[data-testid="tray-tooltip"]')?.textContent ?? null }), 120)); })()`);
  check("hovering a tray icon shows a floating app-name tooltip", tip.got === tip.want, JSON.stringify(tip));
  // Right click on winglass's own icon: winglass's glass menu, never the Windows tray.
  await dock.eval(`document.querySelector('[data-testid="tray-grid"] [data-self]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))`);
  const trayMenu = await waitFor(() => dock.eval(`(() => { const m = document.querySelector('[data-testid="tray-menu"]'); return m ? { header: m.querySelector('[data-testid="tray-menu-header"]').innerText.trim(), items: [...m.querySelectorAll('[role="menuitem"]')].map((i) => i.innerText.trim()), cardClosed: !document.querySelector('[data-testid="tray-card"]') } : null; })()`), 3000);
  check("right click: winglass menu with the app's name + Ouvrir / Paramètres / Quitter", trayMenu && trayMenu.header === "winglass" && JSON.stringify(trayMenu.items) === JSON.stringify(["Ouvrir", "Paramètres", "Quitter"]), JSON.stringify(trayMenu));
  const shellAfterMenu = taskbar();
  check("right click never shows Shell_TrayWnd or an overflow window", shellAfterMenu.visible === shellBefore.visible && shellAfterMenu.overflow === false, JSON.stringify({ before: shellBefore, after: shellAfterMenu }));
  await dock.eval(`document.querySelector('[data-testid="tray-menu-settings"]').click()`);
  const settingsFromTray = await waitFor(async () => ((await findTarget("settings")) ? true : null), 8000);
  check("Paramètres on winglass opens winglass's Settings", settingsFromTray === true);
  await dock.invoke("close_window", { label: "settings" }).catch(() => undefined);
  await sleep(500);
  // Escape / outside click dismiss the card; the menu closes on Escape.
  await dock.eval(`document.querySelector('[data-testid="tray-chevron"]').click()`);
  await sleep(200);
  await dock.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(200);
  check("tray card closes on Escape", (await dock.eval(`!document.querySelector('[data-testid="tray-card"]')`)) === true);
  await dock.eval(`document.querySelector('[data-testid="tray-chevron"]').click()`);
  await sleep(200);
  await dock.eval(`document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await sleep(200);
  check("tray card closes on an outside click", (await dock.eval(`!document.querySelector('[data-testid="tray-card"]')`)) === true);
  const bad = await dock.invoke("tray_icon_action", { id: "no-such-id", action: "quit" }).then(() => "ok", (e) => String(e));
  const selfEntry = tray.find((t) => t.isSelf);
  const selfAct = selfEntry ? await dock.invoke("tray_icon_action", { id: selfEntry.id, action: "quit" }).then(() => "ok", (e) => String(e)) : "no self";
  check("tray_icon_action rejects unknown items and never quits winglass behind the dock's back", bad !== "ok" && selfAct !== "ok" && taskbar().overflow === false, `${bad} | ${selfAct}`);

  // ---------------------------------------------------------------- dock magnification (local compression) + glass bulge
  const mag = await dock.eval(`(async () => {
    const pill = document.querySelector('.lb-pill');
    const slots = [...pill.querySelectorAll('[data-mag-group] [data-mag]')];
    if (slots.length < 1) return { slots: slots.length };
    const rest = slots.map((s) => s.getBoundingClientRect());
    const stripL = rest[0].left, stripR = rest[rest.length - 1].right;
    const move = (x, y) => document.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    const settle = async (x, y) => { for (let i = 0; i < 40; i++) { move(x, y); await new Promise((res) => requestAnimationFrame(res)); } await new Promise((res) => setTimeout(res, 300)); };
    const icon = (el) => el.querySelector('[data-mag-icon]');
    const scale = (el) => parseFloat(icon(el).style.getPropertyValue("--mag-scale")) || 1;
    const pr = pill.getBoundingClientRect();
    const bounds = () => {
      const r = slots.map((s) => s.getBoundingClientRect());
      const ir = slots.map((s) => icon(s).getBoundingClientRect());
      return {
        // What you see: the icons stay inside the strip footprint (slots only translate).
        left: Math.min(...ir.map((x) => x.left)) - stripL,
        right: stripR - Math.max(...ir.map((x) => x.right)),
        top: Math.min(...ir.map((x) => x.top)) - pr.top,
        bottom: pr.bottom - Math.max(...ir.map((x) => x.bottom)),
        // Icons (what you see) never overlap; slots only translate, so their invisible hit boxes may touch.
        overlap: ir.slice(1).some((x, i) => x.left < ir[i].right - 0.5),
      };
    };
    const mid = Math.floor(slots.length / 2);
    await settle(rest[mid].left + rest[mid].width / 2, rest[mid].top + rest[mid].height / 2);
    const label = document.querySelector(".lb-mag-label");
    const out = {
      slots: slots.length,
      hovered: scale(slots[mid]),
      n1: slots.length > 1 ? scale(slots[mid + 1] ?? slots[mid - 1]) : null,
      n2: slots[mid + 2] || slots[mid - 2] ? scale(slots[mid + 2] ?? slots[mid - 2]) : null,
      lift: icon(slots[mid]).style.getPropertyValue("--mag-lift-y"),
      label: label.textContent,
      labelOpacity: Number(label.style.opacity),
      mid: bounds(),
    };
    // Edge icons: the strip must stay inside its resting footprint.
    await settle(rest[0].left + rest[0].width / 2, rest[0].top + rest[0].height / 2);
    out.first = bounds();
    await settle(rest[rest.length - 1].left + rest[rest.length - 1].width / 2, rest[0].top + rest[0].height / 2);
    out.last = bounds();
    move(rest[0].left, rest[0].top - 400);
    await new Promise((res) => setTimeout(res, 700));
    out.after = scale(slots[mid]);
    return out;
  })()`);
  const inside = (b) => b && b.left >= -0.6 && b.right >= -0.6 && b.top >= -9.5 && b.bottom >= -0.6 && !b.overlap;
  check("magnification: hovered ~1.34x, neighbours shrink (~0.84x, ~0.92x), lifted ~4px, label shown", (mag.slots >= 5
      ? mag.hovered > 1.28 && mag.hovered <= 1.3401 && mag.n1 > 0.8 && mag.n1 < 0.9 && mag.n2 > 0.88 && mag.n2 < 0.96 && parseFloat(mag.lift) <= -3.5
      : // Short strips cannot absorb the growth: compressed uniformly, hovered still largest.
        mag.hovered > 1.15 && mag.hovered <= 1.3401 && (mag.n1 === null || mag.n1 < mag.hovered) && parseFloat(mag.lift) <= -2) && mag.labelOpacity > 0.5 && mag.label, JSON.stringify(mag));
  check("magnification: no icon leaves the strip / capsule, no overlap (middle, first and last icon)", inside(mag.mid) && inside(mag.first) && inside(mag.last), JSON.stringify({ mid: mag.mid, first: mag.first, last: mag.last }));
  check("magnification settles back to 1x when the cursor leaves", mag.after === 1, JSON.stringify(mag));
  const glassAfterHover = await dock.eval("(() => { const c = document.querySelector('.lb-pill canvas'); return c ? { w: c.width, h: c.height, pill: document.querySelector('.lb-pill').getBoundingClientRect().height * devicePixelRatio } : null; })()");
  check("glass canvas extends above/below the pill for the bulge, shader still live", glassAfterHover && glassAfterHover.h > glassAfterHover.pill + 10 && /running$/.test(await dock.invoke("get_glass_status")), JSON.stringify(glassAfterHover));

  // ---------------------------------------------------------------- accounts auto-detection
  const claudeAccount = await dock.invoke("account_status", { provider: "claude" });
  check("account_status answers for Claude / ChatGPT / Gemini", typeof claudeAccount.connected === "boolean" && ["cli", "manual", "none"].includes(claudeAccount.source), JSON.stringify(claudeAccount));

  // ---------------------------------------------------------------- hover + fullscreen visibility (raw Win32)
  const pillCenter = await dock.eval(`(() => {
    const cards = [...document.querySelectorAll(".lb-card")];
    const r = cards[Math.floor(cards.length / 2)].getBoundingClientRect();
    return { x: Math.round(window.screenX + (r.left + r.width / 2) * devicePixelRatio), y: Math.round(window.screenY + (r.top + r.height / 2) * devicePixelRatio) };
  })()`);
  const hover = psArgs("hover", ["-ProcessId", String(pid), "-X", String(pillCenter.x), "-Y", String(pillCenter.y)]);
  check("hover: IsWindowVisible stays true on winglass, false on Shell_TrayWnd", hover.duringHover >= 1 && hover.afterHover >= 1 && hover.trayVisible === false, JSON.stringify(hover));
  await patchSettings(dock, { hideOnFullscreen: true });
  const fs = psArgs("fullscreen", ["-ProcessId", String(pid)]);
  await patchSettings(dock, { hideOnFullscreen: false });
  note(`fullscreen probe: ${JSON.stringify(fs)}`);
  check("borderless fullscreen app in front hides the dock", fs.foregroundWasProbe && fs.inFullscreen === 0, JSON.stringify(fs));
  // After Alt is released the previous app returns: the dock hides again if that is a fullscreen game.
  check("Alt+Tab out of the fullscreen app wakes the dock immediately (< 400 ms)", fs.wakeMs >= 0 && fs.wakeMs < 400, `wake ${fs.wakeMs} ms, switcher ${fs.switcherClass}, after ${fs.afterAltTab}`);

  // ---------------------------------------------------------------- layout audit (all widgets x spans x sizes x languages)
  await patchSettings(dock, { simulation: true });
  await sleep(1200);
  await dock.invoke("open_window", { label: "picker" });
  let picker = await Page.open("picker");
  await sleep(1500);
  const fullCatalog = await waitFor(() => picker.eval("document.querySelectorAll('[data-widget-tile]').length >= 41"), 10000);
  if (!fullCatalog) note(`picker state: ${JSON.stringify(await picker.eval("({ tiles: document.querySelectorAll('[data-widget-tile]').length, inputs: [...document.querySelectorAll('input')].map((i) => i.value), focus: document.hasFocus(), hidden: document.hidden })"))}`);
  for (const lang of ["fr", "en"]) {
    for (const size of ["compact", "medium", "large"]) {
      await patchSettings(dock, { language: lang, size });
      await sleep(500);
      const audit = await picker.eval(AUDIT);
      check(`layout ${lang}/${size}: ${audit.tiles} widgets, ${audit.cards} variants, no clipping / wrapping / overflow`, audit.tiles === 41 && audit.problems.length === 0, audit.problems.slice(0, 12).join("\n        "));
      if (audit.ellipsis.length) note(`${lang}/${size} ellipsis-truncated (by design): ${audit.ellipsis.join("; ")}`);
    }
  }
  await patchSettings(dock, { language: "fr", size: "medium" });

  await dock.invoke("open_window", { label: "settings", tab: "automations" });
  const settingsPage = await Page.open("settings");
  await sleep(1200);
  const heading = await settingsPage.eval("document.querySelector('h2')?.innerText");
  check("settings opens lazily on the requested tab, in French", heading === "Automatisations", String(heading));
  const frost = await settingsPage.eval(`(async () => {
    [...document.querySelectorAll('nav button')][0].click();
    await new Promise((r) => setTimeout(r, 250));
    const text = document.body.innerText;
    return { labels: ['Clair', 'Équilibré', 'Givré / teinté', 'Langue / Language', 'Français', 'English'].filter((s) => !text.includes(s)), range: document.querySelectorAll('input[type=range]').length };
  })()`);
  check("settings: frost slider + language selector present", frost.labels.length === 0 && frost.range >= 1, JSON.stringify(frost));
  await patchSettings(dock, { glassFrostLevel: 0.85 });
  check("frost setting persists", (await dock.invoke("get_settings")).glassFrostLevel === 0.85);
  await patchSettings(dock, { glassFrostLevel: 0.32 });

  const open = memory(pid);
  note(`picker + settings open: host ${open.hostWorkingSetMb} MB, ${open.webviewCount} WebView2 processes, ${open.childWorkingSetMb} MB`);
  check("picker + settings webviews exist only while open", (await targets()).length === 4);

  picker.close();
  settingsPage.close();
  await dock.invoke("close_window", { label: "picker" });
  await dock.invoke("close_window", { label: "settings" });
  await patchSettings(dock, { simulation: false });
  const gone = await waitFor(async () => (await targets()).length === 2, 8000);
  check("picker + settings webviews destroyed on close", Boolean(gone), (await targets()).map((t) => t.url.split("?")[1]).join(", "));
  await sleep(5000); // close-trim fires 1.5 s after destruction
  const closed = memory(pid);
  note(`modals closed: host ${closed.hostWorkingSetMb} MB, ${closed.webviewCount} WebView2 processes, ${closed.childWorkingSetMb} MB`);
  check("host working set back under 40 MB after closing modals", closed.hostWorkingSetMb < 40, `${closed.hostWorkingSetMb} MB`);
  check("renderer processes released after closing modals", closed.webviewCount < open.webviewCount, `${open.webviewCount} -> ${closed.webviewCount}`);

  // ---------------------------------------------------------------- restore: emergency hotkey
  check("taskbar auto-hidden before hotkey", taskbar().autoHide === true);
  ps("hotkey");
  const restoredByHotkey = await waitFor(() => {
    const t = taskbar();
    return t.autoHide === original.autoHide && t.visible ? t : null;
  }, 5000);
  check("Ctrl+Alt+Shift+R restores the taskbar", Boolean(restoredByHotkey), JSON.stringify(taskbar()));
  check("winglass keeps running after the hotkey, mode persisted as native", alive(pid) && (await dock.invoke("get_settings")).taskbarMode === "native");
  check("state file removed once restored", !existsSync(stateFile));

  // ---------------------------------------------------------------- restore: graceful exit
  await dock.invoke("set_taskbar_mode", { mode: "auto_hide" });
  await sleep(600);
  check("taskbar re-hidden for the exit tests", taskbar().autoHide === true && existsSync(stateFile));
  dock.close();
  toast.close();
  execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" }); // WM_CLOSE, no /F
  const exited = await waitFor(() => !alive(pid), 10000);
  check("graceful taskkill exits", Boolean(exited));
  await sleep(500);
  let after = taskbar();
  check("graceful exit restores the taskbar", after.autoHide === original.autoHide && after.visible && !existsSync(stateFile), JSON.stringify(after));

  // ---------------------------------------------------------------- restore: taskkill /F (guardian)
  pid = launch();
  dock = await Page.open("dock", 40000);
  await sleep(1500);
  check("relaunch remembers settings and re-hides the taskbar", (await dock.invoke("get_settings")).language === "fr" && taskbar().autoHide === true && existsSync(stateFile));
  dock.close();
  execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  const repaired = await waitFor(() => {
    const t = taskbar();
    return !alive(pid) && t.autoHide === original.autoHide && t.visible && !existsSync(stateFile) ? t : null;
  }, 10000);
  after = taskbar();
  check("taskkill /F: guardian restores the taskbar", Boolean(repaired), JSON.stringify(after));
  pid = 0;
} catch (err) {
  check("verification run completed", false, err?.stack ?? String(err));
} finally {
  if (pid && alive(pid)) {
    try {
      execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" });
      await sleep(2500);
      if (alive(pid)) execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  await sleep(2500);
  const end = taskbar();
  check("native taskbar identical to before the run", end.autoHide === original.autoHide && end.visible === original.visible, JSON.stringify(end));
  // Throw-away profile: no test database, settings or WebView2 data survive.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(700);
    }
  }
  check("temporary test profile removed", !existsSync(profile), profile);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (notes.length) console.log(notes.map((n) => `  ${n}`).join("\n"));
process.exit(failed.length ? 1 : 0);
