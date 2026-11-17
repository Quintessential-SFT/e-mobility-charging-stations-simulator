/**
 * @file Tests for OCPP16ServiceUtils EV side cable plug/unplug
 * @description Verifies the OCPP 1.6 EV side disconnect behavior (§4.9, §4.10):
 *   StopTransactionOnEVSideDisconnect and UnlockConnectorOnEVSideDisconnect, the
 *   boot cable state, plug/unplug status transitions, remote start waiting for the
 *   cable within ConnectionTimeOut, and meter values frozen while unplugged.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import type { ChargingStation } from '../../../../src/charging-station/index.js'
import type { OCPP16StopTransactionRequest } from '../../../../src/types/index.js'

import { OCPP16IncomingRequestService } from '../../../../src/charging-station/ocpp/1.6/OCPP16IncomingRequestService.js'
import { OCPP16ResponseService } from '../../../../src/charging-station/ocpp/1.6/OCPP16ResponseService.js'
import { OCPP16ServiceUtils } from '../../../../src/charging-station/ocpp/1.6/OCPP16ServiceUtils.js'
import { buildMeterValue } from '../../../../src/charging-station/ocpp/OCPPServiceUtils.js'
import {
  GenericStatus,
  MeterValueMeasurand,
  OCPP16AuthorizationStatus,
  OCPP16ChargePointErrorCode,
  OCPP16ChargePointStatus,
  OCPP16ConfigurationStatus,
  OCPP16IncomingRequestCommand,
  OCPP16RequestCommand,
  OCPP16StandardParametersKey,
  OCPP16StopTransactionReason,
  OCPPVersion,
  RequestCommand,
  type SampledValueTemplate,
} from '../../../../src/types/index.js'
import { Constants } from '../../../../src/utils/index.js'
import {
  flushMicrotasks,
  setupConnectorWithTransaction,
  standardCleanup,
} from '../../../helpers/TestLifecycleHelpers.js'
import { createMockChargingStation } from '../../helpers/StationHelpers.js'
import {
  createOCPP16IncomingRequestTestContext,
  upsertConfigurationKey,
} from './OCPP16TestUtils.js'

const EV_SIDE_DISCONNECTED_INFO = 'EV side disconnected'

interface RecordedRequest {
  command: unknown
  payload: Record<string, unknown>
}

const createStation = (): { requests: RecordedRequest[]; station: ChargingStation } => {
  const requests: RecordedRequest[] = []
  const requestHandler = mock.fn(async (...args: unknown[]) => {
    requests.push({ command: args[1], payload: args[2] as Record<string, unknown> })
    return Promise.resolve(
      args[1] === RequestCommand.START_TRANSACTION
        ? { idTagInfo: { status: OCPP16AuthorizationStatus.ACCEPTED }, transactionId: 1 }
        : {}
    )
  })
  const { station } = createMockChargingStation({
    connectorsCount: 2,
    ocppRequestService: { requestHandler },
    stationInfo: { ocppStrictCompliance: false, ocppVersion: OCPPVersion.VERSION_16 },
    websocketPingInterval: Constants.DEFAULT_WS_PING_INTERVAL_SECONDS,
  })
  return { requests, station }
}

const statusNotifications = (requests: RecordedRequest[]): Record<string, unknown>[] =>
  requests
    .filter(request => request.command === RequestCommand.STATUS_NOTIFICATION)
    .map(request => request.payload)

await describe('OCPP16ServiceUtils — EV side disconnect', async () => {
  let station: ChargingStation
  let requests: RecordedRequest[]

  beforeEach(() => {
    ;({ requests, station } = createStation())
  })

  afterEach(() => {
    standardCleanup()
  })

  await describe('configuration keys', async () => {
    await it('should treat missing keys as true', () => {
      assert.strictEqual(OCPP16ServiceUtils.getStopTransactionOnEVSideDisconnect(station), true)
      assert.strictEqual(OCPP16ServiceUtils.getUnlockConnectorOnEVSideDisconnect(station), true)
    })

    await it('should read false values', () => {
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
        'false'
      )
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.UnlockConnectorOnEVSideDisconnect,
        'false'
      )

      assert.strictEqual(OCPP16ServiceUtils.getStopTransactionOnEVSideDisconnect(station), false)
      assert.strictEqual(OCPP16ServiceUtils.getUnlockConnectorOnEVSideDisconnect(station), false)
    })

    for (const key of [
      OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
      OCPP16StandardParametersKey.UnlockConnectorOnEVSideDisconnect,
    ]) {
      await it(`should accept boolean ChangeConfiguration values and reject others for ${key}`, () => {
        const { station: configStation, testableService } = createOCPP16IncomingRequestTestContext()
        upsertConfigurationKey(configStation, key, 'true')

        const accepted = testableService.handleRequestChangeConfiguration(configStation, {
          key,
          value: 'false',
        })
        const rejected = testableService.handleRequestChangeConfiguration(configStation, {
          key,
          value: 'maybe',
        })

        assert.strictEqual(accepted.status, OCPP16ConfigurationStatus.ACCEPTED)
        assert.strictEqual(rejected.status, OCPP16ConfigurationStatus.REJECTED)
        assert.strictEqual(
          configStation.ocppConfiguration?.configurationKey?.find(k => k.key === (key as string))
            ?.value,
          'false'
        )
      })
    }
  })

  await describe('initializeEVSideCableState', async () => {
    await it('should start connectors unplugged', () => {
      OCPP16ServiceUtils.initializeEVSideCableState(station)

      assert.strictEqual(station.getConnectorStatus(1)?.cablePlugged, false)
      assert.strictEqual(station.getConnectorStatus(2)?.cablePlugged, false)
    })

    await it('should come back plugged with a restored open transaction', () => {
      setupConnectorWithTransaction(station, 1, { transactionId: 10 })
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.status = OCPP16ChargePointStatus.SuspendedEV

      OCPP16ServiceUtils.initializeEVSideCableState(station)

      assert.strictEqual(connectorStatus.cablePlugged, true)
      assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Charging)
      assert.strictEqual(station.getConnectorStatus(2)?.cablePlugged, false)
    })

    await it('should boot a restored transaction with a cleared status into Charging', () => {
      setupConnectorWithTransaction(station, 1, { transactionId: 11 })
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      delete connectorStatus.status

      OCPP16ServiceUtils.initializeEVSideCableState(station)

      assert.strictEqual(connectorStatus.cablePlugged, true)
      assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Charging)
    })
  })

  await describe('resumeRestoredTransactionMeterValues', async () => {
    await it('should restart MeterValues of a restored transaction once', () => {
      upsertConfigurationKey(station, OCPP16StandardParametersKey.MeterValueSampleInterval, '5')
      setupConnectorWithTransaction(station, 1, { transactionId: 12 })
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)

      try {
        OCPP16ServiceUtils.resumeRestoredTransactionMeterValues(station)
        const interval = connectorStatus.transactionUpdatedMeterValuesSetInterval
        assert.ok(interval != null)
        assert.strictEqual(
          station.getConnectorStatus(2)?.transactionUpdatedMeterValuesSetInterval,
          undefined
        )

        OCPP16ServiceUtils.resumeRestoredTransactionMeterValues(station)
        assert.strictEqual(connectorStatus.transactionUpdatedMeterValuesSetInterval, interval)
      } finally {
        OCPP16ServiceUtils.stopUpdatedMeterValues(station, 1)
      }
    })
  })

  await describe('plugConnector and unplugConnector without transaction', async () => {
    await it('should report Preparing on plug and Available on unplug', async () => {
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.status = OCPP16ChargePointStatus.Available
      connectorStatus.cablePlugged = false

      await OCPP16ServiceUtils.plugConnector(station, 1)

      assert.strictEqual(connectorStatus.cablePlugged, true)
      assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Preparing)

      await OCPP16ServiceUtils.unplugConnector(station, 1)

      assert.strictEqual(connectorStatus.cablePlugged, false)
      assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Available)
      assert.deepStrictEqual(
        statusNotifications(requests).map(payload => payload.status),
        [OCPP16ChargePointStatus.Preparing, OCPP16ChargePointStatus.Available]
      )
    })

    await it('should not send anything when unplugging an Available connector', async () => {
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.status = OCPP16ChargePointStatus.Available
      connectorStatus.cablePlugged = true

      await OCPP16ServiceUtils.unplugConnector(station, 1)

      assert.strictEqual(connectorStatus.cablePlugged, false)
      assert.strictEqual(requests.length, 0)
    })

    await it('should be idempotent', async () => {
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.status = OCPP16ChargePointStatus.Available
      connectorStatus.cablePlugged = false

      await OCPP16ServiceUtils.unplugConnector(station, 1)
      await OCPP16ServiceUtils.plugConnector(station, 1)
      await OCPP16ServiceUtils.plugConnector(station, 1)

      assert.strictEqual(statusNotifications(requests).length, 1)
    })
  })

  await describe('unplugConnector during a transaction', async () => {
    beforeEach(() => {
      setupConnectorWithTransaction(station, 1, { transactionId: 42 })
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.cablePlugged = true
      connectorStatus.locked = true
      connectorStatus.status = OCPP16ChargePointStatus.Charging
    })

    await it('should stop with EVDisconnected when StopTransactionOnEVSideDisconnect is true', async () => {
      const stopMock = mock.method(OCPP16ServiceUtils, 'stopTransactionOnConnector', async () =>
        Promise.resolve({ idTagInfo: { status: OCPP16AuthorizationStatus.ACCEPTED } })
      )

      await OCPP16ServiceUtils.unplugConnector(station, 1)

      assert.strictEqual(stopMock.mock.callCount(), 1)
      assert.strictEqual(
        stopMock.mock.calls[0].arguments[2],
        OCPP16StopTransactionReason.EV_DISCONNECTED
      )
    })

    await it('should report SuspendedEV, keep the transaction and the lock when StopTransactionOnEVSideDisconnect is false', async () => {
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
        'false'
      )
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.UnlockConnectorOnEVSideDisconnect,
        'true'
      )
      const stopMock = mock.method(OCPP16ServiceUtils, 'stopTransactionOnConnector')
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)

      await OCPP16ServiceUtils.unplugConnector(station, 1)

      assert.strictEqual(stopMock.mock.callCount(), 0)
      assert.deepStrictEqual(statusNotifications(requests), [
        {
          connectorId: 1,
          errorCode: OCPP16ChargePointErrorCode.NO_ERROR,
          info: EV_SIDE_DISCONNECTED_INFO,
          status: OCPP16ChargePointStatus.SuspendedEV,
        },
      ])
      assert.strictEqual(connectorStatus.transactionStarted, true)
      assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.SuspendedEV)
      assert.strictEqual(connectorStatus.locked, true)

      await OCPP16ServiceUtils.plugConnector(station, 1)

      assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Charging)
      assert.strictEqual(connectorStatus.transactionStarted, true)
    })

    await it('should stop an unplugged transaction once StopTransactionOnEVSideDisconnect becomes true', async () => {
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
        'false'
      )
      await OCPP16ServiceUtils.unplugConnector(station, 1)
      const stopMock = mock.method(OCPP16ServiceUtils, 'stopTransactionOnConnector', async () =>
        Promise.resolve({ idTagInfo: { status: OCPP16AuthorizationStatus.ACCEPTED } })
      )
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
        'true'
      )

      await OCPP16ServiceUtils.enforceStopTransactionOnEVSideDisconnect(station)

      assert.strictEqual(stopMock.mock.callCount(), 1)
      assert.strictEqual(
        stopMock.mock.calls[0].arguments[2],
        OCPP16StopTransactionReason.EV_DISCONNECTED
      )
    })

    await it('should apply an accepted ChangeConfiguration of StopTransactionOnEVSideDisconnect to true', async () => {
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
        'false'
      )
      await OCPP16ServiceUtils.unplugConnector(station, 1)
      const enforceMock = mock.method(
        OCPP16ServiceUtils,
        'enforceStopTransactionOnEVSideDisconnect',
        async () => Promise.resolve()
      )
      const incomingRequestService = new OCPP16IncomingRequestService()
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect,
        'true'
      )

      incomingRequestService.emit(
        OCPP16IncomingRequestCommand.CHANGE_CONFIGURATION,
        station,
        { key: OCPP16StandardParametersKey.StopTransactionOnEVSideDisconnect, value: 'true' },
        { status: OCPP16ConfigurationStatus.ACCEPTED }
      )

      assert.strictEqual(enforceMock.mock.callCount(), 1)
    })

    await it('should send Finishing with EV side disconnected info before StopTransaction', async () => {
      await OCPP16ServiceUtils.unplugConnector(station, 1)

      const finishing = statusNotifications(requests).find(
        payload => payload.status === OCPP16ChargePointStatus.Finishing
      )
      assert.deepStrictEqual(finishing, {
        connectorId: 1,
        errorCode: OCPP16ChargePointErrorCode.NO_ERROR,
        info: EV_SIDE_DISCONNECTED_INFO,
        status: OCPP16ChargePointStatus.Finishing,
      })
      const stopRequest = requests.find(
        request => request.command === RequestCommand.STOP_TRANSACTION
      )
      assert.strictEqual(stopRequest?.payload.reason, OCPP16StopTransactionReason.EV_DISCONNECTED)
    })
  })

  await describe('unlock after an EV side disconnect stop', async () => {
    const stopRequest = (reason?: OCPP16StopTransactionReason): OCPP16StopTransactionRequest => ({
      meterStop: 0,
      ...(reason != null && { reason }),
      timestamp: new Date(),
      transactionId: 42,
    })

    for (const [unlockKey, reason, expectedLocked] of [
      ['true', OCPP16StopTransactionReason.EV_DISCONNECTED, false],
      ['false', OCPP16StopTransactionReason.EV_DISCONNECTED, true],
      ['false', OCPP16StopTransactionReason.REMOTE, false],
    ] as const) {
      await it(`should leave locked=${String(expectedLocked)} with UnlockConnectorOnEVSideDisconnect=${unlockKey} and reason ${reason}`, async () => {
        upsertConfigurationKey(
          station,
          OCPP16StandardParametersKey.UnlockConnectorOnEVSideDisconnect,
          unlockKey
        )
        setupConnectorWithTransaction(station, 1, { transactionId: 42 })
        const connectorStatus = station.getConnectorStatus(1)
        assert.ok(connectorStatus != null)
        connectorStatus.locked = true
        const responseService = new OCPP16ResponseService()

        await responseService.responseHandler(
          station,
          OCPP16RequestCommand.STOP_TRANSACTION,
          { idTagInfo: { status: OCPP16AuthorizationStatus.ACCEPTED } },
          stopRequest(reason)
        )

        assert.strictEqual(connectorStatus.transactionStarted, false)
        assert.strictEqual(connectorStatus.locked, expectedLocked)
      })
    }
  })

  await describe('remote start waiting for the cable', async () => {
    beforeEach(() => {
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.status = OCPP16ChargePointStatus.Available
      connectorStatus.cablePlugged = false
    })

    await it('should report Preparing and start the transaction when the cable is plugged', async () => {
      const startMock = mock.method(OCPP16ServiceUtils, 'startTransactionOnConnector', async () =>
        Promise.resolve({ idTagInfo: { status: OCPP16AuthorizationStatus.ACCEPTED } })
      )

      await OCPP16ServiceUtils.waitForEVSideCablePlugged(station, 1, 'TAG-1')

      assert.strictEqual(station.getConnectorStatus(1)?.status, OCPP16ChargePointStatus.Preparing)
      assert.strictEqual(startMock.mock.callCount(), 0)

      await OCPP16ServiceUtils.plugConnector(station, 1)

      assert.strictEqual(startMock.mock.callCount(), 1)
      assert.strictEqual(startMock.mock.calls[0].arguments[2], 'TAG-1')
      assert.deepStrictEqual(
        statusNotifications(requests).map(payload => payload.status),
        [OCPP16ChargePointStatus.Preparing]
      )
    })

    await it('should cancel the remote start when ConnectionTimeOut elapses', async () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      mock.method(station, 'getConnectionTimeout', () => 2)
      ;(station as unknown as { started: boolean }).started = true
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.transactionRemoteStarted = true
      const startMock = mock.method(OCPP16ServiceUtils, 'startTransactionOnConnector')

      await OCPP16ServiceUtils.waitForEVSideCablePlugged(station, 1, 'TAG-1')
      mock.timers.tick(2000)
      await new Promise(resolve => {
        setImmediate(resolve)
      })
      await OCPP16ServiceUtils.plugConnector(station, 1)

      assert.strictEqual(connectorStatus.transactionRemoteStarted, false)
      assert.strictEqual(startMock.mock.callCount(), 0)
      assert.deepStrictEqual(
        statusNotifications(requests).map(payload => payload.status),
        [
          OCPP16ChargePointStatus.Preparing,
          OCPP16ChargePointStatus.Available,
          OCPP16ChargePointStatus.Preparing,
        ]
      )
    })

    await it('should defer the StartTransaction of an accepted remote start until plug-in', async () => {
      const incomingRequestService = new OCPP16IncomingRequestService()

      incomingRequestService.emit(
        OCPP16IncomingRequestCommand.REMOTE_START_TRANSACTION,
        station,
        { connectorId: 1, idTag: 'TAG-1' },
        { status: GenericStatus.Accepted }
      )
      await flushMicrotasks()

      assert.deepStrictEqual(
        requests.map(request => request.command),
        [RequestCommand.STATUS_NOTIFICATION]
      )
      assert.strictEqual(station.getConnectorStatus(1)?.status, OCPP16ChargePointStatus.Preparing)

      await OCPP16ServiceUtils.plugConnector(station, 1)

      assert.deepStrictEqual(
        requests.map(request => request.command),
        [RequestCommand.STATUS_NOTIFICATION, RequestCommand.START_TRANSACTION]
      )
    })

    await it('should mark the cable plugged when a transaction starts locally', async () => {
      await OCPP16ServiceUtils.startTransactionOnConnector(station, 1, 'TAG-1')

      assert.strictEqual(station.getConnectorStatus(1)?.cablePlugged, true)
    })
  })

  await describe('meter values while unplugged', async () => {
    const energyTemplate: SampledValueTemplate = {
      measurand: MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
      unit: 'Wh',
      value: '100',
    }
    const powerTemplate: SampledValueTemplate = {
      measurand: MeterValueMeasurand.POWER_ACTIVE_IMPORT,
      unit: 'W',
      value: '11000',
    }

    const sample = (measurand: MeterValueMeasurand): number => {
      const meterValue = buildMeterValue(station, 42, 60000)
      const sampledValue = meterValue.sampledValue.find(
        value =>
          (value.measurand ?? MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER) === measurand
      )
      assert.ok(sampledValue != null)
      return Number(sampledValue.value)
    }

    beforeEach(() => {
      upsertConfigurationKey(
        station,
        OCPP16StandardParametersKey.MeterValuesSampledData,
        `${MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER},${MeterValueMeasurand.POWER_ACTIVE_IMPORT}`
      )
      setupConnectorWithTransaction(station, 1, { transactionId: 42 })
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.MeterValues = [energyTemplate, powerTemplate]
      connectorStatus.energyActiveImportRegisterValue = 0
    })

    await it('should freeze energy and report zero power while unplugged, then resume', () => {
      const connectorStatus = station.getConnectorStatus(1)
      assert.ok(connectorStatus != null)
      connectorStatus.cablePlugged = true
      const pluggedEnergy = sample(MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER)
      assert.ok(pluggedEnergy > 0)

      connectorStatus.cablePlugged = false
      const unpluggedEnergy = sample(MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER)
      const unpluggedPower = sample(MeterValueMeasurand.POWER_ACTIVE_IMPORT)

      assert.strictEqual(unpluggedEnergy, pluggedEnergy)
      assert.strictEqual(unpluggedPower, 0)

      connectorStatus.cablePlugged = true
      assert.ok(sample(MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER) > unpluggedEnergy)
      assert.ok(sample(MeterValueMeasurand.POWER_ACTIVE_IMPORT) > 0)
    })
  })
})
