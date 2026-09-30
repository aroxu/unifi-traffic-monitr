'use client';

import {useSyncExternalStore} from 'react';

// [clientId, internet up, internet down, LAN up, LAN down] in bytes per second.
export type LiveRow = [string, number, number, number, number];
export type LivePair = {up: number; down: number};
export type LiveFrame = {at: number; intervalMs: number; totals: {internet: LivePair; lan: LivePair}; clients: LiveRow[]; omitted: number};
export type LiveStatus = 'waiting' | 'live' | 'stale' | 'disconnected';
export type LiveState = {status: LiveStatus; frames: LiveFrame[]; receivedAt: number};

export const liveWindowMs = 60000;
// Frames are kept longer than the chart window so today's usage can add the
// bytes that arrived after the last stored bucket update.
const historyMs = 180000;
const staleAfterMs = 5000;

let state: LiveState = {status: 'waiting', frames: [], receivedAt: 0};
const serverState: LiveState = {status: 'waiting', frames: [], receivedAt: 0};
const listeners = new Set<() => void>();

function update(next: LiveState) {
  state = next;
  for (const listener of listeners) listener();
}

const isPair = (v: unknown): v is LivePair => typeof v === 'object' && v !== null &&
  Number.isFinite((v as LivePair).up) && Number.isFinite((v as LivePair).down);

/** Accept one SSE live payload from the collector relay. */
export function pushLive(raw: string) {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return; }
  if (typeof data !== 'object' || data === null) return;
  const message = data as Record<string, unknown>;
  const now = Date.now();
  if (message.state === 'disconnected') {
    update({...state, status: 'disconnected', receivedAt: now});
    return;
  }
  const totals = message.totals as LiveFrame['totals'] | undefined;
  const at = Date.parse(String(message.at));
  if (message.state !== 'live' || !Number.isFinite(at) || !totals || !isPair(totals.internet) || !isPair(totals.lan) ||
      !Array.isArray(message.clients)) return;
  const clients = (message.clients as unknown[]).filter((row): row is LiveRow => Array.isArray(row) && row.length === 5 &&
    typeof row[0] === 'string' && row.slice(1).every(value => Number.isFinite(value)));
  const frame: LiveFrame = {at, intervalMs: Number(message.intervalMs) || 1000, totals, clients,
    omitted: Number(message.omitted) || 0};
  const frames = [...state.frames.filter(item => item.at > at - historyMs && item.at < at), frame];
  update({status: 'live', frames, receivedAt: now});
}

/** Mark the stream stale when frames stop arriving. */
export function checkLiveStale(now = Date.now()) {
  if (state.status === 'live' && now - state.receivedAt > staleAfterMs) update({...state, status: 'stale'});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLive(): LiveState {
  return useSyncExternalStore(subscribe, () => state, () => serverState);
}
