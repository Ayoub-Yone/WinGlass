// End-to-end verification of a lumabar release build, driven through the WebView2 DevTools
// protocol. Needs a binary built with a debugging port (wry ignores
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS), i.e. with a TAURI_CONFIG overlay that appends
// `--remote-debugging-port=9333 --remote-allow-origins=*` to both windows' additionalBrowserArgs:
//
//   TAURI_CONFIG="$(cat overlay.json)" cargo build --release      # verification build
//   node scripts/verify-e2e.mjs [path-to-lumabar.exe]
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
const exe = resolve(process.argv[2] ?? join(here, "..", "src-tauri", "target", "release", "lumabar.exe"));
const helper = join(here, "win-helper.ps1");
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "lumabar-verify-"));
const roaming = join(profile, "Roaming");
const local = join(profile, "Local");
mkdirSync(roaming, { recursive: true });
mkdirSync(local, { recursive: true });
const stateFile = join(roaming, "lumabar", "taskbar_state.json");

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
  if (/lumabar.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq lumabar.exe", "/NH"], { encoding: "utf8" }))) {
    throw new Error("lumabar.exe is already running — quit it before verifying");
  }

  // ---------------------------------------------------------------- first launch
  pid = launch();
  let dock = await Page.open("dock", 40000);
  let toast = await Page.open("toast");
  await sleep(1500);

  const first = await dock.invoke("get_settings");
  check("first launch: French", first.language === "fr" && (await dock.eval("document.documentElement.lang")) === "fr", `language=${first.language}`);
  check("first launch: matte liquid glass, balanced frost", first.theme === "liquid-glass" && first.glassFrost === "balanced", `${first.theme}/${first.glassFrost}`);
  check("first launch: taskbar auto-hidden", first.taskbarMode === "auto_hide" && taskbar().autoHide === true, JSON.stringify(taskbar()));
  check("taskbar state persisted while modified", existsSync(stateFile));
  check("only dock + toast webviews exist at idle", (await targets()).length === 2, (await targets()).map((t) => t.url.split("?")[1]).join(", "));

  const glass = await waitFor(async () => ((await dock.invoke("get_glass_status")) === "running" ? "running" : null), 8000);
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
        preMeetingPause: ["Revue de design dans 5 min", "À ", "Calendrier"],
        aiLimitWarning: ["Limite Claude Hebdo épuisée demain à 16:00", "À ce rythme · Réinitialisation"],
        revenueMilestone: ["en 30 jours", "Objectif atteint"],
        renewalReminder: ["Abonnement Figma se renouvelle", "À ", "Vérifier"],
      },
    },
    en: {
      dock: ["Search or open"],
      menu: ["Add Widgets…", "Style", "Size", "Position", "Langue / Language", "Automations", "Settings", "Restore Windows Taskbar & Quit"],
      toasts: {
        preMeetingPause: ["Design review in 5 min", "At ", "Calendar"],
        aiLimitWarning: ["Claude Weekly limit runs out tomorrow at 4:00 PM", "At this pace · Resets"],
        revenueMilestone: ["in 30 days", "Milestone reached"],
        renewalReminder: ["Figma subscription renews", "At ", "Review"],
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
      const badge = await dock.eval("(() => { const b = [...document.querySelectorAll('.uppercase')].find((e) => /^(LUN|MAR|MER|JEU|VEN|SAM|DIM)$/.test(e.innerText.trim().toUpperCase())); return b ? b.innerText.trim().toUpperCase() + ' ' + b.nextElementSibling.innerText.trim() : null; })()");
      check("fr: calendar day badge (LUN 20 style)", /^(LUN|MAR|MER|JEU|VEN|SAM|DIM) \d{1,2}$/.test(badge ?? ""), String(badge));
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
  check("idle host working set < 40 MB (Get-Process lumabar)", idle.hostWorkingSetMb < 40, `${idle.hostWorkingSetMb} MB`);

  // ---------------------------------------------------------------- layout audit (all widgets x spans x sizes x languages)
  await patchSettings(dock, { simulation: true });
  await sleep(1200);
  await dock.invoke("open_window", { label: "picker" });
  let picker = await Page.open("picker");
  await sleep(1500);
  for (const lang of ["fr", "en"]) {
    for (const size of ["compact", "medium", "large"]) {
      await patchSettings(dock, { language: lang, size });
      await sleep(500);
      const audit = await picker.eval(AUDIT);
      check(`layout ${lang}/${size}: ${audit.tiles} widgets, ${audit.cards} variants, no clipping / wrapping / overflow`, audit.tiles === 38 && audit.problems.length === 0, audit.problems.slice(0, 12).join("\n        "));
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
    return { labels: ['Subtil', 'Mat équilibré', 'Givre profond', 'Langue / Language', 'Français', 'English'].filter((s) => !text.includes(s)), range: document.querySelectorAll('input[type=range]').length };
  })()`);
  check("settings: frost slider + language selector present", frost.labels.length === 0 && frost.range >= 1, JSON.stringify(frost));
  await patchSettings(dock, { glassFrost: "deep" });
  check("frost setting persists", (await dock.invoke("get_settings")).glassFrost === "deep");
  await patchSettings(dock, { glassFrost: "balanced" });

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
  check("lumabar keeps running after the hotkey, mode persisted as native", alive(pid) && (await dock.invoke("get_settings")).taskbarMode === "native");
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
