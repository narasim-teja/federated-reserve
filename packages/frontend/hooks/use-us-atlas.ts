'use client';

import { geoPath } from 'd3-geo';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { feature, mesh } from 'topojson-client';
import { useEffect, useMemo, useState } from 'react';

const ATLAS_URL = '/data/us-states.json';

export interface UsAtlasFeature {
  /** State FIPS code as a string from the topojson `id` field. */
  id: string;
  fips: number;
  name: string;
  d: string;
  centroid: [number, number];
}

export interface UsAtlas {
  /** Outline of the contiguous US (Albers USA pre-projected). */
  borderD: string;
  /** Per-state SVG path data + name + centroid. */
  states: UsAtlasFeature[];
  /** Native viewBox that matches us-atlas Albers projection. */
  viewBox: string;
}

interface AtlasState {
  data: UsAtlas | null;
  error: string | null;
}

let cached: Promise<UsAtlas> | null = null;

async function loadAtlas(): Promise<UsAtlas> {
  if (cached) return cached;
  cached = (async () => {
    const res = await fetch(ATLAS_URL);
    if (!res.ok) throw new Error(`Failed to load us-atlas: ${res.status}`);
    const topology = (await res.json()) as Topology;
    const path = geoPath();
    const statesGeo = feature(
      topology,
      topology.objects.states as GeometryCollection,
    ) as unknown as { features: Array<{ id: string; properties: { name: string }; geometry: unknown }> };
    const borderMesh = mesh(topology, topology.objects.nation as GeometryCollection);
    const states: UsAtlasFeature[] = statesGeo.features.map((f) => {
      const d = path(f as never) ?? '';
      const c = path.centroid(f as never);
      return {
        id: String(f.id),
        fips: Number(f.id),
        name: f.properties.name,
        d,
        centroid: [c[0], c[1]],
      };
    });
    return {
      borderD: path(borderMesh as never) ?? '',
      states,
      viewBox: '0 0 975 610',
    };
  })();
  return cached;
}

export function useUsAtlas(): AtlasState {
  const [state, setState] = useState<AtlasState>({ data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    loadAtlas()
      .then((atlas) => {
        if (!cancelled) setState({ data: atlas, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ data: null, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function useStateLookup(atlas: UsAtlas | null): Map<number, UsAtlasFeature> {
  return useMemo(() => {
    const m = new Map<number, UsAtlasFeature>();
    if (!atlas) return m;
    for (const f of atlas.states) m.set(f.fips, f);
    return m;
  }, [atlas]);
}
