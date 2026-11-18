import { isIP } from 'node:net'

import { convertToInt } from './Utils.js'

export const LOOPBACK_HOSTNAME = 'localhost'

export const isLoopback = (address: string): boolean => {
  if (address.trim().toLowerCase() === LOOPBACK_HOSTNAME) {
    return true
  }
  const normalizedAddress = normalizeIPAddress(address)
  if (normalizedAddress == null) {
    return false
  }
  if (normalizedAddress.family === 'ipv4') {
    return normalizedAddress.value.split('.')[0] === '127'
  }
  const groups = normalizedAddress.value.split(':')
  return groups.slice(0, -1).every(group => group === '0') && groups.at(-1) === '1'
}

/**
 * Parse an IP literal (IPv4, IPv6, or IPv4-mapped IPv6) into a normalized
 * `family:value` pair.
 * @param address The address to normalize.
 * @returns The normalized IP literal, or `undefined` when not a valid IP.
 */
export const normalizeIPAddress = (
  address: string
): undefined | { family: 'ipv4' | 'ipv6'; value: string } => {
  const host = normalizeHost(address)
  if (host == null) {
    return undefined
  }
  if (host === LOOPBACK_HOSTNAME) {
    return { family: 'ipv4', value: '127.0.0.1' }
  }
  const ipv4MappedAddress = parseIPv4MappedAddress(host)
  if (ipv4MappedAddress != null) {
    return { family: 'ipv4', value: ipv4MappedAddress }
  }
  if (isIP(host) === 4) {
    return { family: 'ipv4', value: host }
  }
  if (isIP(host) === 6) {
    const groups = expandIPv6(host)
    return groups != null ? { family: 'ipv6', value: groups.join(':') } : undefined
  }
  return undefined
}

/**
 * CIDR range parsed from an `address/prefix` literal.
 */
export interface CIDRRange {
  readonly address: string
  readonly family: 'ipv4' | 'ipv6'
  readonly prefix: number
}

const CIDR_PREFIX_PATTERN = /^(?:0|[1-9]\d{0,2})$/

/**
 * Parse a CIDR range literal (`address/prefix`) such as `192.0.2.0/24` or
 * `2001:db8::/32`. The address must be a bare IPv4 or IPv6 literal (no
 * brackets, no zone index) and the prefix a decimal integer within the
 * family bounds (0-32 for IPv4, 0-128 for IPv6). Host bits below the prefix
 * are ignored.
 * @param value The CIDR literal to parse.
 * @returns The parsed range, or `undefined` when `value` is not a valid CIDR literal.
 */
export const parseCIDR = (value: string): CIDRRange | undefined => {
  const separatorIndex = value.indexOf('/')
  if (separatorIndex === -1 || separatorIndex !== value.lastIndexOf('/')) {
    return undefined
  }
  const address = value.slice(0, separatorIndex)
  const prefixLiteral = value.slice(separatorIndex + 1)
  if (!CIDR_PREFIX_PATTERN.test(prefixLiteral)) {
    return undefined
  }
  const version = isIP(address)
  if (version === 0) {
    return undefined
  }
  const prefix = convertToInt(prefixLiteral)
  if (prefix > (version === 4 ? 32 : 128)) {
    return undefined
  }
  return { address, family: version === 4 ? 'ipv4' : 'ipv6', prefix }
}

/**
 * Whether `value` is a bare IPv4/IPv6 literal or a CIDR range literal.
 * @param value The value to check.
 * @returns `true` when `value` is an IP literal or a valid CIDR range.
 */
export const isIPAddressOrCIDR = (value: string): boolean =>
  isIP(value) !== 0 || parseCIDR(value) != null

/**
 * Strip a bracketed IPv6 wrapper and a trailing `:port` suffix, lowercase
 * the result, and drop a single trailing dot.
 * @param host The raw `Host` header or address value.
 * @returns The bare host, or `undefined` when the input is malformed.
 */
export const normalizeHost = (host: string): string | undefined => {
  const trimmedHost = host.trim().toLowerCase()
  if (trimmedHost === '') {
    return undefined
  }
  const bracketMatch = /^\[([^\]]+)](?::(\d+))?$/.exec(trimmedHost)
  if (bracketMatch != null) {
    return isValidPort(bracketMatch[2]) ? bracketMatch[1] : undefined
  }
  if (isIP(trimmedHost) === 6) {
    return trimmedHost
  }
  const parts = trimmedHost.split(':')
  if (parts.length > 2 || (parts.length === 2 && !isValidPort(parts[1]))) {
    return undefined
  }
  const hostPart = parts[0].replace(/\.$/, '')
  if (hostPart === '') {
    return undefined
  }
  return HOSTNAME_PATTERN.test(hostPart) ? hostPart : undefined
}

export const isHostLiteralWithoutPort = (value: string): boolean => {
  const normalized = normalizeHost(value)
  if (normalized == null) {
    return false
  }
  const stripped = value.trim().toLowerCase().replace(/\.$/, '')
  return stripped === normalized || stripped === `[${normalized}]`
}

const HOSTNAME_PATTERN = /^[a-z0-9._-]+$/

const isValidPort = (port: string | undefined): boolean => {
  if (port == null) {
    return true
  }
  if (!/^\d+$/.test(port)) {
    return false
  }
  const parsedPort = convertToInt(port)
  return parsedPort >= 1 && parsedPort <= 65535
}

const parseIPv4MappedAddress = (address: string): string | undefined => {
  const dottedMatch = /^::ffff:(.+)$/i.exec(address)
  if (dottedMatch != null && isIP(dottedMatch[1]) === 4) {
    return dottedMatch[1]
  }
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (hexMatch == null) {
    return undefined
  }
  // radix-16 required for IPv4-mapped IPv6 hex octet parsing; convertToInt does not accept a radix
  const high = Number.parseInt(hexMatch[1], 16)
  const low = Number.parseInt(hexMatch[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

const expandIPv6 = (address: string): string[] | undefined => {
  const sections = address.toLowerCase().split('::')
  if (sections.length > 2) {
    return undefined
  }
  const head = sections[0] === '' ? [] : sections[0].split(':')
  const tail = sections.length === 1 || sections[1] === '' ? [] : sections[1].split(':')
  const missingGroups = 8 - head.length - tail.length
  if ((sections.length === 1 && missingGroups !== 0) || missingGroups < 0) {
    return undefined
  }
  const groups = [...head, ...Array<string>(missingGroups).fill('0'), ...tail]
  if (groups.length !== 8) {
    return undefined
  }
  // radix-16 required for IPv6 hex group normalization; convertToInt does not accept a radix
  return groups.every(isIPv6Group)
    ? groups.map(group => Number.parseInt(group, 16).toString(16))
    : undefined
}

const isIPv6Group = (group: string): boolean => /^[0-9a-f]{1,4}$/i.test(group)
