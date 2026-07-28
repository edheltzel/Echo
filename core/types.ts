export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

export interface NotifyPayload {
  message: string;
  title?: string;
  voice_enabled?: boolean;
  voice_id?: string;
  voice_name?: string;
  voice_settings?: VoiceSettings;
  session_id?: string;
  source?: string;
  /** Set only after an adapter has completed native visual delivery. */
  visual_delivery?: "native";
}

export interface NotifyResult {
  ok: boolean;
  status: number;
  body: string;
  requestId?: string;
}

export interface HostAdapterInfo {
  name: string;
  description: string;
  source: string;
}
