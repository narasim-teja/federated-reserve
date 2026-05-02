'use client';

import {
  Activity,
  Anchor,
  Cloud,
  Handshake,
  Landmark,
  Radio,
  Sparkles,
  Star,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { CheckboxRow } from '@/components/ui/checkbox-row';
import { Separator } from '@/components/ui/separator';
import { LAYERS, type LayerDef, useLayers } from '@/hooks/use-layers';

const ICON: Record<LayerDef['icon'], React.ReactNode> = {
  pulse: <Activity className="h-3.5 w-3.5" />,
  bank: <Landmark className="h-3.5 w-3.5" />,
  radio: <Radio className="h-3.5 w-3.5" />,
  wallet: <Wallet className="h-3.5 w-3.5" />,
  storm: <Cloud className="h-3.5 w-3.5" />,
  handshake: <Handshake className="h-3.5 w-3.5" />,
  star: <Star className="h-3.5 w-3.5" />,
};

const ACCENT: Record<LayerDef['icon'], 'cyan' | 'violet' | 'amber' | 'emerald' | 'red' | 'rose'> = {
  pulse: 'cyan',
  bank: 'violet',
  radio: 'amber',
  wallet: 'emerald',
  storm: 'rose',
  handshake: 'cyan',
  star: 'violet',
};

const ASSET_GROUPS = [
  { label: 'On-chain', items: ['UNICHAIN', '0G TESTNET', 'BOND AUCTIONS'] },
  { label: 'Data plane', items: ['BLS · BEA · CENSUS', 'FRED RATES', 'NOAA STORMS'] },
];

export function LeftRail() {
  const { layers, toggle } = useLayers();
  const [expanded, setExpanded] = useState(true);
  return (
    <aside className="flex h-full w-[238px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-fg)]">
            Mesh Situation
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
        >
          {expanded ? '−' : '+'}
        </button>
      </div>

      {expanded && (
        <div className="flex-1 overflow-y-auto p-2">
          <nav className="flex flex-col gap-0.5">
            {LAYERS.map((def) => (
              <CheckboxRow
                key={def.key}
                checked={layers[def.key]}
                onChange={() => toggle(def.key)}
                icon={ICON[def.icon]}
                label={def.label}
                hint={def.hint}
                accent={ACCENT[def.icon]}
              />
            ))}
          </nav>

          <Separator className="my-3" />

          <div className="px-2">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)] mb-2">
              Connected sources
            </div>
            <div className="flex flex-col gap-2">
              {ASSET_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)] mb-1">
                    {group.label}
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {group.items.map((item) => (
                      <li
                        key={item}
                        className="flex items-center gap-2 font-mono text-[10px] text-[var(--color-fg-subtle)]"
                      >
                        <Anchor className="h-3 w-3 text-[var(--color-fg-subtle)]/60" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </aside>
  );
}
