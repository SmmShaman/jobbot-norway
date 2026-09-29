import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

const EDGE = 8; // min gap between the tooltip and the screen edge, px

// "?" icon with a tooltip. Opens on hover (mouse) or tap (touch). The tooltip is rendered
// into <body> with fixed positioning and clamped to the viewport, so it can never hang off
// the side of a phone screen or widen the page.
export const HelpTip: React.FC<{ text: string }> = ({ text }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !tipRef.current) { setPos(null); return; }
    const icon = rootRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const center = icon.left + icon.width / 2;
    const left = Math.min(Math.max(center - tip.width / 2, EDGE), vw - EDGE - tip.width);
    // Above the icon; below it when there is no room at the top.
    const above = icon.top - tip.height - 8;
    setPos({ left, top: above >= EDGE ? above : icon.bottom + 8 });
  }, [open, text]);

  // Close on a tap/click outside, and on scroll (a fixed tooltip would drift from its icon).
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className="relative inline-flex items-center"
      // Hover only for a real mouse: a tap emits emulated mouseenter/mouseleave that would
      // close the tooltip right after opening it. Touch opens on tap, closes on a tap outside.
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOpen(false); }}
      onClick={(e) => { e.stopPropagation(); setOpen(true); }}
    >
      <HelpCircle size={14} className="text-slate-400 hover:text-blue-500 cursor-help transition-colors" />
      {open && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed px-3 py-2 text-xs text-white bg-slate-800 rounded-lg shadow-lg z-[2000] w-max max-w-[min(20rem,calc(100vw-1rem))] text-center pointer-events-none"
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
};
