'use client';

import { CommandPalette } from '@/components/dashboard/command-palette';
import { LeftRail } from '@/components/dashboard/left-rail';
import { MobileGate } from '@/components/dashboard/mobile-gate';
import { ModeTabs } from '@/components/dashboard/mode-tabs';
import { Topbar } from '@/components/dashboard/topbar';
import { useCommandPalette } from '@/hooks/use-command-palette';
import { LayerProvider } from '@/hooks/use-layers';
import { ObserverProvider, useObserverContext } from '@/hooks/use-observer-context';
import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <LayerProvider>
      <ObserverProvider>
        <Shell>{children}</Shell>
      </ObserverProvider>
    </LayerProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { snapshot, connection } = useObserverContext();
  const palette = useCommandPalette();
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Topbar
        snapshot={snapshot}
        connection={connection}
        onOpenPalette={() => palette.setOpen(true)}
      />
      <ModeTabs />
      <div className="flex flex-1 min-h-0">
        <LeftRail />
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
      </div>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
      <MobileGate />
    </div>
  );
}
