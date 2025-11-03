import {
  PolarPMDCommand,
  setting_parsers,
  setting_parser_offsets,
  PolarSettingType,
  ERROR_MSGS,
} from "./consts";

export const PMD_SERVICE_ID = "fb005c80-02e7-f387-1cad-8acd2d8df0c8";
export const PMD_CTRL_CHAR = "fb005c81-02e7-f387-1cad-8acd2d8df0c8";
export const PMD_DATA_CHAR = "fb005c82-02e7-f387-1cad-8acd2d8df0c8";

export const HEART_RATE_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"; // or '0x180D'
export const HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID =
  "00002a37-0000-1000-8000-00805f9b34fb"; // or '0x2A37'

export const SERVICES = [
  PMD_SERVICE_ID,
  HEART_RATE_SERVICE_UUID,
  "battery_service",
];

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

export type PolarSensorHandlerFunc = (data: PolarH10Data) => void;
export type HeartRateHandlerFunc = (data: HeartRateInfo) => void;

export interface DataHandlerDict {
  [key: (typeof PolarSensorNames)[number]]: PolarSensorHandlerFunc[];
}

export interface PolarH10Data {
  type: (typeof PolarSensorNames)[number];
  samples?: Int16Array | Int32Array;
  sample_timestamp_ms: number;
  prev_sample_timestamp_ms: number;
  recv_epoch_time_ms: number;
  event_time_offset_ms: number;
}

export interface HeartRateInfo {
  heart_rate_bpm: number;
  rr_intervals_ms: number[];
  recv_epoch_time_ms: number;
}

export type HeartRateHandlers = HeartRateHandlerFunc[];

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

export class PolarH10 {
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer | undefined = undefined;
  PMDService: BluetoothRemoteGATTService | undefined = undefined;
  PMDCtrlChar: BluetoothRemoteGATTCharacteristic | undefined = undefined;
  PMDDataChar: BluetoothRemoteGATTCharacteristic | undefined = undefined;
  BattService: BluetoothRemoteGATTService | undefined = undefined;
  BattLvlChar: BluetoothRemoteGATTCharacteristic | undefined = undefined;
  HeartRateService: BluetoothRemoteGATTService | undefined = undefined;
  HeartRateChar: BluetoothRemoteGATTCharacteristic | undefined = undefined;
  streaming: boolean = false;
  verbose: boolean = true;
  dataHandleDict: DataHandlerDict = {};
  heartRateHandleList: HeartRateHandlers = [];
  timeOffset: bigint = BigInt(0);
  eventTimeOffset: number;
  lastECGTimestamp: number;
  lastACCTimestamp: number;
  ACCStarted: boolean = false;
  ECGStarted: boolean = false;

  constructor(device: BluetoothDevice, verbose: boolean = true) {
    this.device = device;
    this.verbose = verbose;
    this.lastECGTimestamp = 0;
    this.lastACCTimestamp = 0;
    this.ACCStarted = false;
    this.ECGStarted = false;
    for (let i = 0; i < PolarSensorNames.length; i++) {
      this.dataHandleDict[PolarSensorNames[i]] = [];
    }
  }

  addEventListener(
    type: (typeof PolarSensorNames)[number],
    handler: PolarSensorHandlerFunc,
  ) {
    if (!this.dataHandleDict[type].includes(handler)) {
      this.dataHandleDict[type].push(handler);
    }
  }

  addHeartRateEventListener(handler: HeartRateHandlerFunc) {
    if (!this.heartRateHandleList.includes(handler)) {
      this.heartRateHandleList.push(handler);
    }
  }

  removeEventListener(
    type: (typeof PolarSensorNames)[number],
    handler: PolarSensorHandlerFunc,
  ) {
    let index = this.dataHandleDict[type].indexOf(handler);
    if (index > -1) {
      this.dataHandleDict[type].splice(index, 1);
    }
    return index;
  }

  removeHeartRateEventListener(handler: HeartRateHandlerFunc) {
    let index = this.heartRateHandleList.indexOf(handler);
    if (index > -1) {
      this.heartRateHandleList.splice(index, 1);
    }
    return index;
  }

  clearEventListner(type: (typeof PolarSensorNames)[number]) {
    delete this.dataHandleDict[type];
    this.dataHandleDict[type] = [];
  }

  log(...o: any[]) {
    if (this.verbose) {
      console.log(...o);
    }
  }

  async init() {
    this.server = await this.device.gatt?.connect();
    this.log(`Connecting to ${this.device.name} GATT server...`);
    this.PMDService = await this.server?.getPrimaryService(PMD_SERVICE_ID);
    this.log(`  Got PMD Service`);
    this.PMDCtrlChar = await this.PMDService?.getCharacteristic(PMD_CTRL_CHAR);
    this.log(`    Got PMD control characteristic`);
    await this.PMDCtrlChar?.startNotifications();
    this.log(`    Start notification`);
    this.PMDDataChar = await this.PMDService?.getCharacteristic(PMD_DATA_CHAR);
    this.log(`    Got PMD data characteristic`);
    await this.PMDDataChar?.startNotifications();
    this.log(`    Start notification`);
    this.streaming = false;
    this.BattService = await this.server?.getPrimaryService("battery_service");
    this.log(`  Got battery Service`);
    this.BattLvlChar =
      await this.BattService?.getCharacteristic("battery_level");
    this.log(`    Got battery level characteristic`);

    this.HeartRateService = await this.server?.getPrimaryService(
      HEART_RATE_SERVICE_UUID,
    );
    this.log(`  Got heart rate Service`);
    this.HeartRateChar = await this.HeartRateService?.getCharacteristic(
      HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
    );
    // this.log(`  Got heart rate Characteristic`);
    // this.HeartRateChar?.startNotifications();
    // this.log(`    Start notification`);

    this.PMDDataChar?.addEventListener(
      "characteristicvaluechanged",
      this.PMDDataHandle.bind(this),
    );

    this.HeartRateChar?.addEventListener(
      "characteristicvaluechanged",
      this.HearRateHandle.bind(this),
    );
  }

  PMDCtrlCharHandle(event: any) {
    this.log(event);
  }

  PMDCtrlDataHandle(event: Event) {
    this.log(event);
  }

  async getBatteryLevel(): Promise<number> {
    let battRead = await this.BattLvlChar?.readValue();
    if (battRead) {
      return battRead.getUint8(0);
    } else {
      return 0;
    }
  }

  async getPMDFeatures(): Promise<typeof PolarSensorNames> {
    const PMEFeatures: DataView | undefined =
      await this.PMDCtrlChar?.readValue();
    const featureList: typeof PolarSensorNames = [];
    if (PMEFeatures !== undefined) {
      if (PMEFeatures.byteLength === 17) {
        if (PMEFeatures.getUint8(0) === 0xf) {
          const feature_num = PMEFeatures.getUint8(1);
          for (let i = 0; i < PolarSensorNames.length; i++) {
            const sensor_name = PolarSensorNames[i];
            if ((feature_num >> PolarSensorType[sensor_name]) & 0x01) {
              featureList.push(sensor_name);
            }
          }
        }
      }
    }

    return featureList;
  }

  async getSensorSettingsFromName(
    sensorName: keyof typeof PolarSensorType,
  ): Promise<PolarSensorInfo | undefined> {
    return this.getSensorSettingsFromId(PolarSensorType[sensorName]);
  }

  parseSensorSettings(val: DataView) {
    if (
      val.getUint8(0) == 0xf0 &&
      val.getUint8(1) == PolarPMDCommand.GET_MEASUREMENT_SETTINGS
    ) {
      const info: PolarSensorInfo = {
        type: PolarSensorType[val.getUint8(2)],
        error: ERROR_MSGS[val.getUint8(3)],
        more_frames: val.getUint8(4),
        settings: {},
      };
      let i = 5;
      while (i < val.byteLength) {
        const setting_type = val.getUint8(i);
        i += 1;
        const arr_len = val.getUint8(i);
        i += 1;
        const setting_name = PolarSettingType[setting_type];
        info.settings[setting_name] = [];
        for (let arr_i = 0; arr_i < arr_len; arr_i++) {
          info.settings[setting_name].push(
            setting_parsers[setting_name](val, i),
          );
          i += setting_parser_offsets[setting_name];
        }
      }
      return info;
    }
  }

  async getSensorSettingsFromId(
    sensorId: PolarSensorType,
  ): Promise<PolarSensorInfo | undefined> {
    if (!this.streaming) {
      let sensorSettingPromiseRSLV: (value: any | PromiseLike<any>) => void;
      const sensorSettingPromise: Promise<PolarSensorInfo | undefined> =
        new Promise((rslv, rjct) => {
          sensorSettingPromiseRSLV = rslv;
        });
      const PMDSensorSettingHandle = (event: any) => {
        const val: DataView = event?.target?.value;
        sensorSettingPromiseRSLV(this.parseSensorSettings(val));
      };
      this.PMDCtrlChar?.addEventListener(
        "characteristicvaluechanged",
        PMDSensorSettingHandle,
        { once: true },
      );
      const cmd_buf = new Uint8Array([
        PolarPMDCommand.GET_MEASUREMENT_SETTINGS,
        sensorId,
      ]);
      await this.PMDCtrlChar?.writeValue(cmd_buf);
      return await sensorSettingPromise;
    }
  }

  HearRateHandle(event: any) {
    const val: DataView = event.target.value;

    const hear_rate_info: HeartRateInfo = {
      heart_rate_bpm: -1,
      rr_intervals_ms: [],
      recv_epoch_time_ms: event.timeStamp + performance.timeOrigin,
    };
    const flags = val.getUint8(0);
    let offset = 1;

    // Determine if HR format is 8-bit (0) or 16-bit (1) based on the first flag bit
    const heartRateFormat = flags & 0x01;

    if (heartRateFormat === 1) {
      hear_rate_info.heart_rate_bpm = val.getUint16(offset, true); // 16-bit, little-endian
      offset += 2;
    } else {
      hear_rate_info.heart_rate_bpm = val.getUint8(offset); // 8-bit
      offset += 1;
    }

    // Check if R-R intervals are present (Bit 4, val 16)
    const rrIntervalPresent = (flags & 0x10) !== 0;
    // const rrIntervals = [];

    if (rrIntervalPresent) {
      // Read 16-bit R-R intervals until the end of the data view
      while (offset < val.byteLength) {
        const rawRrInterval = val.getUint16(offset, true);
        // Convert raw 1/1024 second units to milliseconds
        const rrIntervalMs = (rawRrInterval / 1024.0) * 1000.0;
        hear_rate_info.rr_intervals_ms.push(rrIntervalMs); // Format to 2 decimal places
        offset += 2;
      }
    }

    for (const handler of this.heartRateHandleList) {
      handler(hear_rate_info);
    }
  }

  PMDDataHandle(event: any) {
    const val: DataView = event.target.value;
    const dataTimeStamp = val.getBigUint64(1, true);
    if (this.timeOffset === BigInt(0)) {
      this.timeOffset = dataTimeStamp;
      this.eventTimeOffset = event.timeStamp + performance.timeOrigin;
    }
    const offset_timestamp = Number(dataTimeStamp - this.timeOffset) / 1e6;
    const type = val.getUint8(0);
    const frame_type = val.getUint8(9);

    const dataFrame: PolarH10Data = {
      type: PolarSensorType[type],
      sample_timestamp_ms: offset_timestamp,
      prev_sample_timestamp_ms: 0,
      recv_epoch_time_ms: event.timeStamp + performance.timeOrigin,
      event_time_offset_ms: this.eventTimeOffset,
    };
    switch (type) {
      case PolarSensorType.ACC:
        if (frame_type == 1) {
          dataFrame.samples = new Int16Array(val.buffer.slice(10));
          dataFrame.prev_sample_timestamp_ms = this.lastACCTimestamp;
          this.lastACCTimestamp = offset_timestamp;
        }

        break;
      case PolarSensorType.ECG:
        if (frame_type === 0) {
          const numFrames = Math.floor((val.byteLength - 10) / 3);
          dataFrame.samples = new Int32Array(numFrames);
          for (let i = 10; i < val.byteLength; i += 3) {
            let d =
              (val.getUint8(i + 2) << 16) |
              (val.getUint8(i + 1) << 8) |
              val.getUint8(i);
            if (d & 0x800000) {
              d |= 0xff000000;
            }
            dataFrame.samples[Math.floor((i - 10) / 3)] = d;
          }
          dataFrame.prev_sample_timestamp_ms = this.lastECGTimestamp;
          this.lastECGTimestamp = offset_timestamp;
        }
        break;
    }
    for (const handler of this.dataHandleDict[PolarSensorType[type]]) {
      handler(dataFrame);
    }
  }

  parseCtrlReply(val: DataView): PMDCtrlReply | undefined {
    if (val.getUint8(0) === 0xf0) {
      const polar_cmd = val.getUint8(1);
      if (
        polar_cmd === PolarPMDCommand.REQUEST_MEASUREMENT_START ||
        polar_cmd === PolarPMDCommand.REQUEST_MEASUREMENT_STOP
      ) {
        const startReply: PMDCtrlReply = {
          type: PolarPMDCommand[polar_cmd],
          sensor: PolarSensorType[val.getUint8(2)],
          error: ERROR_MSGS[val.getUint8(3)],
          more_frames: val.getUint8(4),
        };
        if (val.byteLength > 5) {
          startReply.reserved = val.getUint8(5);
        }
        return startReply;
      }
    }
  }

  async startHeartRate() {
    await this.HeartRateChar?.startNotifications();
  }

  async stopheartRate() {
    await this.HeartRateChar?.stopNotifications();
  }

  async startACC(
    rangeG: number = 4,
    sample_rate: number = 100,
    resolution: number = 16,
  ): Promise<PMDCtrlReply | undefined> {
    if (this.ACCStarted) {
      return;
    }

    let startACCRSLV: (value: any | PromiseLike<any>) => void;
    const startACCPromise: Promise<PMDCtrlReply | undefined> = new Promise(
      (rslv, rjct) => {
        startACCRSLV = rslv;
      },
    );
    const PMDSensorSettingHandle = (event: any) => {
      this.log("PMDSensorSettingHandle");
      const val: DataView = event?.target?.value;
      startACCRSLV(this.parseCtrlReply(val));
    };
    this.PMDCtrlChar?.addEventListener(
      "characteristicvaluechanged",
      PMDSensorSettingHandle,
      { once: true },
    );

    const cmd_buf = new Uint8Array(14);
    const cmd_buf_dataview = new DataView(cmd_buf.buffer);
    cmd_buf[0] = PolarPMDCommand.REQUEST_MEASUREMENT_START;
    cmd_buf[1] = PolarSensorType.ACC;

    cmd_buf[2] = PolarSettingType.RANGE_PN_UNIT;
    cmd_buf[3] = 1;
    cmd_buf_dataview.setUint16(4, rangeG, true);

    cmd_buf[6] = PolarSettingType.SAMPLE_RATE;
    cmd_buf[7] = 1;
    cmd_buf_dataview.setUint16(8, sample_rate, true);

    cmd_buf[10] = PolarSettingType.RESOLUTION;
    cmd_buf[11] = 1;
    cmd_buf_dataview.setUint16(12, resolution, true);

    await this.PMDCtrlChar?.writeValue(cmd_buf);
    const startReply: PMDCtrlReply | undefined = await startACCPromise;
    if (startReply?.error === ERROR_MSGS[0]) {
      this.ACCStarted = true;
    }
    return startReply;
  }

  async startECG(
    sample_rate: number = 130,
    resolution: number = 14,
  ): Promise<PMDCtrlReply | undefined> {
    if (this.ECGStarted) {
      return;
    }
    let startECGRSLV: (value: any | PromiseLike<any>) => void;
    const startECGPromise: Promise<PMDCtrlReply | undefined> = new Promise(
      (rslv, rjct) => {
        startECGRSLV = rslv;
      },
    );
    const PMDSensorSettingHandle = (event: any) => {
      this.log("PMDSensorSettingHandle");
      const val: DataView = event?.target?.value;
      startECGRSLV(this.parseCtrlReply(val));
    };
    this.PMDCtrlChar?.addEventListener(
      "characteristicvaluechanged",
      PMDSensorSettingHandle,
      { once: true },
    );

    const cmd_buf = new Uint8Array(10);
    const cmd_buf_dataview = new DataView(cmd_buf.buffer);
    cmd_buf[0] = PolarPMDCommand.REQUEST_MEASUREMENT_START;
    cmd_buf[1] = PolarSensorType.ECG;

    cmd_buf[2] = PolarSettingType.RESOLUTION;
    cmd_buf[3] = 1;
    cmd_buf_dataview.setUint16(4, resolution, true);

    cmd_buf[6] = PolarSettingType.SAMPLE_RATE;
    cmd_buf[7] = 1;
    cmd_buf_dataview.setUint16(8, sample_rate, true);

    await this.PMDCtrlChar?.writeValue(cmd_buf);
    const startReply: PMDCtrlReply | undefined = await startECGPromise;
    if (startReply?.error === ERROR_MSGS[0]) {
      this.ECGStarted = true;
    }
    return startReply;
  }

  async stopECG() {
    if (!this.ECGStarted) {
      return;
    }
    const endReply: PMDCtrlReply | undefined = await this.stopSensor(
      PolarSensorType.ECG,
    );
    if (endReply?.error === ERROR_MSGS[0]) {
      this.ECGStarted = false;
    }
    return endReply;
  }

  async stopACC() {
    if (!this.ACCStarted) {
      return;
    }
    const endReply: PMDCtrlReply | undefined = await this.stopSensor(
      PolarSensorType.ACC,
    );
    if (endReply?.error === ERROR_MSGS[0]) {
      this.ACCStarted = false;
    }
    return endReply;
  }

  async stopSensor(sensorType: PolarSensorType) {
    let endSensorRSLV: (value: any | PromiseLike<any>) => void;
    const endACCPromise: Promise<PMDCtrlReply | undefined> = new Promise(
      (rslv, rjct) => {
        endSensorRSLV = rslv;
      },
    );
    const PMDSensorSettingHandle = (event: any) => {
      const val: DataView = event?.target?.value;
      endSensorRSLV(this.parseCtrlReply(val));
    };

    this.PMDCtrlChar?.addEventListener(
      "characteristicvaluechanged",
      PMDSensorSettingHandle,
      { once: true },
    );

    const cmd_buf = new Uint8Array(2);
    cmd_buf[0] = PolarPMDCommand.REQUEST_MEASUREMENT_STOP;
    cmd_buf[1] = sensorType;
    await this.PMDCtrlChar?.writeValue(cmd_buf);
    return await endACCPromise;
  }
}
