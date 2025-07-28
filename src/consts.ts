export const PMD_SERVICE_ID = "fb005c80-02e7-f387-1cad-8acd2d8df0c8";
export const PMD_CTRL_CHAR = "fb005c81-02e7-f387-1cad-8acd2d8df0c8";
export const PMD_DATA_CHAR = "fb005c82-02e7-f387-1cad-8acd2d8df0c8";

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
