export type ScanResult = {
  device_id: string;
  serial_verified: boolean;
  product: string;
  model: string;
  board: string;
  hardware: string;
  build_fingerprint: string;
  build_incremental: string;
  android_api_level: number;
  vendor_api_level: number;
  battery_percent: number;
  charging: boolean;
  usb_stable: boolean;
  host_bytes_available: number;
  recovery_capable: boolean;
  system_partition_bytes: number;
};
export type Journal = { stage: string; device_id: string; updated_at: string; resume_stage?: string; events: Array<{ stage: string; at: string; detail: string }> };
