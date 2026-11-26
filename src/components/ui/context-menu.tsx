import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { getDesktopTitlebarInset } from "../../services/apiBase";

export interface ContextMenuAnchor {
  x: number;
  y: number;
  trigger: HTMLElement;
}

/** Mouse and keyboard invocations share the same positioning and focus owner. */
export function contextMenuAnchor(event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>): ContextMenuAnchor | null {
  const keyboard = "key" in event;
  if (keyboard && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return null;
  event.preventDefault();
  event.stopPropagation();
  const trigger = event.currentTarget;
  const bounds = trigger.getBoundingClientRect();
  const useTrigger = keyboard || (event.clientX === 0 && event.clientY === 0);
  return {
    x: useTrigger ? bounds.left + 8 : event.clientX,
    y: useTrigger ? bounds.bottom : event.clientY,
    trigger,
  };
}

interface ContextMenuContextValue {
  registerSubmenu: (el: HTMLElement) => () => void;
  closeMenu: (restoreFocus: boolean) => void;
  subscribeSiblingHover: (listener: (hoveredTrigger: Element | null) => void) => () => void;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

interface ContextMenuProps {
  anchor: ContextMenuAnchor;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function ContextMenu({ anchor, label, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenusRef = useRef<Set<HTMLElement>>(new Set());
  const siblingHoverListenersRef = useRef<Set<(hoveredTrigger: Element | null) => void>>(new Set());
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const close = useStableCallback((restoreFocus: boolean) => {
    if (restoreFocus && anchor.trigger.isConnected) anchor.trigger.focus({ preventScroll: true });
    onClose();
  });

  const registerSubmenu = useCallback((el: HTMLElement) => {
    submenusRef.current.add(el);
    return () => {
      submenusRef.current.delete(el);
    };
  }, []);

  const subscribeSiblingHover = useCallback((listener: (hoveredTrigger: Element | null) => void) => {
    siblingHoverListenersRef.current.add(listener);
    return () => {
      siblingHoverListenersRef.current.delete(listener);
    };
  }, []);

  const contextValue = useMemo<ContextMenuContextValue>(() => ({
    registerSubmenu,
    closeMenu: close,
    subscribeSiblingHover,
  }), [close, registerSubmenu, subscribeSiblingHover]);

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    const place = () => {
      // Measure the layout box, not the scaled entrance animation. Labels and
      // font sizes can make the menu wider than its minimum width.
      const minTop = getDesktopTitlebarInset() + 8;
      setPosition({
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - menu.offsetWidth - 8)),
        top: Math.max(minTop, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - 8)),
      });
    };
    place();
    menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [anchor]);

  useLayoutEffect(() => {
    const containsTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      if (menuRef.current?.contains(target)) return true;
      for (const submenu of submenusRef.current) {
        if (submenu.contains(target)) return true;
      }
      return false;
    };
    const outside = (event: Event) => {
      if (!containsTarget(event.target)) close(true);
    };
    const replaced = (event: Event) => {
      if (!containsTarget(event.target)) close(false);
    };
    const resized = () => close(true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", outside, true);
    // Capture before another menu stops propagation, so only one stays open.
    window.addEventListener("contextmenu", replaced, true);
    window.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("contextmenu", replaced, true);
      window.removeEventListener("resize", resized);
    };
  }, [close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      // Tab resumes normal navigation from the invoking card, not the portal
      // at the end of the document. Escape stays on the card.
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(menuRef.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"))
      .filter(item => item.closest("[role=menu]") === menuRef.current);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <ContextMenuContext.Provider value={contextValue}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        className="context-menu keyboard-context-menu"
        style={position}
        onKeyDown={onKeyDown}
        onPointerOver={event => {
          const item = event.target instanceof Element ? event.target.closest("[role=menuitem]") : null;
          if (item && item.closest("[role=menu]") === menuRef.current) {
            for (const listener of siblingHoverListenersRef.current) listener(item);
          }
        }}
        onContextMenu={event => {
          // The Menu key can emit a native contextmenu on keyup after focus has
          // already moved here. Keep it from replacing this menu.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={event => {
          event.stopPropagation();
          const item = event.target instanceof Element ? event.target.closest("[role=menuitem]:not(:disabled)") : null;
          if (item && item.getAttribute("data-keep-menu-open") !== "true") close(true);
        }}
      >
        {children}
      </div>
    </ContextMenuContext.Provider>,
    document.body,
  );
}

interface ContextMenuSubmenuProps {
  label: string;
  triggerContent: React.ReactNode;
  disabled?: boolean;
  onTriggerClick?: () => void;
  children: React.ReactNode;
}

export function ContextMenuSubmenu({
  label,
  triggerContent,
  disabled = false,
  onTriggerClick,
  children,
}: ContextMenuSubmenuProps) {
  const ctx = useContext(ContextMenuContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const focusFirstOnOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 140);
  }, [clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribeSiblingHover((hoveredItem) => {
      if (hoveredItem && hoveredItem !== triggerRef.current) {
        clearCloseTimer();
        setOpen(false);
      }
    });
  }, [clearCloseTimer, ctx]);

  useLayoutEffect(() => {
    if (!open || disabled) return;
    const trigger = triggerRef.current;
    const submenu = submenuRef.current;
    if (!trigger || !submenu) return;

    const unregister = ctx?.registerSubmenu(submenu);
    const place = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const width = submenu.offsetWidth;
      const height = submenu.offsetHeight;
      const minTop = getDesktopTitlebarInset() + 8;
      const rightLeft = triggerRect.right + 4;
      const fitsRight = rightLeft + width + 8 <= window.innerWidth;
      const left = fitsRight
        ? rightLeft
        : Math.max(8, triggerRect.left - width - 4);
      const top = Math.max(minTop, Math.min(triggerRect.top - 4, window.innerHeight - height - 8));
      setPosition({ left, top });
    };
    place();
    if (focusFirstOnOpenRef.current) {
      focusFirstOnOpenRef.current = false;
      submenu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
    }
    const observer = new ResizeObserver(place);
    observer.observe(submenu);
    return () => {
      observer.disconnect();
      unregister?.();
    };
  }, [ctx, disabled, open]);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowRight" || (!onTriggerClick && (event.key === "Enter" || event.key === " "))) {
      event.preventDefault();
      event.stopPropagation();
      clearCloseTimer();
      focusFirstOnOpenRef.current = true;
      setOpen(true);
    }
  };

  const handleSubmenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      clearCloseTimer();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") {
      event.stopPropagation();
      ctx?.closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(submenuRef.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        data-submenu-open={open && !disabled ? "true" : undefined}
        data-keep-menu-open={onTriggerClick ? undefined : "true"}
        className="context-menu-item context-menu-submenu-trigger"
        onPointerEnter={() => {
          if (disabled) return;
          clearCloseTimer();
          setOpen(true);
        }}
        onPointerLeave={scheduleClose}
        onKeyDown={handleTriggerKeyDown}
        onClick={(event) => {
          if (disabled) return;
          if (onTriggerClick) {
            onTriggerClick();
          } else {
            event.stopPropagation();
            clearCloseTimer();
            focusFirstOnOpenRef.current = true;
            setOpen(true);
          }
        }}
      >
        <span className="context-menu-submenu-label">{triggerContent}</span>
        <ChevronRight size={13} className="context-menu-submenu-chevron" aria-hidden="true" />
      </button>

      {open && !disabled && createPortal(
        <div
          ref={submenuRef}
          role="menu"
          aria-label={label}
          className="context-menu keyboard-context-menu context-menu-submenu"
          style={position}
          onPointerEnter={clearCloseTimer}
          onPointerLeave={scheduleClose}
          onKeyDown={handleSubmenuKeyDown}
          onContextMenu={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={event => {
            event.stopPropagation();
            if (event.target instanceof Element && event.target.closest("[role=menuitem]:not(:disabled)")) {
              ctx?.closeMenu(true);
            }
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
