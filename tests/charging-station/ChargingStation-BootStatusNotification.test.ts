/**
 * @file Tests for the OCPP 1.6 boot StatusNotification of connectorId 0.
 * @description Errata 3.22 requires a StatusNotification for the Charge Point
 *   as a whole (connectorId 0) after BootNotification.conf Accepted, before
 *   the per-connector notifications. OCPP 2.0.x is unchanged.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'

import type { ChargingStation } from '../../src/charging-station/index.js'

import { ChargingStation as ChargingStationClass } from '../../src/charging-station/ChargingStation.js'
import {
  AvailabilityType,
  ConnectorStatusEnum,
  OCPPVersion,
  RequestCommand,
} from '../../src/types/index.js'
import { standardCleanup } from '../helpers/TestLifecycleHelpers.js'
import { cleanupChargingStation, createMockChargingStation } from './helpers/StationHelpers.js'

interface RecordedRequest {
  command: unknown
  payload: Record<string, unknown>
}

const startMessageSequence = (
  ChargingStationClass.prototype as unknown as {
    startMessageSequence: (ATGStopAbsoluteDuration?: boolean) => Promise<void>
  }
).startMessageSequence

const createStation = (
  ocppVersion: OCPPVersion,
  configure?: (station: ChargingStation) => void
): { requests: RecordedRequest[]; station: ChargingStation } => {
  const requests: RecordedRequest[] = []
  const requestHandler = mock.fn((...args: unknown[]) => {
    requests.push({ command: args[1], payload: args[2] as Record<string, unknown> })
    return Promise.resolve({})
  })
  const { station } = createMockChargingStation({
    connectorsCount: 2,
    ocppRequestService: { requestHandler },
    stationInfo: { ocppVersion },
  })
  Object.assign(station, {
    getAutomaticTransactionGeneratorConfiguration: () => undefined,
  })
  configure?.(station)
  return { requests, station }
}

const statusNotifications = (requests: RecordedRequest[]): Record<string, unknown>[] =>
  requests
    .filter(request => request.command === RequestCommand.STATUS_NOTIFICATION)
    .map(request => request.payload)

await describe('ChargingStation boot StatusNotification for connectorId 0', async () => {
  let station: ChargingStation | undefined

  afterEach(() => {
    standardCleanup()
    if (station != null) {
      cleanupChargingStation(station)
      station = undefined
    }
  })

  await it('should send connectorId 0 Available before the other connectors on OCPP 1.6', async () => {
    const created = createStation(OCPPVersion.VERSION_16)
    station = created.station

    await startMessageSequence.call(station)

    const notifications = statusNotifications(created.requests)
    assert.ok(notifications.length >= 3)
    assert.deepStrictEqual(
      notifications.slice(0, 3).map(payload => ({
        connectorId: payload.connectorId,
        status: payload.status,
      })),
      [
        { connectorId: 0, status: ConnectorStatusEnum.Available },
        { connectorId: 1, status: ConnectorStatusEnum.Available },
        { connectorId: 2, status: ConnectorStatusEnum.Available },
      ]
    )
  })

  await it('should report Unavailable for connectorId 0 when the station is inoperative', async () => {
    const created = createStation(OCPPVersion.VERSION_16, target => {
      const chargePointStatus = target.getConnectorStatus(0)
      assert.ok(chargePointStatus != null)
      chargePointStatus.availability = AvailabilityType.Inoperative
    })
    station = created.station

    await startMessageSequence.call(station)

    const notifications = statusNotifications(created.requests)
    assert.deepStrictEqual(notifications[0], {
      connectorId: 0,
      status: ConnectorStatusEnum.Unavailable,
    })
  })

  await it('should report Faulted for connectorId 0 when the charge point is faulted', async () => {
    const created = createStation(OCPPVersion.VERSION_16, target => {
      const chargePointStatus = target.getConnectorStatus(0)
      assert.ok(chargePointStatus != null)
      chargePointStatus.status = ConnectorStatusEnum.Faulted
    })
    station = created.station

    await startMessageSequence.call(station)

    const notifications = statusNotifications(created.requests)
    assert.deepStrictEqual(notifications[0], {
      connectorId: 0,
      status: ConnectorStatusEnum.Faulted,
    })
    assert.strictEqual(station.getConnectorStatus(0)?.status, ConnectorStatusEnum.Faulted)
  })

  await it('should not overwrite a Reserved status on connector 0', async () => {
    const created = createStation(OCPPVersion.VERSION_16, target => {
      const chargePointStatus = target.getConnectorStatus(0)
      assert.ok(chargePointStatus != null)
      chargePointStatus.status = ConnectorStatusEnum.Reserved
    })
    station = created.station

    await startMessageSequence.call(station)

    assert.deepStrictEqual(statusNotifications(created.requests)[0], {
      connectorId: 0,
      status: ConnectorStatusEnum.Available,
    })
    assert.strictEqual(station.getConnectorStatus(0)?.status, ConnectorStatusEnum.Reserved)
  })

  await it('should not send connectorId 0 on OCPP 2.0.1', async () => {
    const created = createStation(OCPPVersion.VERSION_201)
    station = created.station

    await startMessageSequence.call(station)

    const notifications = statusNotifications(created.requests)
    assert.ok(notifications.length >= 2)
    assert.ok(notifications.every(payload => payload.connectorId !== 0))
  })
})
