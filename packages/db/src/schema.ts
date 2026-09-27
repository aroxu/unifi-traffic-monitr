import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const t = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytes = (name: string) => bigint(name, { mode: 'bigint' });

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  unifiId: text('unifi_id').notNull().unique(),
  internalName: text('internal_name').notNull(),
  label: text('label').notNull(),
  createdAt: t('created_at').notNull().defaultNow(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiId: text('unifi_id').notNull(),
  name: text('name'), model: text('model'), type: text('type'),
  online: boolean('online'), lastSeenAt: t('last_seen_at'),
}, (table) => [uniqueIndex('devices_site_unifi_key').on(table.siteId, table.unifiId)]);

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  mac: text('mac').notNull(), unifiId: text('unifi_id'),
  name: text('name'), ip: text('ip'), connection: text('connection'),
  deviceId: uuid('device_id').references(() => devices.id),
  online: boolean('online'), lastSeenAt: t('last_seen_at'),
  wirelessSignalDbm: integer('wireless_signal_dbm'),
  wirelessNoiseDbm: integer('wireless_noise_dbm'),
  wirelessObservedAt: t('wireless_observed_at'),
  updatedAt: t('updated_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('clients_site_mac_key').on(table.siteId, table.mac), index('clients_updated_idx').on(table.updatedAt)]);

export const collectorRuns = pgTable('collector_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  startedAt: t('started_at').notNull(), finishedAt: t('finished_at'),
  status: text('status').notNull(), errorCode: text('error_code'),
  clientCount: integer('client_count'),
}, (table) => [index('collector_runs_site_time_idx').on(table.siteId, table.startedAt)]);

export const collectorCheckpoints = pgTable('collector_checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  source: text('source').notNull(), scope: text('scope').notNull(), direction: text('direction').notNull(),
  sessionKey: text('session_key'), value: bytes('value').notNull(), observedAt: t('observed_at').notNull(),
}, (table) => [uniqueIndex('checkpoints_client_source_direction_key').on(table.clientId, table.source, table.scope, table.direction)]);

export const clientSamples = pgTable('client_samples', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  runId: uuid('run_id').notNull().references(() => collectorRuns.id),
  source: text('source').notNull(), scope: text('scope').notNull(), direction: text('direction').notNull(),
  sessionKey: text('session_key'), counterBytes: bytes('counter_bytes').notNull(),
  observedAt: t('observed_at'), collectedAt: t('collected_at').notNull(), quality: text('quality').notNull(),
  rollupApplied: boolean('rollup_applied').notNull().default(false),
}, (table) => [uniqueIndex('samples_run_client_source_direction_key').on(table.runId, table.clientId, table.source, table.direction), index('samples_client_time_idx').on(table.clientId, table.collectedAt), index('samples_collected_idx').on(table.collectedAt), index('samples_rollup_pending_idx').on(table.siteId, table.rollupApplied, table.collectedAt)]);

export const trafficIntervals = pgTable('traffic_intervals', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  sampleId: uuid('sample_id').notNull().unique().references(() => clientSamples.id),
  source: text('source').notNull(), scope: text('scope').notNull(), direction: text('direction').notNull(),
  startAt: t('start_at').notNull(), endAt: t('end_at').notNull(), bytes: bytes('bytes').notNull(),
  estimated: boolean('estimated').notNull().default(false),
  rollupApplied: boolean('rollup_applied').notNull().default(false),
}, (table) => [index('intervals_client_time_idx').on(table.clientId, table.endAt), index('intervals_rollup_pending_idx').on(table.siteId, table.rollupApplied, table.endAt)]);

export const trafficRollups = pgTable('traffic_rollups', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  scope: text('scope').notNull(), direction: text('direction').notNull(),
  resolution: text('resolution').notNull(), bucketStart: t('bucket_start').notNull(),
  bytes: bytes('bytes').notNull(), observedSeconds: integer('observed_seconds').notNull(),
  gapCount: integer('gap_count').notNull(), resetCount: integer('reset_count').notNull(),
  estimated: boolean('estimated').notNull().default(false),
}, (table) => [uniqueIndex('rollups_client_bucket_key').on(table.clientId, table.scope, table.direction, table.resolution, table.bucketStart),
  index('rollups_scope_resolution_time_idx').on(table.scope, table.resolution, table.bucketStart)]);

export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  timezone: text('timezone').notNull().default('Asia/Seoul'),
  rawRetentionDays: integer('raw_retention_days').notNull().default(7),
  fiveMinuteRetentionDays: integer('five_minute_retention_days').notNull().default(90),
  hourlyRetentionDays: integer('hourly_retention_days').notNull().default(365),
  updatedAt: t('updated_at').notNull().defaultNow(),
});
