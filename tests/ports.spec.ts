import { describe, expect, it } from 'vitest'
import { parseLinuxListeners, parseWindowsNetstat } from '../src/ports.ts'
import { listListeners } from '../src/ports.ts'

describe('listening service discovery', () => {
  it('reads Windows netstat rows, including IPv6 and localized whitespace', () => {
    const output = [
      '',
      '活动连接',
      '',
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       8268',
      '  TCP    [::]:135               [::]:0                 LISTENING       2252',
      '  TCP    127.0.0.1:19387        0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     4242',
      '  UDP    0.0.0.0:500            *:*                                    5678',
      '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    ].join('\r\n')
    expect(parseWindowsNetstat(output)).toEqual([
      { pid: 8268, port: 22, protocol: 'TCP', address: '0.0.0.0:22' },
      { pid: 2252, port: 135, protocol: 'TCP', address: '[::]:135' },
      { pid: 4242, port: 19387, protocol: 'TCP', address: '127.0.0.1:19387' },
      { pid: 4, port: 445, protocol: 'TCP', address: '0.0.0.0:445' },
    ])
  })

  it('reads ss rows and drops rows without an owning PID', () => {
    const output = [
      'LISTEN 0      511          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1234,fd=3))',
      'LISTEN 0      4096      127.0.0.1:19387     0.0.0.0:*    users:(("node",pid=4321,fd=21))',
      'LISTEN 0      128            [::]:8080         [::]:*',
      'ESTAB 0      0            10.0.0.1:22       10.0.0.2:51514 users:(("sshd",pid=1234,fd=4))',
    ].join('\n')
    expect(parseLinuxListeners(output)).toEqual([
      { pid: 1234, port: 22, protocol: 'TCP', address: '0.0.0.0:22' },
      { pid: 4321, port: 19387, protocol: 'TCP', address: '127.0.0.1:19387' },
    ])
  })

  it('reports the real listening sockets of this machine once per port and process', async () => {
    const listeners = await listListeners()
    expect(listeners.length).toBeGreaterThan(0)
    expect(listeners.every(listener => listener.pid > 0 && listener.port > 0)).toBe(true)
    expect(new Set(listeners.map(listener => `${listener.pid}:${listener.port}`)).size).toBe(listeners.length)
  }, 30_000)
})
