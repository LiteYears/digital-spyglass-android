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
      snapPoints={full ? [1] : [0.25, 0.5, 0.85]}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-background/80" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex h-[92vh] flex-col border-t border-border-active bg-panel outline-none"
          aria-describedby={undefined}
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-active" />
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <Drawer.Title className="font-mono text-xs uppercase tracking-widest text-amber">
              {title}
            </Drawer.Title>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 safe-bottom">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
