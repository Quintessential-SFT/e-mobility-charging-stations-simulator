import { Command } from 'commander'
import { ProcedureName, type RequestPayload } from 'ui-common'

import { parseInteger, runAction } from './action.js'
import { buildHashIdsPayload } from './payload.js'

export const createConnectorCommands = (program: Command): Command => {
  const cmd = new Command('connector').description('Connector management')

  cmd
    .command('lock [hashIds...]')
    .description('Lock connector on station(s)')
    .requiredOption('--connector-id <id>', 'connector ID', parseInteger)
    .action(async (hashIds: string[], options: { connectorId: number }) => {
      const payload: RequestPayload = {
        connectorId: options.connectorId,
        ...buildHashIdsPayload(hashIds),
      }
      await runAction(program, ProcedureName.LOCK_CONNECTOR, payload)
    })

  cmd
    .command('unlock [hashIds...]')
    .description('Unlock connector on station(s)')
    .requiredOption('--connector-id <id>', 'connector ID', parseInteger)
    .action(async (hashIds: string[], options: { connectorId: number }) => {
      const payload: RequestPayload = {
        connectorId: options.connectorId,
        ...buildHashIdsPayload(hashIds),
      }
      await runAction(program, ProcedureName.UNLOCK_CONNECTOR, payload)
    })

  cmd
    .command('plug [hashIds...]')
    .description('Plug cable at the EV side of connector on station(s) (OCPP 1.6)')
    .requiredOption('--connector-id <id>', 'connector ID', parseInteger)
    .action(async (hashIds: string[], options: { connectorId: number }) => {
      const payload: RequestPayload = {
        connectorId: options.connectorId,
        ...buildHashIdsPayload(hashIds),
      }
      await runAction(program, ProcedureName.PLUG_CONNECTOR, payload)
    })

  cmd
    .command('unplug [hashIds...]')
    .description('Unplug cable at the EV side of connector on station(s) (OCPP 1.6)')
    .requiredOption('--connector-id <id>', 'connector ID', parseInteger)
    .action(async (hashIds: string[], options: { connectorId: number }) => {
      const payload: RequestPayload = {
        connectorId: options.connectorId,
        ...buildHashIdsPayload(hashIds),
      }
      await runAction(program, ProcedureName.UNPLUG_CONNECTOR, payload)
    })

  return cmd
}
