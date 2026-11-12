/**
 * Bottom sheet with 25/50/85% snap points. Overlays never push a route, so the
 * Android back button dismisses the sheet instead of closing the app.
 */
import type { ReactNode } from "react";
import { Drawer } from "vaul";

export function SheetPanel({
  open,
  onOpenChange,
  title,
  children,
  full = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={full ? [0.85] : [0.35, 0.65]}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-background/70 backdrop-blur-xs" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[72vh] flex-col rounded-t-xl border-t border-border-active bg-panel shadow-2xl outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border-active" />
          <div className="flex items-center justify-between border-b border-border-subtle px-3.5 py-2.5">
            <Drawer.Title className="font-mono text-xs uppercase tracking-widest text-amber">
              {title}
            </Drawer.Title>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-3.5 py-3 safe-bottom touch-pan-y">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
