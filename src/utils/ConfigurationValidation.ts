import type { ZodError } from 'zod'

import chalk from 'chalk'

import type { ConfigurationData, UIServerConfiguration } from '../types/index.js'
import type { FieldError } from './FieldError.js'

import { BaseError } from '../exception/index.js'
import {
  applyConfigurationMigration,
  coerceConfigurationVersion,
  CURRENT_CONFIGURATION_SCHEMA_VERSION,
  remapDeprecatedKeys,
} from './ConfigurationMigrations.js'
import {
  ConfigurationSchema,
  UI_SERVER_ACCESS_POLICY_ENVIRONMENT_VARIABLES,
  UIServerAccessPolicySchema,
} from './ConfigurationSchema.js'
import { configurationLogPrefix } from './ConfigurationUtils.js'
import { formatFieldErrorsSummary, mapZodIssuesToFieldErrors } from './FieldError.js'
import { assertIsJsonObject, clone, isEmpty, isNotEmptyArray } from './Utils.js'

const moduleName = 'ConfigurationValidation'

/**
 * Phase of the validation pipeline that produced a failure.
 * - `remap`: deprecated-key sweep (collisions, non-object intermediates)
 * - `schema`: strict Zod parse against `ConfigurationSchema`
 *
 * Schema-version migration-chain failures (`coerceConfigurationVersion`,
 * `applyConfigurationMigration`) propagate as bare `BaseError`, mirroring
 * `TemplateValidation`.
 */
type ValidationPhase = 'remap' | 'schema'

/**
 * Error thrown when a configuration fails the migration sweep or the strict
 * schema validation. Carries structured field errors plus migration context.
 */
export class ConfigurationValidationError extends BaseError {
  public readonly fieldErrors: FieldError[]
  public readonly filePath: string
  public readonly migratedFrom?: number
  public override readonly name = 'ConfigurationValidationError' as const
  public readonly phase: ValidationPhase

  public constructor (
    fieldErrors: FieldError[],
    context: { filePath: string; migratedFrom?: number; phase: ValidationPhase }
  ) {
    const fieldSummary = formatFieldErrorsSummary(fieldErrors)
    const migrationNote =
      context.migratedFrom != null
        ? ` (migrated from v${context.migratedFrom.toString()} → v${CURRENT_CONFIGURATION_SCHEMA_VERSION.toString()})`
        : ''
    super(
      `${moduleName}: Configuration validation failed [${context.phase}] for '${context.filePath}'${migrationNote}:\n${fieldSummary}`
    )
    this.filePath = context.filePath
    this.fieldErrors = fieldErrors
    this.migratedFrom = context.migratedFrom
    this.phase = context.phase
  }

  /**
   * Wrap a Zod validation failure with `phase: 'schema'`.
   * @param zodError - the underlying Zod error
   * @param context - file path + optional migration source version
   * @param context.filePath - configuration file path
   * @param context.migratedFrom - source schema version when migration ran
   * @returns a typed validation error ready to throw
   */
  public static fromZodError (
    zodError: ZodError,
    context: { filePath: string; migratedFrom?: number }
  ): ConfigurationValidationError {
    const fieldErrors: FieldError[] = mapZodIssuesToFieldErrors(zodError)
    return new ConfigurationValidationError(fieldErrors, { ...context, phase: 'schema' })
  }
}

/**
 * Validate a parsed configuration through the
 * remap → migrate → strict-parse → transform pipeline.
 * Throws `BaseError` for shape failures, `ConfigurationValidationError`
 * for migration collisions or schema failures.
 * @param parsed - Raw parsed JSON value (any type — guarded internally)
 * @param filePath - Configuration file path (for error messages)
 * @returns Validated and transformed `ConfigurationData`
 */
export const validateConfiguration = (parsed: unknown, filePath: string): ConfigurationData => {
  assertIsJsonObject(
    parsed,
    new BaseError(
      `${moduleName}.validateConfiguration: Invalid simulator configuration payload (not a JSON object) ${filePath}`
    )
  )
  if (isEmpty(parsed)) {
    throw new BaseError(
      `${moduleName}.validateConfiguration: Empty simulator configuration from file ${filePath}`
    )
  }
  // Defensive clone: $schemaVersion is rewritten below.
  const parsedRecord = clone(parsed) as Record<string, unknown>

  const version = coerceConfigurationVersion(parsedRecord.$schemaVersion)
  parsedRecord.$schemaVersion = version
  const migratedFrom = version < CURRENT_CONFIGURATION_SCHEMA_VERSION ? version : undefined

  const { config: swept, fieldErrors: remapErrors, warnings } = remapDeprecatedKeys(parsedRecord)
  for (const { canonicalDestination, sourceKey } of warnings) {
    const guidance =
      canonicalDestination == null
        ? 'no longer used; remove it from the configuration'
        : `use '${canonicalDestination}' instead`
    // console.warn: logger.warn would recurse via Configuration → validateConfiguration.
    console.warn(
      `${chalk.green(configurationLogPrefix())} ${chalk.yellow(
        `${moduleName}: deprecated configuration key '${sourceKey}' detected in '${filePath}'; ${guidance}`
      )}`
    )
  }
  if (isNotEmptyArray(remapErrors)) {
    throw new ConfigurationValidationError(remapErrors, {
      filePath,
      migratedFrom,
      phase: 'remap',
    })
  }

  const migrated =
    migratedFrom != null ? applyConfigurationMigration(version, swept, filePath) : swept

  const result = ConfigurationSchema.safeParse(migrated)
  if (!result.success) {
    throw ConfigurationValidationError.fromZodError(result.error, { filePath, migratedFrom })
  }

  return transformConfiguration(result.data, filePath)
}

/**
 * Post-validation transform: deep clone so callers may mutate the result.
 * @param validated - schema-validated configuration data
 * @param _filePath - configuration file path (unused)
 * @returns deep clone of the validated configuration
 */
const transformConfiguration = (
  validated: ConfigurationData,
  _filePath: string
): ConfigurationData => clone(validated)

type UIServerAccessPolicy = NonNullable<UIServerConfiguration['accessPolicy']>
type UIServerAccessPolicyListField = keyof typeof UI_SERVER_ACCESS_POLICY_ENVIRONMENT_VARIABLES

const parseEnvironmentList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')

/**
 * Apply the `UI_SERVER_*` environment variable overrides listed in
 * `UI_SERVER_ACCESS_POLICY_ENVIRONMENT_VARIABLES` to a UI server access policy.
 * Each variable is a comma-separated list (surrounding whitespace and empty
 * entries are ignored); when it holds at least one entry, it replaces the
 * corresponding configured list. Unset or empty variables leave the configured
 * value unchanged. The resulting policy is validated against the same schema as
 * the configuration file.
 * @param accessPolicy - Access policy resolved from defaults and the configuration file
 * @param environment - Environment variables to read (typically `process.env`)
 * @returns The access policy with overrides applied, or `accessPolicy` unchanged when no override is set
 * @throws {BaseError} When an override entry is invalid, naming the variable and the entry
 */
export const applyUIServerAccessPolicyEnvironmentOverrides = (
  accessPolicy: UIServerConfiguration['accessPolicy'],
  environment: NodeJS.ProcessEnv
): UIServerConfiguration['accessPolicy'] => {
  const overrides: Partial<Record<UIServerAccessPolicyListField, string[]>> = {}
  for (const [field, variableName] of Object.entries(
    UI_SERVER_ACCESS_POLICY_ENVIRONMENT_VARIABLES
  ) as [UIServerAccessPolicyListField, string][]) {
    const entries = parseEnvironmentList(environment[variableName])
    if (isNotEmptyArray(entries)) {
      overrides[field] = entries
    }
  }
  if (isEmpty(overrides)) {
    return accessPolicy
  }
  const overridden: UIServerAccessPolicy = { ...accessPolicy, ...overrides }
  const result = UIServerAccessPolicySchema.safeParse(overridden)
  if (!result.success) {
    const fieldErrors: FieldError[] = result.error.issues.map(issue => {
      const [field, index] = issue.path
      const entries = overrides[field as UIServerAccessPolicyListField]
      if (entries == null) {
        return {
          message: issue.message,
          path: ['uiServer', 'accessPolicy', ...issue.path].join('.'),
        }
      }
      const variableName =
        UI_SERVER_ACCESS_POLICY_ENVIRONMENT_VARIABLES[field as UIServerAccessPolicyListField]
      return {
        message: issue.message,
        path:
          typeof index === 'number'
            ? `${variableName}[${index.toString()}] '${entries[index]}'`
            : variableName,
      }
    })
    throw new BaseError(
      `${moduleName}: Invalid UI server access policy environment override:\n${formatFieldErrorsSummary(fieldErrors)}`
    )
  }
  return overridden
}
