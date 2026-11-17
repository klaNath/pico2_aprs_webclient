// Known settings items (ble-protocol.md §9.1). Shared by the mock device, and later the settings UI.

import type { SchemaItem } from "./types.ts";

export const MICE_MESSAGES = [
  "Off Duty",
  "En Route",
  "In Service",
  "Returning",
  "Committed",
  "Special",
  "Priority",
] as const; // 7 (Emergency) cannot be set from the app

export const KNOWN_SETTINGS: readonly SchemaItem[] = [
  {
    key: "callsign",
    desc: "Own callsign without SSID (null = not set, never transmit)",
    type: "str",
    nullable: true,
    pattern: "^[A-Z0-9]{3,6}$",
  },
  { key: "ssid", desc: "SSID", type: "int", min: 0, max: 15 },
  { key: "symbol", desc: "Symbol table and code (2 chars)", type: "str", len: 2 },
  { key: "path", desc: "Digipeater path", type: "list", max_items: 2 },
  { key: "comment", desc: "Beacon comment", type: "str", max_len: 40 },
  { key: "mice_message", desc: "Mic-E message (0-6)", type: "int", min: 0, max: 6 },
  {
    key: "beacon_moving_s",
    desc: "Beacon interval while moving (s)",
    type: "int",
    min: 30,
    max: 3600,
  },
  {
    key: "beacon_still_s",
    desc: "Beacon interval while still (s)",
    type: "int",
    min: 60,
    max: 7200,
  },
  {
    key: "beacon_move_m",
    desc: "Distance counted as moving (m)",
    type: "float",
    min: 1,
    max: 1000,
  },
  {
    key: "tx_enabled",
    desc: "Transmit permission (the beacon switch must also be on)",
    type: "bool",
  },
  { key: "fx25_tx", desc: "Transmit with FX.25", type: "bool" },
];
