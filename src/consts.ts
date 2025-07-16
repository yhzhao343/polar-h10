export const PMD_SERVICE_ID = "fb005c80-02e7-f387-1cad-8acd2d8df0c8";
export const PMD_CTRL_CHAR = "fb005c81-02e7-f387-1cad-8acd2d8df0c8";
export const PMD_DATA_CHAR = "fb005c82-02e7-f387-1cad-8acd2d8df0c8";
export enum PolarSensorType {
  ECG = 0,
  PPG = 1,
  ACC = 2,
  PPI = 3,
  GYRO = 5,
  MAGNETOMETER = 6,
  SDK_MODE = 9,
  LOCATION = 10,
  PRESSURE = 11,
  TEMPERATURE = 12,
}

export interface DataHandlerDict {
  [key: (typeof PolarSensorNames)[number]]: ((data: PolarH10Data) => void)[];
}

export interface PolarH10Data {
  type: (typeof PolarSensorNames)[number];
  samples?: Int16Array | Int32Array;
  sample_timestamp_ms: number;
  prev_sample_timestamp_ms: number;
  recv_epoch_time_ms: number;
  event_time_offset_ms: number;
}

export enum PolarSettingType {
  SAMPLE_RATE = 0,
  RESOLUTION = 1,
  RANGE_PN_UNIT = 2,
  RANGE_MILI_UNIT = 3,
  NUM_CHANNELS = 4,
  CONVERSION_FACTOR = 5,
}

function parseUint16(
  d: DataView,
  offset: number,
  little_endian: boolean = true,
) {
  return d.getUint16(offset, little_endian);
}

function parseFloat32(
  d: DataView,
  offset: number,
  little_endian: boolean = true,
) {
  return d.getFloat32(offset, little_endian);
}

function parse4xUint16(
  d: DataView,
  offset: number,
  little_endian: boolean = true,
) {
  return [
    d.getUint16(offset, little_endian),
    d.getUint16(offset + 2, little_endian),
    d.getUint16(offset + 4, little_endian),
    d.getUint16(offset + 6, little_endian),
  ];
}

export const setting_parsers = {
  SAMPLE_RATE: parseUint16,
  RESOLUTION: parseUint16,
  RANGE_PN_UNIT: parseUint16,
  RANGE_MILI_UNIT: parse4xUint16,
  CONVERSION_FACTOR: parseFloat32,
};

interface SettingOffset {
  [key: string]: number;
}

export const setting_parser_offsets: SettingOffset = {
  SAMPLE_RATE: 2,
  RESOLUTION: 2,
  RANGE_PN_UNIT: 2,
  RANGE_MILI_UNIT: 8,
  NUM_CHANNELS: 1,
  CONVERSION_FACTOR: 4,
};

export enum PolarPMDCommand {
  GET_MEASUREMENT_SETTINGS = 0x01,
  REQUEST_MEASUREMENT_START = 0x02,
  REQUEST_MEASUREMENT_STOP = 0x03,
}

export const PolarSettingNames = Object.keys(PolarSettingType).filter((t) =>
  isNaN(Number(t)),
);

export const PolarSensorNames = Object.keys(PolarSensorType).filter((t) =>
  isNaN(Number(t)),
);

export const PolarPMDCommandNames = Object.keys(PolarPMDCommand).filter((t) =>
  isNaN(Number(t)),
);

type PolarSettingNameKeys = (typeof PolarSettingNames)[number];

export interface PolarSensorInfo {
  type: (typeof PolarPMDCommandNames)[number];
  error: (typeof ERROR_MSGS)[number];
  more_frames: number;
  settings: Record<PolarSettingNameKeys, number[] | number[][]>;
}

export interface PMDCtrlReply {
  type: (typeof PolarPMDCommandNames)[number];
  sensor: (typeof PolarSensorNames)[number];
  error: (typeof ERROR_MSGS)[number];
  more_frames: number;
  reserved?: number;
}

export const ERROR_MSGS = [
  "SUCCESS",
  "INVALID OP CODE",
  "INVALID MEASUREMENT TYPE",
  "NOT SUPPORTED",
  "INVALID LENGTH",
  "INVALID PARAMETER",
  "ALREADY IN STATE",
  "INVALID RESOLUTION",
  "INVALID SAMPLE RATE",
  "INVALID RANGE",
  "INVALID MTU",
  "INVALID NUMBER OF CHANNELS",
  "INVALID STATE",
  "DEVICE IN CHARGER",
];
