export type TargetKind = "local" | "network" | "cloud";
export type JobKind = "video" | "audio" | "image";

export interface SystemSettings {
  saveDir: string;
  copyOnComplete: boolean;
  openOnComplete: boolean;
  autoOpenBrowser: boolean;
  confirmGenerate: boolean;
  filenamePattern: string;
  uiPort: number;
}

export interface MachineSsh {
  host: string;
  port: number;
  username: string;
  password: string;
  connectionType: "ssh";
}

export interface MachineCloud {
  provider: "custom";
  url: string;
  apiKey: string;
}

export interface Machine {
  id: string;
  name: string;
  enabled: boolean;
  preferred: boolean;
  type: TargetKind;
  workerPort: number;
  ssh: MachineSsh;
  cloud: MachineCloud;
  priority: number;
}

export interface StudioConfig {
  machines: Machine[];
  preferredMachineId: string;
  target: TargetKind;
  workerUrl: string;
  workerPort: number;
  system: SystemSettings;
  ssh: MachineSsh;
  cloud: MachineCloud;
  models: {
    video: string;
    audio: string;
    image: string;
  };
}

export interface PublicMachine {
  id: string;
  name: string;
  enabled: boolean;
  preferred: boolean;
  type: TargetKind;
  workerPort: number;
  workerUrl: string;
  ssh: {
    host: string;
    port: number;
    username: string;
    passwordSet: boolean;
    connectionType: "ssh";
  };
  cloud: {
    provider: "custom";
    url: string;
    apiKeySet: boolean;
  };
  priority: number;
}

export interface PublicConfig {
  machines: PublicMachine[];
  preferredMachineId: string;
  target: TargetKind;
  workerUrl: string;
  workerPort: number;
  ssh: PublicMachine["ssh"];
  cloud: PublicMachine["cloud"];
  models: {
    video: string;
    audio: string;
    image: string;
  };
  system: SystemSettings;
}
