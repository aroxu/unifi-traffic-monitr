/** A counter from another uplink is a new observation even if association time is unchanged. */
export function counterSessionKey(association: string | null, deviceMac: string | null): string | null {
  return deviceMac ? JSON.stringify([association, deviceMac]) : association;
}
