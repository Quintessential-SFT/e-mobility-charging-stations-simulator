/**
 * @file Tests for HostUtils
 * @description Unit tests for IP literal normalization, loopback classification,
 *   CIDR range parsing, and host-parsing helpers.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  isIPAddressOrCIDR,
  isLoopback,
  normalizeHost,
  parseCIDR,
} from '../../src/utils/HostUtils.js'
import { standardCleanup } from '../helpers/TestLifecycleHelpers.js'

await describe('HostUtils', async () => {
  afterEach(() => {
    standardCleanup()
  })

  await describe('isLoopback', async () => {
    await it('should return true for localhost', () => {
      assert.strictEqual(isLoopback('localhost'), true)
    })

    await it('should return true for 127.0.0.1', () => {
      assert.strictEqual(isLoopback('127.0.0.1'), true)
    })

    await it('should return true for IPv4-mapped loopback addresses', () => {
      assert.strictEqual(isLoopback('::ffff:127.0.0.1'), true)
      assert.strictEqual(isLoopback('::ffff:7f00:1'), true)
    })

    await it('should return true for IPv6 loopback ::1', () => {
      assert.strictEqual(isLoopback('::1'), true)
    })

    await it('should return true for full IPv6 loopback', () => {
      assert.strictEqual(isLoopback('0000:0000:0000:0000:0000:0000:0000:0001'), true)
    })

    await it('should return false for external IPv4 address', () => {
      assert.strictEqual(isLoopback('192.168.1.1'), false)
    })

    await it('should return false for invalid addresses', () => {
      assert.strictEqual(isLoopback('127.999.999.999'), false)
      assert.strictEqual(isLoopback('1'), false)
    })

    await it('should return true for bracketed IPv6 loopback with port', () => {
      assert.strictEqual(isLoopback('[::1]:8080'), true)
    })

    await it('should return false for empty string', () => {
      assert.strictEqual(isLoopback(''), false)
    })
  })

  await describe('parseCIDR', async () => {
    await it('should parse an IPv4 range', () => {
      assert.deepStrictEqual(parseCIDR('192.0.2.0/24'), {
        address: '192.0.2.0',
        family: 'ipv4',
        prefix: 24,
      })
    })

    await it('should parse an IPv6 range', () => {
      assert.deepStrictEqual(parseCIDR('2001:db8::/32'), {
        address: '2001:db8::',
        family: 'ipv6',
        prefix: 32,
      })
    })

    await it('should accept family prefix bounds', () => {
      assert.strictEqual(parseCIDR('0.0.0.0/0')?.prefix, 0)
      assert.strictEqual(parseCIDR('192.0.2.10/32')?.prefix, 32)
      assert.strictEqual(parseCIDR('2001:db8::10/128')?.prefix, 128)
    })

    await it('should reject prefixes outside family bounds', () => {
      assert.strictEqual(parseCIDR('192.0.2.0/33'), undefined)
      assert.strictEqual(parseCIDR('2001:db8::/129'), undefined)
    })

    await it('should reject non-decimal or malformed prefixes', () => {
      for (const value of [
        '192.0.2.0/',
        '192.0.2.0/-1',
        '192.0.2.0/24.5',
        '192.0.2.0/ 24',
        '192.0.2.0/024',
        '192.0.2.0/0x18',
        '192.0.2.0/24/8',
      ]) {
        assert.strictEqual(parseCIDR(value), undefined, value)
      }
    })

    await it('should reject invalid or non-literal addresses', () => {
      for (const value of [
        '192.0.2.256/24',
        '192.0.2/24',
        'proxy.example.com/24',
        '[2001:db8::]/32',
        '/24',
        '192.0.2.10',
      ]) {
        assert.strictEqual(parseCIDR(value), undefined, value)
      }
    })
  })

  await describe('isIPAddressOrCIDR', async () => {
    await it('should accept IP literals and CIDR ranges', () => {
      for (const value of ['192.0.2.10', '2001:db8::10', '192.0.2.0/24', 'fd00::/8']) {
        assert.strictEqual(isIPAddressOrCIDR(value), true, value)
      }
    })

    await it('should reject hostnames, brackets, and invalid ranges', () => {
      for (const value of ['proxy.example.com', '[2001:db8::10]', '192.0.2.0/33', '']) {
        assert.strictEqual(isIPAddressOrCIDR(value), false, value)
      }
    })
  })

  await describe('normalizeHost', async () => {
    await it('should reject inputs with too many colons', () => {
      assert.strictEqual(normalizeHost('a:b:c'), undefined)
    })

    await it('should reject inputs with non-numeric port', () => {
      assert.strictEqual(normalizeHost('localhost:bad'), undefined)
    })

    await it('should reject bracketed inputs with non-numeric port', () => {
      assert.strictEqual(normalizeHost('[::1]:abc'), undefined)
    })

    await it('should reject inputs with port out of range', () => {
      assert.strictEqual(normalizeHost('[::1]:99999'), undefined)
    })

    await it('should reject inputs with port 0 (RFC 6335 reserved)', () => {
      assert.strictEqual(normalizeHost('localhost:0'), undefined)
      assert.strictEqual(normalizeHost('[::1]:0'), undefined)
    })

    await it('should reject inputs with characters outside hostname charset', () => {
      assert.strictEqual(normalizeHost('a.example.com, b.example.com'), undefined)
      assert.strictEqual(normalizeHost('foo bar'), undefined)
      assert.strictEqual(normalizeHost('[bad'), undefined)
    })

    await it('should reject empty input', () => {
      assert.strictEqual(normalizeHost(''), undefined)
      assert.strictEqual(normalizeHost('   '), undefined)
    })

    await it('should accept hostname with optional port', () => {
      assert.strictEqual(normalizeHost('gateway.example.com'), 'gateway.example.com')
      assert.strictEqual(normalizeHost('gateway.example.com:8080'), 'gateway.example.com')
    })

    await it('should accept IPv4 literal with optional port', () => {
      assert.strictEqual(normalizeHost('127.0.0.1'), '127.0.0.1')
      assert.strictEqual(normalizeHost('127.0.0.1:8080'), '127.0.0.1')
    })

    await it('should accept bracketed IPv6 literal with optional port', () => {
      assert.strictEqual(normalizeHost('[::1]'), '::1')
      assert.strictEqual(normalizeHost('[::1]:8080'), '::1')
    })

    await it('should drop a single trailing dot', () => {
      assert.strictEqual(normalizeHost('gateway.example.com.'), 'gateway.example.com')
      assert.strictEqual(normalizeHost('localhost.:80'), 'localhost')
    })

    await it('should lowercase the result', () => {
      assert.strictEqual(normalizeHost('Gateway.Example.COM'), 'gateway.example.com')
    })
  })
})
