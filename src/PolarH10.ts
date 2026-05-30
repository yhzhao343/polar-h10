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

export type PolarH10Data = {
  type: (typeof PolarSensorNames)[number];
  samples?: Int16Array | Int32Array;
  sample_timestamp_ms: number;
  prev_sample_timestamp_ms: number;
  recv_epoch_time_ms: number;
  event_time_offset_ms: number;
  epoch_timestamps_ms?: Float64Array;
};

export type PolarSensorHandlerFunc = (data: PolarH10Data) => void;
export type HeartRateHandlerFunc = (data: HeartRateInfo) => void;
export type BattLevelHandlerFunc = (data: number) => void;

export interface DataHandlerDict {
  [key: (typeof PolarSensorNames)[number]]: PolarSensorHandlerFunc[];
}

export interface HeartRateInfo {
  heart_rate_bpm: number;
  rr_intervals_ms: number[];
  recv_epoch_time_ms: number;
}

export type HeartRateHandlers = HeartRateHandlerFunc[];
export type BattLevelHandlers = BattLevelHandlerFunc[];

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

function readBits(
  buffer: Uint8Array,
  bitOffset: number,
  bitLength: number,
): number {
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const totalBitOffset = bitOffset + i;
    const byteIndex = Math.floor(totalBitOffset / 8);
    const bitIndex = totalBitOffset % 8;

    if (byteIndex >= buffer.length) break;

    const bit = (buffer[byteIndex] >> bitIndex) & 1;
    value |= bit << i;
  }

  // Sign extension for signed deltas
  const signBit = 1 << (bitLength - 1);
  if (value & signBit) {
    value |= ~((1 << bitLength) - 1);
  }

  return value;
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
  battLevelHandleList: BattLevelHandlers = [];
  timeOffset: bigint = BigInt(0);
  eventTimeOffset: number;
  lastECGTimestamp: number;
  lastACCTimestamp: number;
  ACCStarted: boolean = false;
  ECGStarted: boolean = false;
  battLvl: number;

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

  addBatteryLevelEventListener(handler: BattLevelHandlerFunc) {
    if (!this.battLevelHandleList.includes(handler)) {
      this.battLevelHandleList.push(handler);
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

  // Enhanced defensive notification handler
  async safeStartNotifications(
    characteristic: BluetoothRemoteGATTCharacteristic | undefined,
    label: string,
  ): Promise<void> {
    if (!characteristic) return;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await characteristic.startNotifications();
        this.log(`    Successfully subscribed to ${label} notifications`);
        return;
      } catch (error: any) {
        this.log(
          `    ⚠️ Attempt ${attempt} failed for ${label}: ${error.message || error}`,
        );

        if (
          error.message.includes("range") ||
          error.message.includes("disconnect")
        ) {
          throw error;
        }

        if (attempt === 2) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  // Outer initialization manager with Pre-Caching Architecture
  async init(retryAttempt = 0): Promise<void> {
    try {
      this.device.removeEventListener(
        "gattserverdisconnected",
        this.handleNativeDisconnect,
      );
      this.device.addEventListener(
        "gattserverdisconnected",
        this.handleNativeDisconnect.bind(this),
      );

      this.log(
        `Connecting to ${this.device.name} GATT server... (Attempt ${retryAttempt + 1})`,
      );
      this.server = await this.device.gatt?.connect();

      // await new Promise((resolve) => setTimeout(resolve, 500));

      if (!this.server || !this.server.connected) {
        throw new Error("GATT Server failed to connect.");
      }

      this.log(`  🔍 Phase 1: Caching GATT Table...`);

      this.PMDService = await this.server.getPrimaryService(PMD_SERVICE_ID);
      this.PMDCtrlChar = await this.PMDService.getCharacteristic(PMD_CTRL_CHAR);
      this.PMDDataChar = await this.PMDService.getCharacteristic(PMD_DATA_CHAR);

      this.BattService = await this.server.getPrimaryService("battery_service");
      this.BattLvlChar =
        await this.BattService.getCharacteristic("battery_level");

      this.HeartRateService = await this.server.getPrimaryService(
        HEART_RATE_SERVICE_UUID,
      );
      this.HeartRateChar = await this.HeartRateService.getCharacteristic(
        HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
      );

      this.log(`  ✅ Phase 1 Complete. All characteristics cached.`);
      // await new Promise((resolve) => setTimeout(resolve, 100));
      // =========================================================
      // PHASE 2: SEQUENTIAL SUBSCRIPTIONS & PAIRING
      // =========================================================
      this.log(`  🚀 Phase 2: Starting Subscriptions...`);

      await this.safeStartNotifications(this.BattLvlChar, "Battery Level");
      await this.safeStartNotifications(this.HeartRateChar, "Heart Rate");

      // === THE WRITE-TO-PAIR KICKSTART ===
      // We must write a harmless command (Get ECG Settings: 0x01, 0x00)
      // to trip the device's encryption requirement and trigger the OS prompt.
      this.log(`    🔑 Forcing OS Pairing Prompt via secure write...`);
      try {
        const dummyCmd = new Uint8Array([0x01, 0x00]); // GET_MEASUREMENT_SETTINGS for ECG

        // Use standard writeValue (which defaults to Write with Response)
        await this.PMDCtrlChar?.writeValue(dummyCmd);
      } catch (error: any) {
        // We EXPECT this to throw a security rejection or cause a native disconnect!
        this.log(`    (Write triggered security sequence: ${error.message})`);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      // ===================================

      await this.safeStartNotifications(this.PMDCtrlChar, "PMD Control");

      this.log(
        `    🔒 Security bond formed. Waiting 50ms for encryption stabilization...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      await this.safeStartNotifications(this.PMDDataChar, "PMD Data");

      this.streaming = false;

      // --- Bind Data Stream Handlers ---
      this.PMDDataChar.addEventListener(
        "characteristicvaluechanged",
        this.PMDDataHandle.bind(this),
      );
      this.HeartRateChar.addEventListener(
        "characteristicvaluechanged",
        this.HearRateHandle.bind(this),
      );
      this.BattLvlChar.addEventListener(
        "characteristicvaluechanged",
        this.BatteryLevelHandle.bind(this),
      );

      this.log("✅ Polar H10 Driver Fully Initialized and Secured.");
    } catch (error: any) {
      const isPairingDrop =
        error.message.includes("range") ||
        error.message.includes("disconnected");

      if (isPairingDrop && retryAttempt < 1) {
        this.log(
          `🔄 Connection severed due to OS Pairing/Bonding cycle. Waiting 1s for hardware link to recycle...`,
        );
        this.streaming = false;
        this.ACCStarted = false;
        this.ECGStarted = false;

        await new Promise((resolve) => setTimeout(resolve, 200));
        return this.init(retryAttempt + 1);
      }

      if (error.message.includes("range") && retryAttempt >= 1) {
        this.log(
          `❌ Fatal: Chromium Web Bluetooth encountered a Ghost Handle state.`,
        );
        this.log(
          `💡 FIX: Because the device IRK rotated, the browser's device reference is permanently dead.`,
        );
        this.log(
          `👉 You MUST use OS-level Bluetooth pairing before connecting.`,
        );
      } else {
        this.log(`❌ Initialization totally failed: ${error.message}`);
      }
      throw error;
    }
  }

  handleNativeDisconnect() {
    this.log("⚠️ GATT Server disconnected natively.");
    this.streaming = false;
    this.ACCStarted = false;
    this.ECGStarted = false;
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
    this.log(PMEFeatures);
    if (PMEFeatures !== undefined) {
      // if (PMEFeatures.byteLength === 17) {
      if (PMEFeatures !== undefined && PMEFeatures.byteLength >= 2) {
        // if (PMEFeatures.getUint8(0) === 0xf) {
        const feature_num = PMEFeatures.getUint8(1);
        for (let i = 0; i < PolarSensorNames.length; i++) {
          const sensor_name = PolarSensorNames[i];
          if ((feature_num >> PolarSensorType[sensor_name]) & 0x01) {
            featureList.push(sensor_name);
          }
        }
        // }
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
      await this.PMDCtrlChar?.writeValueWithoutResponse(cmd_buf);
      return await sensorSettingPromise;
    }
  }

  HearRateHandle(event: any) {
    if (this.heartRateHandleList.length > 0) {
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
  }

  BatteryLevelHandle(event: any) {
    this.battLvl = event.target.value.getUint8();
    if (this.battLevelHandleList.length > 0) {
      for (const handler of this.battLevelHandleList) {
        handler(this.battLvl);
      }
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
    let estimated_sample_interval = 0;
    let s_i_delta = 1;
    switch (type) {
      case PolarSensorType.ACC:
        if (frame_type == 1) {
          dataFrame.samples = new Int16Array(val.buffer.slice(10));
          dataFrame.prev_sample_timestamp_ms = this.lastACCTimestamp;
          this.lastACCTimestamp = offset_timestamp;
          s_i_delta = 3;
        } else if (frame_type === 2) {
          // Firmware v4: Delta-Delta Compressed triplets
          // 1. Read 16-bit reference coordinates (Bytes 10-15)
          const refX = val.getInt16(10, true);
          const refY = val.getInt16(12, true);
          const refZ = val.getInt16(14, true);

          // 2. Extract bit size per component (Byte 16)
          const deltaSize = val.getUint8(16);

          if (deltaSize > 0) {
            const rawData = new Uint8Array(val.buffer);
            const deltaBuffer = rawData.subarray(17); // Deltas start at byte 17
            const remainingBits = deltaBuffer.length * 8;
            const numTriplets = Math.floor(remainingBits / (deltaSize * 3)); // 3 axes per triplet

            // Allocate spatial buffer array for all recovered coordinates
            dataFrame.samples = new Int16Array((numTriplets + 1) * 3);

            // Set the first triplet equal to the reference samples
            dataFrame.samples[0] = refX;
            dataFrame.samples[1] = refY;
            dataFrame.samples[2] = refZ;

            let bitOffset = 0;
            let currentX = refX;
            let currentY = refY;
            let currentZ = refZ;

            // Initialize delta velocities
            let deltaX = 0;
            let deltaY = 0;
            let deltaZ = 0;

            // 3. Unpack bitstream and integrate changes sequentially
            for (let i = 0; i < numTriplets; i++) {
              const ddx = readBits(deltaBuffer, bitOffset, deltaSize);
              bitOffset += deltaSize;
              const ddy = readBits(deltaBuffer, bitOffset, deltaSize);
              bitOffset += deltaSize;
              const ddz = readBits(deltaBuffer, bitOffset, deltaSize);
              bitOffset += deltaSize;

              // Integrate second-order delta-deltas into first-order deltas
              deltaX += ddx;
              deltaY += ddy;
              deltaZ += ddz;

              // Integrate deltas into absolute sample positions
              currentX += deltaX;
              currentY += deltaY;
              currentZ += deltaZ;

              // Store output values sequentially in a flat structure
              const baseIdx = (i + 1) * 3;
              dataFrame.samples[baseIdx] = currentX;
              dataFrame.samples[baseIdx + 1] = currentY;
              dataFrame.samples[baseIdx + 2] = currentZ;
            }
          } else {
            // Safety fallback: if deltaSize is 0, the device recorded no motion changes
            dataFrame.samples = new Int16Array([refX, refY, refZ]);
          }

          dataFrame.prev_sample_timestamp_ms = this.lastACCTimestamp;
          this.lastACCTimestamp = offset_timestamp;
          s_i_delta = 3; // 3 items per point coordinate calculation block
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
          s_i_delta = 1;
        } else if (frame_type === 1) {
          // FW v4 Delta Compressed Parsing
          const rawData = new Uint8Array(val.buffer);

          // 1. Get 24-bit reference sample
          let refSample =
            val.getUint8(10) |
            (val.getUint8(11) << 8) |
            (val.getUint8(12) << 16);
          if (refSample & 0x800000) refSample |= 0xff000000; // Sign extend 24-bit to 32-bit

          // 2. Get bit size of deltas
          const deltaSize = rawData[13];

          // 3. Determine how many deltas are packed in the remaining buffer
          const remainingBits = (rawData.length - 14) * 8;
          const numDeltas = Math.floor(remainingBits / deltaSize);

          dataFrame.samples = new Int32Array(numDeltas + 1);
          dataFrame.samples[0] = refSample;

          let currentSample = refSample;
          let bitOffset = 0;
          const deltaBuffer = rawData.subarray(14);

          for (let i = 0; i < numDeltas; i++) {
            const delta = readBits(deltaBuffer, bitOffset, deltaSize);
            bitOffset += deltaSize;
            currentSample += delta;
            dataFrame.samples[i + 1] = currentSample;
          }

          dataFrame.prev_sample_timestamp_ms = this.lastECGTimestamp;
          this.lastECGTimestamp = offset_timestamp;
          s_i_delta = 1;
        }
        break;
    }
    if (
      dataFrame.samples !== undefined &&
      this.dataHandleDict[PolarSensorType[type]].length > 0
    ) {
      estimated_sample_interval =
        (dataFrame.sample_timestamp_ms - dataFrame.prev_sample_timestamp_ms) /
        (dataFrame.samples.length / s_i_delta);
      if (estimated_sample_interval > 0) {
        let timeOffset =
          dataFrame.event_time_offset_ms + dataFrame.prev_sample_timestamp_ms;
        const numFrame = Math.floor(dataFrame.samples.length / s_i_delta);
        dataFrame.epoch_timestamps_ms = new Float64Array(numFrame);
        for (let i = 0; i < numFrame; i++) {
          timeOffset += estimated_sample_interval;
          dataFrame.epoch_timestamps_ms[i] = timeOffset;
        }
        for (const handler of this.dataHandleDict[PolarSensorType[type]]) {
          handler(dataFrame);
        }
      }
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

    await this.PMDCtrlChar?.writeValueWithoutResponse(cmd_buf);
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

    await this.PMDCtrlChar?.writeValueWithoutResponse(cmd_buf);
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
    await this.PMDCtrlChar?.writeValueWithoutResponse(cmd_buf);
    return await endACCPromise;
  }
}
