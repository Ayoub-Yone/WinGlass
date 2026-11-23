// Native-styled glass context menu with one level of submenus. While open, the whole dock
// window captures the cursor so clicking anywhere outside dismisses it.

import { Check, ChevronRight, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useCapture } from "../lib/hitRegions";

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  submenu?: MenuItem[];
  onSelect?: () => void;
}

/** Menu width that fits its longest label (French labels run longer than English ones). */
function menuWidth(items: MenuItem[], min: number): number {
  const longest = items.reduce((n, item) => Math.max(n, item.label.length), 0);
  return Math.min(340, Math.max(min, Math.round(longest * 6.4) + 62));
}

function MenuList(props: { items: MenuItem[]; onClose: () => void; style: CSSProperties; listRef?: React.RefObject<HTMLDivElement | null> }) {
  const { items, onClose, style, listRef } = props;
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [subStyle, setSubStyle] = useState<CSSProperties>({});
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const openSubmenu = (item: MenuItem) => {
    const row = rowRefs.current.get(item.id);
    if (!row || !item.submenu) return;
    const r = row.getBoundingClientRect();
    const width = menuWidth(item.submenu, 190);
    const height = item.submenu.length * 30 + 12;
    const left = r.right + width + 4 > window.innerWidth ? r.left - width - 4 : r.right + 4;
    const top = Math.min(Math.max(8, r.top - 6), window.innerHeight - height - 8);
    setSubStyle({ left, top, width });
    setOpenSub(item.id);
  };

  return (
    <>
      <div
        ref={listRef}
        role="menu"
        className="lb-menu lb-pop fixed z-[100] py-1.5"
        style={{ ...style, color: "var(--lb-text)" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item) => (
          <div key={item.id}>
            {item.separatorBefore && <div className="mx-2 my-1 h-px" style={{ background: "var(--lb-track)" }} />}
            <button
              ref={(el) => {
                if (el) rowRefs.current.set(item.id, el);
              }}
              role="menuitem"
              disabled={item.disabled}
              className="mx-1.5 flex h-[28px] w-[calc(100%-12px)] items-center gap-2 rounded-[calc(var(--lb-menu-radius)-6px)] border-none bg-transparent px-2 text-left"
              style={{
                color: item.danger ? "var(--lb-red)" : item.disabled ? "var(--lb-faint)" : "inherit",
                background: openSub === item.id ? "var(--lb-card-hover)" : undefined,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--lb-card-hover)";
                if (item.submenu) openSubmenu(item);
                else setOpenSub(null);
              }}
              onMouseLeave={(e) => {
                if (openSub !== item.id) (e.currentTarget as HTMLButtonElement).style.background = "";
              }}
              onClick={() => {
                if (item.submenu) return openSubmenu(item);
                item.onSelect?.();
                onClose();
              }}
            >
              <span className="flex w-4 shrink-0 justify-center">
                {item.checked ? <Check size={13} /> : item.icon ? <item.icon size={14} className="opacity-80" /> : null}
              </span>
              <span className="flex-1 truncate" title={item.label}>{item.label}</span>
              {item.submenu && <ChevronRight size={13} className="opacity-60" />}
            </button>
          </div>
        ))}
      </div>
      {openSub && (
        <MenuList
          items={items.find((i) => i.id === openSub)?.submenu ?? []}
          onClose={onClose}
          style={subStyle}
        />
      )}
    </>
  );
}

export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void; preferUp: boolean }) {
  const { x, y, items, onClose, preferUp } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const width = menuWidth(items, 230);
  const [style, setStyle] = useState<CSSProperties>({ left: x, top: y, width, visibility: "hidden" });
  useCapture(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = width;
    const left = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    const top = preferUp ? Math.max(8, y - h - 4) : Math.min(window.innerHeight - h - 8, y + 4);
    setStyle({ left, top, width: w });
  }, [x, y, preferUp, items, width]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onBlur = () => onClose();
    // Defer so the opening right-click doesn't immediately close the menu.
    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("contextmenu", onDown as unknown as EventListener, true);
    }, 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("contextmenu", onDown as unknown as EventListener, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  // Portaled: a transformed / backdrop-filtered ancestor (dock slot, launcher popover) would make `fixed` relative to it.
  return createPortal(<MenuList items={items} onClose={onClose} style={style} listRef={ref} />, document.body);
}
